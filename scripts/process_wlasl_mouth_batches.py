#!/usr/bin/env python3
"""Process WLASL mouth landmarks in incremental batches and upload safely.

This script only adds or updates `mouthLandmarks` on top of existing sign JSON.
It preserves pose, leftHand, rightHand, frame timing, and all existing sign
motion data exactly as they already exist in `public/data/signs/<word>.json`.

The workflow is intentionally incremental:
1. Select the next batch of WLASL glosses.
2. Stage one temporary video per word.
3. Extract lip-boundary mouth landmarks only.
4. Merge `mouthLandmarks` into the existing sign JSON.
5. Upload the updated JSON to Firebase Storage/Firestore.
6. Delete only temporary video/cache files after successful upload.

It supports resume and dry-run so a long run can be safely continued later.
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
import urllib.request
from datetime import datetime
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

from build_manifest import normalize_word, safe_sign_filename
from sign_landmark_utils import download_with_ytdlp, require_service_account, resolve_bucket


BATCH_SIZE = 25
PROGRESS_FILE = "mouth_landmark_progress.json"
FAILURES_FILE = "mouth_landmark_failures.json"
QUALITY_REPORT_FILE = "mouth_landmark_quality_report.json"
TEMP_ROOT_DIR = "wlasl_mouth_temp"
VIDEO_EXTENSIONS = {".mp4", ".mkv", ".webm", ".mov", ".avi"}
MOUTH_LANDMARK_INDICES = [
    0, 13, 14, 17, 37, 39, 40, 61, 78, 80, 81, 82, 84, 87, 88, 91,
    95, 146, 178, 181, 185, 191, 267, 269, 270, 291, 308, 310, 311,
    312, 314, 317, 318, 321, 324, 375, 402, 405, 409, 415,
]


def log(message: str) -> None:
    print(message, flush=True)


def read_json(path: Path, default: Any = None) -> Any:
    if not path.exists():
        return default
    with path.open("r", encoding="utf-8") as handle:
        return json.load(handle)


def write_json(path: Path, data: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8") as handle:
        json.dump(data, handle, indent=2)
        handle.write("\n")


def utc_stamp() -> str:
    return datetime.utcnow().isoformat(timespec="seconds") + "Z"


def load_wlasl_metadata(path: Path) -> list[dict[str, Any]]:
    with path.open("r", encoding="utf-8") as handle:
        data = json.load(handle)
    if not isinstance(data, list):
        raise RuntimeError(f"Expected WLASL metadata list in {path}")
    return data


def sign_json_path(signs_dir: Path, word: str) -> Path:
    return signs_dir / f"{safe_sign_filename(word)}.json"


def start_kit_path(wlasl_path: Path) -> Path:
    return wlasl_path / "start_kit"


def extracted_video_dir(wlasl_path: Path) -> Path:
    return start_kit_path(wlasl_path) / "videos"


def temp_paths(temp_root: Path) -> tuple[Path, Path, Path]:
    raw_dir = temp_root / "raw"
    clip_dir = temp_root / "clips"
    json_dir = temp_root / "json"
    raw_dir.mkdir(parents=True, exist_ok=True)
    clip_dir.mkdir(parents=True, exist_ok=True)
    json_dir.mkdir(parents=True, exist_ok=True)
    return raw_dir, clip_dir, json_dir


def safe_delete_file(path: Path, allowed_roots: list[Path]) -> bool:
    if not path.exists():
        return False
    resolved = path.resolve()
    resolved_roots = [root.resolve() for root in allowed_roots]
    if not any(root == resolved or root in resolved.parents for root in resolved_roots):
        return False
    path.unlink()
    return True


def validate_video(path: Path) -> bool:
    if not path.exists() or path.stat().st_size < 1024:
        return False
    try:
        import cv2

        cap = cv2.VideoCapture(str(path))
        opened = cap.isOpened()
        frame_count = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
        cap.release()
        return opened and frame_count > 0
    except Exception:
        return False


def convert_clip_to_mp4(src: Path, dst: Path, start_frame: int, end_frame: int, fallback_fps: float = 25.0) -> bool:
    try:
        import cv2

        cap = cv2.VideoCapture(str(src))
        if not cap.isOpened():
            return False

        fps = cap.get(cv2.CAP_PROP_FPS) or fallback_fps
        first = max(0, start_frame - 1)
        last = end_frame - 1 if end_frame and end_frame > 0 else None
        frames = []
        index = 0

        while True:
            ok, frame = cap.read()
            if not ok:
                break
            if index >= first and (last is None or index <= last):
                frames.append(frame)
            if last is not None and index > last:
                break
            index += 1

        cap.release()
        if not frames:
            return False

        dst.parent.mkdir(parents=True, exist_ok=True)
        tmp = dst.with_suffix(".tmp.mp4")
        height, width = frames[0].shape[:2]
        writer = cv2.VideoWriter(str(tmp), cv2.VideoWriter_fourcc(*"mp4v"), fps, (width, height))
        for frame in frames:
            writer.write(frame)
        writer.release()

        if not validate_video(tmp):
            safe_delete_file(tmp, [dst.parent])
            return False
        tmp.replace(dst)
        return True
    except Exception:
        safe_delete_file(dst.with_suffix(".tmp.mp4"), [dst.parent])
        return False


def is_youtube(url: str) -> bool:
    return "youtube" in url or "youtu.be" in url


def direct_download(url: str, output_path: Path, timeout: int = 120) -> Path | None:
    output_path.parent.mkdir(parents=True, exist_ok=True)
    tmp_path = output_path.with_suffix(output_path.suffix + ".download")
    request = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            with tmp_path.open("wb") as handle:
                shutil.copyfileobj(response, handle)
        tmp_path.replace(output_path)
        return output_path if validate_video(output_path) else None
    except Exception:
        safe_delete_file(tmp_path, [output_path.parent])
        safe_delete_file(output_path, [output_path.parent])
        return None


def stage_temp_video(
    wlasl_path: Path,
    raw_dir: Path,
    clip_dir: Path,
    instance: dict[str, Any],
) -> tuple[Path | None, list[Path], str | None]:
    video_id = str(instance.get("video_id") or "").strip()
    url = str(instance.get("url") or "").strip()
    if not video_id or not url:
        return None, [], "missing video_id or url"

    cleanup_candidates: list[Path] = []
    temp_clip = clip_dir / f"{video_id}.mp4"
    local_clip = extracted_video_dir(wlasl_path) / f"{video_id}.mp4"

    if validate_video(local_clip):
        shutil.copy2(local_clip, temp_clip)
        cleanup_candidates.append(temp_clip)
        return temp_clip, cleanup_candidates, None

    parsed_suffix = Path(urlparse(url).path).suffix.lower()
    raw_suffix = parsed_suffix if parsed_suffix in VIDEO_EXTENSIONS else ".mp4"
    temp_raw = raw_dir / f"{video_id}{raw_suffix}"

    try:
        if is_youtube(url):
            download_with_ytdlp(url, temp_raw)
        else:
            downloaded = direct_download(url, temp_raw)
            if not downloaded:
                return None, cleanup_candidates, "download failed or produced an invalid video"
    except subprocess.TimeoutExpired as exc:
        return None, cleanup_candidates, f"download timed out after {exc.timeout} seconds"
    except subprocess.CalledProcessError as exc:
        return None, cleanup_candidates, exc.stderr.strip() or exc.stdout.strip() or "yt-dlp failed"
    except Exception as exc:
        return None, cleanup_candidates, str(exc)

    if not validate_video(temp_raw):
        safe_delete_file(temp_raw, [raw_dir])
        return None, cleanup_candidates, "download produced an invalid video"

    cleanup_candidates.append(temp_raw)

    start_frame = int(instance.get("frame_start") or 1)
    end_frame = int(instance.get("frame_end") or -1)
    clip_ok = convert_clip_to_mp4(temp_raw, temp_clip, start_frame, end_frame, float(instance.get("fps") or 25))
    if not clip_ok or not validate_video(temp_clip):
        safe_delete_file(temp_clip, [clip_dir])
        return None, cleanup_candidates, "could not extract a valid mp4 clip"

    cleanup_candidates.append(temp_clip)
    return temp_clip, cleanup_candidates, None


def extract_mouth_only(video_path: Path, word: str, fps: int) -> dict[str, Any] | None:
    from extract_landmarks import extract_landmarks_from_video

    extracted = extract_landmarks_from_video(str(video_path), word=word, target_fps=fps)
    if not extracted:
        return None
    return extracted


def resample_sequence(sequence: list[Any], target_count: int) -> list[Any]:
    if target_count <= 0:
        return []
    if not sequence:
        return [None] * target_count
    if len(sequence) == target_count:
        return sequence
    if target_count == 1:
        return [sequence[0]]

    result = []
    last_index = max(0, len(sequence) - 1)
    for index in range(target_count):
        source_index = round((index / (target_count - 1)) * last_index)
        result.append(sequence[source_index])
    return result


def merge_mouth_into_existing(existing_data: dict[str, Any], extracted_data: dict[str, Any]) -> dict[str, Any]:
    merged = json.loads(json.dumps(existing_data))
    frames = merged.get("frames")
    if not isinstance(frames, list) or not frames:
        raise ValueError("existing JSON has no frames")

    mouth_frames = [frame.get("mouthLandmarks") for frame in extracted_data.get("frames", []) if isinstance(frame, dict)]
    aligned_mouth = resample_sequence(mouth_frames, len(frames))

    for frame, mouth in zip(frames, aligned_mouth):
        if not isinstance(frame, dict):
            raise ValueError("frame is not an object")
        frame.pop("mouth", None)
        frame.pop("mouth_landmarks", None)
        frame.pop("face", None)
        frame.pop("faceLandmarks", None)
        frame.pop("face_landmarks", None)
        frame["mouthLandmarks"] = mouth

    merged["hasMouth"] = any(frame.get("mouthLandmarks") for frame in frames if isinstance(frame, dict))
    merged["mouthLandmarkIndices"] = MOUTH_LANDMARK_INDICES
    for field in ("mouthFramesDetected", "mouthFramesInterpolated", "mouthFramesMissing", "mouthMovementScore"):
        merged[field] = extracted_data.get(field, 0)
    merged.setdefault("metadata", {})
    if isinstance(merged["metadata"], dict):
        for field in ("mouthFramesDetected", "mouthFramesInterpolated", "mouthFramesMissing", "mouthMovementScore"):
            merged["metadata"][field] = extracted_data.get(field, 0)
    return merged


def count_mouth_frames(sign_data: dict[str, Any]) -> int:
    frames = sign_data.get("frames") or []
    return sum(1 for frame in frames if isinstance(frame, dict) and frame.get("mouthLandmarks"))


def verify_local_sign_has_mouth(path: Path) -> tuple[bool, int]:
    data = read_json(path, {})
    mouth_frames = count_mouth_frames(data)
    return mouth_frames > 0, mouth_frames


def find_quality_report_mismatches(signs_dir: Path, quality_report: dict[str, Any]) -> list[str]:
    mismatches: list[str] = []
    for word, item in sorted(quality_report.items()):
        if not isinstance(item, dict) or not item.get("hasMouthLandmarks"):
            continue
        local_path = sign_json_path(signs_dir, word)
        local_ok, _ = verify_local_sign_has_mouth(local_path)
        if not local_ok:
            mismatches.append(word)
    return mismatches


def validate_sign_json(sign_data: dict[str, Any]) -> list[str]:
    errors = []
    frames = sign_data.get("frames")
    if not isinstance(frames, list) or not frames:
        return ["missing frames"]

    for field in ("word", "fps"):
        if field not in sign_data:
            errors.append(f"missing {field}")

    for index, frame in enumerate(frames):
        if not isinstance(frame, dict):
            errors.append(f"frame {index} is not an object")
            continue
        for field in ("pose", "leftHand", "rightHand"):
            if field not in frame:
                errors.append(f"frame {index} missing {field}")
        mouth = frame.get("mouthLandmarks")
        if mouth is not None and (not isinstance(mouth, list) or len(mouth) < 12):
            errors.append(f"frame {index} has invalid mouthLandmarks")
    return errors[:10]


def init_firebase_upload(service_account: Path, bucket_name: str):
    from upload_signs_to_firebase import init_firebase, safe_doc_id
    import upload_signs_to_firebase as upload_module

    init_firebase(service_account, bucket_name)
    return upload_module.storage.bucket(), upload_module.firestore.client(), safe_doc_id


def upload_one(
    json_file: Path,
    sign_data: dict[str, Any],
    bucket_obj: Any,
    db: Any,
    safe_doc_id_fn: Any,
    collection: str,
    dry_run: bool,
) -> str:
    gloss = normalize_word(sign_data.get("word") or json_file.stem.replace("_", " "))
    storage_path = f"signs/{json_file.name}"
    if dry_run:
        return storage_path

    blob = bucket_obj.blob(storage_path)
    blob.upload_from_filename(str(json_file), content_type="application/json")
    doc = {
        "gloss": gloss,
        "type": "word",
        "jsonPath": storage_path,
        "available": True,
        "source": "WLASL",
        "fps": sign_data.get("fps", 30),
        "frameCount": len(sign_data.get("frames", [])),
        "aliases": [],
        "category": "WLASL",
    }
    db.collection(collection).document(safe_doc_id_fn(gloss)).set(doc, merge=True)
    return storage_path


def select_candidates(
    metadata: list[dict[str, Any]],
    progress: dict[str, Any],
    start_index: int,
    batch_size: int,
    resume: bool,
    force: bool,
) -> list[tuple[int, str, dict[str, Any]]]:
    attempted = set(progress.get("attemptedWords", [])) if resume else set()
    completed = set(progress.get("processedWords", [])) if resume else set()
    candidates: list[tuple[int, str, dict[str, Any]]] = []

    sorted_metadata = sorted(metadata, key=lambda item: normalize_word(item.get("gloss", "")))
    for global_index, item in enumerate(sorted_metadata, start=1):
        if global_index < start_index:
            continue
        word = normalize_word(item.get("gloss", ""))
        if not word:
            continue
        if not force and (word in attempted or word in completed):
            continue
        candidates.append((global_index, word, item))
        if len(candidates) >= batch_size:
            break

    return candidates


def update_quality_report(
    report: dict[str, Any],
    word: str,
    merged_data: dict[str, Any] | None,
    video_path: Path | None,
    rendering_mode: str,
    status: str,
) -> None:
    metadata = merged_data.get("metadata", {}) if merged_data and isinstance(merged_data.get("metadata"), dict) else {}
    report[word] = {
        "word": word,
        "status": status,
        "hasMouthLandmarks": bool(merged_data and merged_data.get("hasMouth")),
        "mouthFramesDetected": (merged_data or {}).get("mouthFramesDetected", metadata.get("mouthFramesDetected", 0)),
        "mouthFramesInterpolated": (merged_data or {}).get("mouthFramesInterpolated", metadata.get("mouthFramesInterpolated", 0)),
        "mouthFramesMissing": (merged_data or {}).get("mouthFramesMissing", metadata.get("mouthFramesMissing", 0)),
        "mouthMovementScore": (merged_data or {}).get("mouthMovementScore", metadata.get("mouthMovementScore", 0)),
        "renderingMode": rendering_mode,
        "videoPath": str(video_path) if video_path else None,
        "updatedAt": utc_stamp(),
    }


def main() -> None:
    project_root = Path(__file__).resolve().parents[1]
    parser = argparse.ArgumentParser(description="Process WLASL mouth landmarks in safe upload batches.")
    parser.add_argument("--batch-size", type=int, default=BATCH_SIZE)
    parser.add_argument("--resume", action="store_true")
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--max-words", type=int, default=0, help="Optional cap on how many words to attempt this run.")
    parser.add_argument("--start-index", type=int, default=1)
    parser.add_argument("--force", action="store_true")
    parser.add_argument("--repair-report-mismatches", action="store_true", help="Process only words where the quality report says hasMouthLandmarks=true but the local JSON still has none.")
    parser.add_argument("--fps", type=int, default=30)
    parser.add_argument("--words", nargs="*", default=[], help="Optional explicit words for small tests.")
    parser.add_argument("--wlasl-path", type=Path, default=project_root / "WLASL")
    parser.add_argument("--metadata", type=Path, default=project_root / "WLASL" / "start_kit" / "WLASL_v0.3.json")
    parser.add_argument("--signs-dir", type=Path, default=project_root / "public" / "data" / "signs")
    parser.add_argument("--progress", type=Path, default=project_root / "data" / PROGRESS_FILE)
    parser.add_argument("--failures", type=Path, default=project_root / "data" / FAILURES_FILE)
    parser.add_argument("--quality-report", type=Path, default=project_root / "data" / QUALITY_REPORT_FILE)
    parser.add_argument("--temp-root", type=Path, default=project_root / "data" / TEMP_ROOT_DIR)
    parser.add_argument("--service-account", type=Path, default=Path(os.environ.get("GOOGLE_APPLICATION_CREDENTIALS") or project_root / "firebase-service-account.json"))
    parser.add_argument("--bucket", default=os.environ.get("FIREBASE_STORAGE_BUCKET"))
    parser.add_argument("--collection", default="signs")
    args = parser.parse_args()

    if args.batch_size <= 0:
        raise SystemExit("--batch-size must be greater than 0")
    if args.start_index <= 0:
        raise SystemExit("--start-index must be greater than 0")
    if args.max_words < 0:
        raise SystemExit("--max-words must be 0 or greater")

    progress = read_json(args.progress, {
        "batchSize": args.batch_size,
        "attemptedWords": [],
        "processedWords": [],
        "counts": {"processed": 0, "skipped": 0, "failed": 0, "uploaded": 0},
        "lastGlobalIndex": 0,
        "updatedStoragePaths": [],
        "deletedTempFiles": [],
        "deletedTempVideos": [],
    })
    failures = read_json(args.failures, {})
    quality_report = read_json(args.quality_report, {})
    metadata = load_wlasl_metadata(args.metadata.resolve())
    if args.repair_report_mismatches:
        mismatch_words = set(find_quality_report_mismatches(args.signs_dir.resolve(), quality_report))
        metadata = [item for item in metadata if normalize_word(item.get("gloss", "")) in mismatch_words]
        log(f"Mismatch repair mode: {len(metadata)} words selected from quality report")
    elif args.words:
        requested = {normalize_word(word) for word in args.words if normalize_word(word)}
        metadata = [item for item in metadata if normalize_word(item.get("gloss", "")) in requested]

    log("=" * 72)
    log("WLASL Mouth Batch Processor")
    log("=" * 72)
    log(f"Batch size: {args.batch_size}")
    log(f"Resume: {args.resume}")
    log(f"Dry run: {args.dry_run}")
    log(f"Max words this run: {args.max_words or 'all remaining'}")
    log(f"Signs dir: {args.signs_dir.resolve()}")
    log(f"Temp root: {args.temp_root.resolve()}")
    log("=" * 72)

    attempted_this_run = 0
    batch_number = 0
    attempted_words = set(progress.setdefault("attemptedWords", []))
    processed_words = set(progress.setdefault("processedWords", []))
    counts = progress.setdefault("counts", {"processed": 0, "skipped": 0, "failed": 0, "uploaded": 0})
    updated_paths = progress.setdefault("updatedStoragePaths", [])
    deleted_temp_files = progress.setdefault("deletedTempFiles", [])
    deleted_temp_videos = progress.setdefault("deletedTempVideos", [])

    bucket_obj = db = safe_doc_id_fn = None
    if not args.dry_run:
        service_account = require_service_account(args.service_account)
        bucket_name = resolve_bucket(args.bucket, service_account)
        bucket_obj, db, safe_doc_id_fn = init_firebase_upload(service_account, bucket_name)

    current_start_index = args.start_index
    while True:
        remaining_limit = 0
        if args.max_words:
            remaining_limit = args.max_words - attempted_this_run
            if remaining_limit <= 0:
                log("Reached --max-words limit for this run.")
                break

        batch_size = min(args.batch_size, remaining_limit) if remaining_limit else args.batch_size
        candidates = select_candidates(
            metadata=metadata,
            progress=progress,
            start_index=current_start_index,
            batch_size=batch_size,
            resume=args.resume,
            force=args.force,
        )
        if not candidates:
            log("No more eligible WLASL words remain for this run.")
            break
        current_start_index = candidates[-1][0] + 1

        batch_number += 1
        progress["currentBatchNumber"] = batch_number
        progress["updatedAt"] = utc_stamp()
        write_json(args.progress, progress)

        log(f"Batch {batch_number}: {len(candidates)} words")
        for batch_index, (global_index, word, item) in enumerate(candidates, start=1):
            attempted_this_run += 1
            log(f"[batch {batch_number} | {batch_index}/{len(candidates)}] word: {word}")

            existing_json = sign_json_path(args.signs_dir.resolve(), word)
            if not existing_json.exists():
                counts["skipped"] = counts.get("skipped", 0) + 1
                attempted_words.add(word)
                failures[word] = {
                    "status": "missing_existing_sign_json",
                    "globalIndex": global_index,
                    "updatedAt": utc_stamp(),
                }
                update_quality_report(quality_report, word, None, None, "fallback_closed", "missing_existing_sign_json")
                progress["attemptedWords"] = sorted(attempted_words)
                progress["lastGlobalIndex"] = global_index
                progress["lastWord"] = word
                write_json(args.progress, progress)
                write_json(args.failures, failures)
                write_json(args.quality_report, quality_report)
                log("  skip: missing existing sign JSON")
                continue

            if args.dry_run:
                log("  dry-run: would download/process/upload/delete temp files")
                continue

            raw_dir, clip_dir, json_dir = temp_paths(args.temp_root.resolve())
            temp_cleanup_candidates: list[Path] = []
            temp_json = json_dir / existing_json.name
            merged_data: dict[str, Any] | None = None
            used_video_path: Path | None = None
            extracted_data: dict[str, Any] | None = None
            failure_reason: str | None = None
            video_failures: list[dict[str, Any]] = []

            try:
                existing_data = read_json(existing_json, {})
                instances = item.get("instances") or []
                if not instances:
                    raise RuntimeError("no WLASL instances available")

                for instance in instances:
                    video_id = str(instance.get("video_id") or "").strip()
                    log(f"  download started: {video_id or 'unknown'}")
                    staged_video, cleanup_candidates, stage_error = stage_temp_video(args.wlasl_path.resolve(), raw_dir, clip_dir, instance)
                    if stage_error or not staged_video:
                        video_failures.append({
                            "videoId": video_id,
                            "status": "failed_download",
                            "error": stage_error or "unknown download failure",
                        })
                        log(f"  download failed: {stage_error or 'unknown download failure'}")
                        continue

                    temp_cleanup_candidates.extend([path for path in cleanup_candidates if path not in temp_cleanup_candidates])
                    used_video_path = staged_video
                    log(f"  download completed: {staged_video.name}")
                    log("  extraction started")
                    extracted_data = extract_mouth_only(staged_video, word, args.fps)
                    if not extracted_data:
                        video_failures.append({
                            "videoId": video_id,
                            "status": "failed_extraction",
                            "error": "mouth extraction returned no data",
                        })
                        log("  extraction failed: mouth extraction returned no data")
                        used_video_path = None
                        continue

                    mouth_detected = int(extracted_data.get("mouthFramesDetected", 0))
                    log(f"  extraction completed: mouth frames detected = {mouth_detected}")
                    if mouth_detected <= 0:
                        video_failures.append({
                            "videoId": video_id,
                            "status": "low_quality/no_mouth_detected",
                            "error": "no mouth detected",
                        })
                        log("  low quality: no mouth detected")
                        used_video_path = None
                        continue

                    merged_data = merge_mouth_into_existing(existing_data, extracted_data)
                    break

                if not merged_data or not extracted_data:
                    raise RuntimeError("low_quality/no_mouth_detected")

                validation_errors = validate_sign_json(merged_data)
                if validation_errors:
                    raise RuntimeError("validation failed: " + "; ".join(validation_errors))

                write_json(existing_json, merged_data)
                local_ok, local_mouth_frames = verify_local_sign_has_mouth(existing_json)
                if not local_ok:
                    raise RuntimeError("local JSON save verification failed: mouthLandmarks missing after write")

                log(f"  local save verified: mouth frames = {local_mouth_frames}")
                write_json(temp_json, merged_data)
                log("  firebase upload started")
                storage_path = upload_one(
                    json_file=temp_json,
                    sign_data=merged_data,
                    bucket_obj=bucket_obj,
                    db=db,
                    safe_doc_id_fn=safe_doc_id_fn,
                    collection=args.collection,
                    dry_run=False,
                )
                log(f"  firebase upload completed: {storage_path}")

                local_ok, local_mouth_frames = verify_local_sign_has_mouth(existing_json)
                if not local_ok:
                    raise RuntimeError("post-upload verification failed: local JSON mouthLandmarks missing")

                counts["processed"] = counts.get("processed", 0) + 1
                counts["uploaded"] = counts.get("uploaded", 0) + 1
                attempted_words.add(word)
                processed_words.add(word)
                updated_paths.append(storage_path)
                progress["attemptedWords"] = sorted(attempted_words)
                progress["processedWords"] = sorted(processed_words)
                progress["lastGlobalIndex"] = global_index
                progress["lastWord"] = word
                progress["lastFirebaseUploadPath"] = storage_path
                progress["updatedAt"] = utc_stamp()

                temp_cleanup_candidates.append(temp_json)
                for path in temp_cleanup_candidates:
                    if safe_delete_file(path, [args.temp_root.resolve()]):
                        if path.suffix.lower() == ".json":
                            deleted_temp_files.append(str(path))
                        else:
                            deleted_temp_videos.append(str(path))
                        label = "temp video deleted" if path.suffix.lower() != ".json" else "temp json deleted"
                        log(f"  {label}: {path.name}")

                failures.pop(word, None)
                merged_data["hasMouth"] = local_mouth_frames > 0
                update_quality_report(quality_report, word, merged_data, used_video_path, "video_mouth", "processed")
                write_json(args.progress, progress)
                write_json(args.failures, failures)
                write_json(args.quality_report, quality_report)
            except Exception as exc:
                failure_reason = str(exc)
                counts["failed"] = counts.get("failed", 0) + 1
                attempted_words.add(word)
                progress["attemptedWords"] = sorted(attempted_words)
                progress["lastGlobalIndex"] = global_index
                progress["lastWord"] = word
                progress["updatedAt"] = utc_stamp()
                failures[word] = {
                    "status": failure_reason,
                    "globalIndex": global_index,
                    "videoFailures": video_failures,
                    "tempFilesKept": [str(path) for path in temp_cleanup_candidates if path.exists()],
                    "updatedAt": utc_stamp(),
                }
                status = "low_quality/no_mouth_detected" if "no_mouth" in failure_reason or "low_quality" in failure_reason else "failed"
                update_quality_report(quality_report, word, merged_data, used_video_path, "fallback_closed", status)
                write_json(args.progress, progress)
                write_json(args.failures, failures)
                write_json(args.quality_report, quality_report)
                log(f"  failure: {failure_reason}")

    log("=" * 72)
    log("Run complete")
    log(json.dumps(counts, indent=2))
    log(f"Progress: {args.progress}")
    log(f"Failures: {args.failures}")
    log(f"Quality report: {args.quality_report}")
    log("=" * 72)


if __name__ == "__main__":
    main()
