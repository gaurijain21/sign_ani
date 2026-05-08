#!/usr/bin/env python3
"""Batch-add mouth landmarks to sign JSONs and upload them safely to Firebase.

This script preserves the existing pose/leftHand/rightHand fields from the
current sign JSON and merges only mouthLandmarks extracted from the source
video. It writes temporary JSON files, uploads one validated sign at a time,
and deletes only the temporary file after a confirmed upload.
"""

import argparse
import json
import os
import sys
from datetime import datetime
from pathlib import Path
from typing import Any

from build_manifest import build_manifest, normalize_word, safe_sign_filename
from sign_landmark_utils import require_service_account, resolve_bucket


BATCH_SIZE = 500
PROGRESS_FILE = "mouth_landmark_progress.json"
FAILURES_FILE = "mouth_landmark_failures.json"
QUALITY_REPORT_FILE = "mouth_landmark_quality_report.json"
TEMP_DIR = "mouth_landmark_processed"


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


def sign_json_path(signs_dir: Path, word: str) -> Path:
    return signs_dir / f"{safe_sign_filename(word)}.json"


def resolve_video_paths(wlasl_path: Path, entry: dict[str, Any]) -> list[Path]:
    paths = []
    for raw_path in entry.get("videoPaths") or ([entry.get("videoPath")] if entry.get("videoPath") else []):
        path = Path(raw_path)
        if not path.is_absolute():
            path = wlasl_path / path
        paths.append(path.resolve())
    return paths


def has_existing_mouth(sign_data: dict[str, Any]) -> bool:
    frames = sign_data.get("frames") or []
    return any(frame.get("mouthLandmarks") for frame in frames if isinstance(frame, dict))


def mouth_is_complete(sign_data: dict[str, Any]) -> bool:
    frames = sign_data.get("frames") or []
    if not frames:
        return False
    mouth_frames = [frame.get("mouthLandmarks") for frame in frames if isinstance(frame, dict)]
    return bool(mouth_frames) and all(isinstance(mouth, list) and len(mouth) >= 12 for mouth in mouth_frames)


def select_batch(
    entries: dict[str, Any],
    signs_dir: Path,
    wlasl_path: Path,
    progress: dict[str, Any],
    batch_size: int,
    start_index: int,
    resume: bool,
    force: bool,
) -> list[tuple[int, str, dict[str, Any], Path]]:
    processed_words = set(progress.get("processedWords", [])) if resume else set()
    candidates = []

    for global_index, (word, entry) in enumerate(sorted(entries.items()), start=1):
        if global_index < start_index:
            continue
        normalized = normalize_word(word)
        if normalized in processed_words and not force:
            continue

        existing_json = sign_json_path(signs_dir, normalized)
        if not existing_json.exists():
            continue

        existing_data = read_json(existing_json, {})
        if not force and mouth_is_complete(existing_data):
            continue

        video_paths = [path for path in resolve_video_paths(wlasl_path, entry) if path.exists()]
        if not video_paths:
            continue

        candidates.append((global_index, normalized, entry, existing_json))
        if len(candidates) >= batch_size:
            break

    return candidates


def extract_mouth_only(video_paths: list[Path], word: str, fps: int) -> tuple[dict[str, Any] | None, Path | None, list[dict[str, str]]]:
    try:
        from extract_landmarks import extract_landmarks_from_video
    except Exception as exc:
        raise RuntimeError("Could not import scripts/extract_landmarks.py") from exc

    failures = []
    for video_path in video_paths:
        try:
            extracted = extract_landmarks_from_video(str(video_path), word=word, target_fps=fps)
        except Exception as exc:
            failures.append({"video": str(video_path), "error": str(exc)})
            continue

        frames = extracted.get("frames", []) if extracted else []
        mouth_frames = [frame.get("mouthLandmarks") for frame in frames if isinstance(frame, dict)]
        if mouth_frames and any(mouth for mouth in mouth_frames):
            return extracted, video_path, failures
        failures.append({"video": str(video_path), "error": "no mouth landmarks extracted"})

    return None, None, failures


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
        # Preserve pose/leftHand/rightHand exactly. Only replace the mouth layer.
        frame.pop("mouth", None)
        frame.pop("mouth_landmarks", None)
        frame.pop("face", None)
        frame.pop("faceLandmarks", None)
        frame.pop("face_landmarks", None)
        frame["mouthLandmarks"] = mouth

    merged["hasMouth"] = any(frame.get("mouthLandmarks") for frame in frames if isinstance(frame, dict))
    merged["mouthLandmarkIndices"] = [
        0, 13, 14, 17, 37, 39, 40, 61, 78, 80, 81, 82, 84, 87, 88, 91,
        95, 146, 178, 181, 185, 191, 267, 269, 270, 291, 308, 310, 311,
        312, 314, 317, 318, 321, 324, 375, 402, 405, 409, 415,
    ]
    for field in ("mouthFramesDetected", "mouthFramesInterpolated", "mouthFramesMissing", "mouthMovementScore"):
        merged[field] = extracted_data.get(field, 0)
    merged.setdefault("metadata", {})
    if isinstance(merged["metadata"], dict):
        for field in ("mouthFramesDetected", "mouthFramesInterpolated", "mouthFramesMissing", "mouthMovementScore"):
            merged["metadata"][field] = extracted_data.get(field, 0)
    return merged


def update_quality_report(
    report: dict[str, Any],
    word: str,
    merged_data: dict[str, Any],
    video_path: Path | None,
    rendering_mode: str,
) -> None:
    metadata = merged_data.get("metadata", {}) if isinstance(merged_data.get("metadata"), dict) else {}
    report[word] = {
        "word": word,
        "hasMouthLandmarks": bool(merged_data.get("hasMouth")),
        "mouthFramesDetected": merged_data.get("mouthFramesDetected", metadata.get("mouthFramesDetected", 0)),
        "mouthFramesInterpolated": merged_data.get("mouthFramesInterpolated", metadata.get("mouthFramesInterpolated", 0)),
        "mouthFramesMissing": merged_data.get("mouthFramesMissing", metadata.get("mouthFramesMissing", 0)),
        "mouthMovementScore": merged_data.get("mouthMovementScore", metadata.get("mouthMovementScore", 0)),
        "renderingMode": rendering_mode,
        "videoPath": str(video_path) if video_path else None,
        "updatedAt": utc_stamp(),
    }


def validate_sign_json(sign_data: dict[str, Any]) -> list[str]:
    errors = []
    frames = sign_data.get("frames")
    if not isinstance(frames, list) or not frames:
        errors.append("missing frames")
        return errors

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
    try:
        from upload_signs_to_firebase import init_firebase, safe_doc_id
        import upload_signs_to_firebase as upload_module
    except ImportError as exc:
        raise RuntimeError("Could not import Firebase upload helpers") from exc

    init_firebase(service_account, bucket_name)
    return upload_module.storage.bucket(), upload_module.firestore.client(), safe_doc_id


def upload_one(
    json_file: Path,
    sign_data: dict[str, Any],
    manifest: dict[str, Any],
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

    manifest_entry = manifest.get("entries", {}).get(gloss, {})
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
        "instanceCount": manifest_entry.get("instanceCount", 0),
    }
    db.collection(collection).document(safe_doc_id_fn(gloss)).set(doc, merge=True)
    return storage_path


def main() -> None:
    project_root = Path(__file__).resolve().parents[1]
    parser = argparse.ArgumentParser(description="Batch add/upload mouth landmarks for sign JSONs.")
    parser.add_argument("--batch-size", type=int, default=BATCH_SIZE)
    parser.add_argument("--resume", action="store_true")
    parser.add_argument("--start-index", type=int, default=1)
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--force", action="store_true", help="Reprocess signs even if mouthLandmarks already exist.")
    parser.add_argument("--fps", type=int, default=30)
    parser.add_argument("--wlasl-path", type=Path, default=project_root / "WLASL")
    parser.add_argument("--manifest", type=Path, default=project_root / "data" / "signManifest.json")
    parser.add_argument("--signs-dir", type=Path, default=project_root / "public" / "data" / "signs")
    parser.add_argument("--progress", type=Path, default=project_root / "data" / PROGRESS_FILE)
    parser.add_argument("--failures", type=Path, default=project_root / "data" / FAILURES_FILE)
    parser.add_argument("--quality-report", type=Path, default=project_root / "data" / QUALITY_REPORT_FILE)
    parser.add_argument("--temp-dir", type=Path, default=project_root / "data" / TEMP_DIR)
    parser.add_argument("--service-account", type=Path, default=Path(os.environ.get("GOOGLE_APPLICATION_CREDENTIALS") or project_root / "firebase-service-account.json"))
    parser.add_argument("--bucket", default=os.environ.get("FIREBASE_STORAGE_BUCKET"))
    parser.add_argument("--collection", default="signs")
    args = parser.parse_args()

    if args.batch_size <= 0:
        raise SystemExit("--batch-size must be greater than 0")
    if args.start_index <= 0:
        raise SystemExit("--start-index must be greater than 0")

    wlasl_path = args.wlasl_path.resolve()
    signs_dir = args.signs_dir.resolve()
    manifest_path = args.manifest.resolve()
    temp_dir = args.temp_dir.resolve()
    temp_dir.mkdir(parents=True, exist_ok=True)

    manifest = build_manifest(wlasl_path=wlasl_path, signs_path=signs_dir, output_path=manifest_path)
    progress = read_json(args.progress, {
        "batchSize": args.batch_size,
        "processedWords": [],
        "counts": {"processed": 0, "skipped": 0, "failed": 0, "uploaded": 0},
        "lastGlobalIndex": 0,
        "updatedStoragePaths": [],
        "removedTempFiles": [],
    })
    failures = read_json(args.failures, {})
    quality_report = read_json(args.quality_report, {})

    candidates = select_batch(
        entries=manifest.get("entries", {}),
        signs_dir=signs_dir,
        wlasl_path=wlasl_path,
        progress=progress,
        batch_size=args.batch_size,
        start_index=args.start_index,
        resume=args.resume,
        force=args.force,
    )

    print("=" * 72)
    print("Mouth Landmark Batch Processor")
    print("=" * 72)
    print(f"Batch size: {args.batch_size}")
    print(f"Current batch candidates: {len(candidates)}")
    print(f"Resume: {args.resume}")
    print(f"Dry run: {args.dry_run}")
    print(f"Signs dir: {signs_dir}")
    print(f"Temp dir: {temp_dir}")
    print("=" * 72)

    if args.dry_run:
        for batch_index, (global_index, word, _entry, existing_json) in enumerate(candidates, start=1):
            print(f"[{batch_index}/{len(candidates)}] would process: {word} ({existing_json.name})")
        progress["lastDryRunAt"] = utc_stamp()
        progress["lastDryRunCount"] = len(candidates)
        write_json(args.progress, progress)
        return

    service_account = require_service_account(args.service_account)
    bucket_name = resolve_bucket(args.bucket, service_account)
    bucket_obj, db, safe_doc_id_fn = init_firebase_upload(service_account, bucket_name)

    counts = progress.setdefault("counts", {"processed": 0, "skipped": 0, "failed": 0, "uploaded": 0})
    processed_words = set(progress.setdefault("processedWords", []))
    updated_paths = progress.setdefault("updatedStoragePaths", [])
    removed_temp_files = progress.setdefault("removedTempFiles", [])

    for batch_index, (global_index, word, entry, existing_json) in enumerate(candidates, start=1):
        print(f"[{batch_index}/{len(candidates)}] processing: {word}")
        temp_json = temp_dir / existing_json.name
        video_failures: list[dict[str, str]] = []
        video_path: Path | None = None
        try:
            existing_data = read_json(existing_json, {})
            video_paths = [path for path in resolve_video_paths(wlasl_path, entry) if path.exists()]
            extracted_data, video_path, video_failures = extract_mouth_only(video_paths, word, args.fps)
            if not extracted_data:
                raise RuntimeError("no mouth landmarks extracted")

            merged_data = merge_mouth_into_existing(existing_data, extracted_data)
            validation_errors = validate_sign_json(merged_data)
            if validation_errors:
                raise RuntimeError("validation failed: " + "; ".join(validation_errors))

            write_json(temp_json, merged_data)
            storage_path = upload_one(
                json_file=temp_json,
                sign_data=merged_data,
                manifest=manifest,
                bucket_obj=bucket_obj,
                db=db,
                safe_doc_id_fn=safe_doc_id_fn,
                collection=args.collection,
                dry_run=False,
            )
            temp_json.unlink()

            counts["processed"] = counts.get("processed", 0) + 1
            counts["uploaded"] = counts.get("uploaded", 0) + 1
            processed_words.add(word)
            updated_paths.append(storage_path)
            removed_temp_files.append(str(temp_json))
            progress["lastGlobalIndex"] = global_index
            progress["lastWord"] = word
            progress["lastVideoPath"] = str(video_path) if video_path else None
            progress["lastFirebaseUploadPath"] = storage_path
            progress["updatedAt"] = utc_stamp()
            progress["processedWords"] = sorted(processed_words)
            update_quality_report(quality_report, word, merged_data, video_path, "video_mouth")
            write_json(args.progress, progress)
            failures.pop(word, None)
            write_json(args.failures, failures)
            write_json(args.quality_report, quality_report)
            print(f"[{batch_index}/{len(candidates)}] processed: {word} -> {storage_path}")
        except Exception as exc:
            counts["failed"] = counts.get("failed", 0) + 1
            failures[word] = {
                "error": str(exc),
                "globalIndex": global_index,
                "videoFailures": video_failures,
                "updatedAt": utc_stamp(),
            }
            progress["updatedAt"] = utc_stamp()
            progress["lastGlobalIndex"] = global_index
            progress["lastWord"] = word
            write_json(args.progress, progress)
            write_json(args.failures, failures)
            write_json(args.quality_report, quality_report)
            if temp_json.exists():
                print(f"  kept temp file after failure: {temp_json}")
            print(f"[{batch_index}/{len(candidates)}] failed: {word} ({exc})")

    print("=" * 72)
    print("Batch complete")
    print(json.dumps(counts, indent=2))
    print(f"Progress: {args.progress}")
    print(f"Failures: {args.failures}")
    print(f"Quality report: {args.quality_report}")
    print("=" * 72)


if __name__ == "__main__":
    main()
