#!/usr/bin/env python3
"""Automatically expand the local/Firebase WLASL sign dictionary in safe batches.

Example:
  python scripts/auto_expand_dictionary.py --batch-size 25 --cycles 10 --upload --cleanup
"""

import argparse
import json
import os
import shutil
import subprocess
import sys
import time
import urllib.request
from datetime import datetime
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

SCRIPT_DIR = Path(__file__).resolve().parent
PROJECT_ROOT = SCRIPT_DIR.parent
if str(SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPT_DIR))

from build_manifest import build_manifest, find_metadata, load_json, normalize_word, safe_sign_filename
from process_batch import extract_video_landmarks, output_file_for, upload_one, write_json
from sign_landmark_utils import require_service_account, resolve_bucket


VIDEO_EXTENSIONS = {".mp4", ".mkv", ".webm", ".mov", ".avi"}
FAILED_DOWNLOADS_NAME = "failedDownloads.json"
FAILED_PROCESSING_NAME = "failedSignExtractions.json"
STATUS_NAME = "expansion_status.json"
MAX_CONSECUTIVE_FAILURE_CYCLES = 3


def parse_bool(value: str | bool) -> bool:
    if isinstance(value, bool):
        return value
    normalized = value.strip().lower()
    if normalized in {"1", "true", "yes", "y", "on"}:
        return True
    if normalized in {"0", "false", "no", "n", "off"}:
        return False
    raise argparse.ArgumentTypeError(f"Expected true or false, got {value!r}.")


def read_json(path: Path, default: Any) -> Any:
    if not path.exists():
        return default
    with path.open("r", encoding="utf-8") as handle:
        return json.load(handle)


def write_status(path: Path, status: dict[str, Any]) -> None:
    status["timestamp"] = datetime.now().isoformat()
    write_json(path, status)


def load_word_file(path: Path) -> list[str]:
    if not path.exists():
        raise SystemExit(f"Word file not found: {path}")
    words: list[str] = []
    for line in path.read_text(encoding="utf-8").splitlines():
        value = line.split("#", 1)[0].strip()
        if value:
            words.append(normalize_word(value))
    return words


def start_kit_path(wlasl_path: Path) -> Path:
    return wlasl_path / "start_kit"


def videos_path(wlasl_path: Path) -> Path:
    return start_kit_path(wlasl_path) / "videos"


def raw_video_paths(wlasl_path: Path) -> list[Path]:
    kit = start_kit_path(wlasl_path)
    return [kit / "raw_videos_mp4", kit / "raw_videos"]


def video_storage_gb(wlasl_path: Path) -> float:
    roots = [videos_path(wlasl_path), *raw_video_paths(wlasl_path)]
    total = 0
    for root in roots:
        if not root.exists():
            continue
        for file_path in root.rglob("*"):
            if file_path.is_file():
                total += file_path.stat().st_size
    return total / (1024 ** 3)


def safe_delete_file(path: Path, allowed_roots: list[Path]) -> bool:
    if not path.exists():
        return False
    resolved = path.resolve()
    resolved_roots = [root.resolve() for root in allowed_roots]
    if not any(root == resolved or root in resolved.parents for root in resolved_roots):
        return False
    path.unlink()
    return True


def video_id_from_url(url: str) -> str:
    parsed = urlparse(url)
    if "youtu.be" in parsed.netloc:
        return parsed.path.strip("/")[-11:]
    if "youtube" in parsed.netloc:
        query = dict(part.split("=", 1) for part in parsed.query.split("&") if "=" in part)
        if query.get("v"):
            return query["v"][-11:]
    return url[-11:]


def is_youtube(url: str) -> bool:
    return "youtube" in url or "youtu.be" in url


def validate_video(path: Path) -> bool:
    if not path.exists() or path.stat().st_size < 1024:
        return False
    try:
        import cv2

        cap = cv2.VideoCapture(str(path))
        opened = cap.isOpened()
        frame_count = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
        cap.release()
        return opened and frame_count != 0
    except Exception:
        return False


def convert_clip_to_mp4(src: Path, dst: Path, start_frame: int, end_frame: int, fallback_fps: float = 25.0) -> bool:
    try:
        import cv2

        cap = cv2.VideoCapture(str(src))
        if not cap.isOpened():
            return False

        fps = cap.get(cv2.CAP_PROP_FPS) or fallback_fps
        frames = []
        index = 0
        first = max(0, start_frame - 1)
        last = end_frame - 1 if end_frame and end_frame > 0 else None

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


def download_direct(url: str, raw_dir: Path, video_id: str, timeout: int = 120) -> Path | None:
    suffix = Path(urlparse(url).path).suffix.lower()
    if suffix not in VIDEO_EXTENSIONS:
        suffix = ".mp4"

    raw_dir.mkdir(parents=True, exist_ok=True)
    final_path = raw_dir / f"{video_id}{suffix}"
    tmp_path = raw_dir / f"{video_id}.download{suffix}"
    if validate_video(final_path):
        return final_path

    request = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            with tmp_path.open("wb") as handle:
                shutil.copyfileobj(response, handle)
        tmp_path.replace(final_path)
        if validate_video(final_path):
            return final_path
    except Exception:
        pass

    safe_delete_file(tmp_path, [raw_dir])
    safe_delete_file(final_path, [raw_dir])
    return None


def download_youtube(url: str, raw_dir: Path, timeout: int = 240) -> Path | None:
    downloader = shutil.which("yt-dlp") or shutil.which("youtube-dl")
    if not downloader:
        raise RuntimeError("yt-dlp or youtube-dl is required for YouTube downloads.")

    raw_dir.mkdir(parents=True, exist_ok=True)
    yt_id = video_id_from_url(url)
    existing = next((path for path in raw_dir.glob(f"{yt_id}.*") if validate_video(path)), None)
    if existing:
        return existing

    output_pattern = str(raw_dir / "%(id)s.%(ext)s")
    command = [
        downloader,
        "--no-playlist",
        "-f",
        "mp4/best[ext=mp4]/best",
        "-o",
        output_pattern,
        url,
    ]
    result = subprocess.run(command, cwd=str(raw_dir), capture_output=True, text=True, timeout=timeout)
    if result.returncode != 0:
        for partial in raw_dir.glob(f"{yt_id}*.part"):
            safe_delete_file(partial, [raw_dir])
        raise RuntimeError(result.stderr.strip() or result.stdout.strip() or "yt-dlp failed")

    downloaded = next((path for path in raw_dir.glob(f"{yt_id}.*") if validate_video(path)), None)
    if not downloaded:
        for partial in raw_dir.glob(f"{yt_id}*"):
            if partial.is_file():
                safe_delete_file(partial, [raw_dir])
    return downloaded


def find_existing_extracted_video(wlasl_path: Path, instance: dict[str, Any]) -> Path | None:
    candidate = videos_path(wlasl_path) / f"{instance.get('video_id')}.mp4"
    return candidate if validate_video(candidate) else None


def download_instance(wlasl_path: Path, instance: dict[str, Any]) -> tuple[Path | None, Path | None, str | None]:
    url = str(instance.get("url", "")).strip()
    video_id = str(instance.get("video_id", "")).strip()
    if not url or not video_id:
        return None, None, "missing url or video_id"

    existing = find_existing_extracted_video(wlasl_path, instance)
    if existing:
        return existing, None, None

    raw_mp4_dir = raw_video_paths(wlasl_path)[0]
    try:
        raw_path = download_youtube(url, raw_mp4_dir) if is_youtube(url) else download_direct(url, raw_mp4_dir, video_id)
    except Exception as exc:
        return None, None, str(exc)

    if not raw_path:
        return None, None, "download failed or produced an invalid video"

    extracted_path = videos_path(wlasl_path) / f"{video_id}.mp4"
    start_frame = int(instance.get("frame_start") or 1)
    end_frame = int(instance.get("frame_end") or -1)
    if not convert_clip_to_mp4(raw_path, extracted_path, start_frame, end_frame, float(instance.get("fps") or 25)):
        safe_delete_file(extracted_path, [videos_path(wlasl_path)])
        safe_delete_file(raw_path, raw_video_paths(wlasl_path))
        return None, raw_path, "could not extract a valid mp4 clip"

    return extracted_path, raw_path, None


def metadata_by_gloss(wlasl_path: Path) -> dict[str, dict[str, Any]]:
    metadata = load_json(find_metadata(wlasl_path))
    return {normalize_word(item.get("gloss", "")): item for item in metadata if normalize_word(item.get("gloss", ""))}


def select_words(
    metadata: dict[str, dict[str, Any]],
    manifest: dict[str, Any],
    signs_dir: Path,
    failed_processing: dict[str, Any],
    requested_words: list[str],
) -> list[str]:
    entries = manifest.get("entries", {})
    ordered = requested_words if requested_words else list(metadata.keys())
    selected = []
    seen = set()

    for gloss in ordered:
        if gloss in seen or gloss not in metadata:
            continue
        seen.add(gloss)
        entry = entries.get(gloss, {})
        if output_file_for(signs_dir, gloss).exists() or entry.get("landmarksAvailable"):
            continue
        if failed_processing.get(gloss, {}).get("allVideosFailed"):
            continue
        selected.append(gloss)
    return selected


def ensure_downloaded_batch(
    wlasl_path: Path,
    words: list[str],
    metadata: dict[str, dict[str, Any]],
    manifest: dict[str, Any],
    failed_downloads: dict[str, Any],
    batch_size: int,
    max_storage_gb: float,
) -> tuple[list[str], dict[str, Path], int]:
    entries = manifest.get("entries", {})
    batch_words: list[str] = []
    raw_downloads: dict[str, Path] = {}
    failed = 0

    for gloss in words:
        if len(batch_words) >= batch_size:
            break
        if video_storage_gb(wlasl_path) > max_storage_gb:
            break

        entry = entries.get(gloss, {})
        if entry.get("videoAvailable"):
            batch_words.append(gloss)
            continue

        print(f"  downloading: {gloss}")
        downloaded = False
        for instance in metadata[gloss].get("instances", []):
            video_id = str(instance.get("video_id", "")).strip()
            if not video_id or failed_downloads.get(video_id):
                continue
            extracted, raw, error = download_instance(wlasl_path, instance)
            if extracted:
                if raw:
                    raw_downloads[gloss] = raw
                batch_words.append(gloss)
                downloaded = True
                print(f"    ok: {extracted.name}")
                break
            failed += 1
            failed_downloads[video_id] = {
                "gloss": gloss,
                "url": instance.get("url"),
                "error": error,
                "timestamp": datetime.now().isoformat(),
            }
            print(f"    failed {video_id}: {error}")

        if not downloaded:
            print(f"    no downloadable video succeeded for {gloss}")

    return batch_words, raw_downloads, failed


def process_words(
    wlasl_path: Path,
    signs_dir: Path,
    manifest_path: Path,
    words: list[str],
    fps: int,
    failed_processing: dict[str, Any],
) -> tuple[list[str], dict[str, Path], int]:
    manifest = build_manifest(wlasl_path=wlasl_path, signs_path=signs_dir, output_path=manifest_path)
    processed: list[str] = []
    successful_videos: dict[str, Path] = {}
    failed = 0

    for index, gloss in enumerate(words, start=1):
        output_file = output_file_for(signs_dir, gloss)
        if output_file.exists():
            print(f"  [{index}/{len(words)}] skip processed: {gloss}")
            continue

        entry = manifest.get("entries", {}).get(gloss, {})
        video_paths = []
        for raw_path in entry.get("videoPaths") or ([entry.get("videoPath")] if entry.get("videoPath") else []):
            path = Path(raw_path)
            if not path.is_absolute():
                path = wlasl_path / path
            video_paths.append(path.resolve())

        print(f"  [{index}/{len(words)}] processing: {gloss}")
        result = None
        successful_video: Path | None = None
        failures = []
        for video_path in video_paths:
            if not validate_video(video_path):
                failures.append({"video": str(video_path), "error": "missing, broken, or empty"})
                continue
            try:
                result = extract_video_landmarks(video_path, gloss, fps)
            except Exception as exc:
                result = None
                failures.append({"video": str(video_path), "error": str(exc)})
            if result and result.get("frames"):
                successful_video = video_path
                break

        if not result or not successful_video:
            failed += 1
            failed_processing[gloss] = {
                "allVideosFailed": True,
                "failures": failures,
                "timestamp": datetime.now().isoformat(),
            }
            print(f"    failed: {gloss}")
            continue

        write_json(output_file, result)
        processed.append(gloss)
        successful_videos[gloss] = successful_video
        failed_processing.pop(gloss, None)
        print(f"    saved: {output_file}")

    write_json(PROJECT_ROOT / "data" / FAILED_PROCESSING_NAME, failed_processing)
    build_manifest(wlasl_path=wlasl_path, signs_path=signs_dir, output_path=manifest_path)
    return processed, successful_videos, failed


def main() -> None:
    parser = argparse.ArgumentParser(description="Safely expand the WLASL sign dictionary over repeated small cycles.")
    parser.add_argument("--batch-size", type=int, default=25)
    parser.add_argument("--cycles", type=int, default=1)
    parser.add_argument("--upload", action="store_true")
    parser.add_argument("--cleanup", action="store_true")
    parser.add_argument("--word-file", type=Path)
    parser.add_argument("--max-storage-gb", type=float, default=5)
    parser.add_argument("--stop-on-error", type=parse_bool, default=False)
    parser.add_argument("--wlasl-path", type=Path, default=PROJECT_ROOT / "WLASL")
    parser.add_argument("--manifest", type=Path, default=PROJECT_ROOT / "data" / "signManifest.json")
    parser.add_argument("--signs-dir", type=Path, default=PROJECT_ROOT / "data" / "signs")
    parser.add_argument("--fps", type=int, default=30)
    args = parser.parse_args()

    if args.batch_size <= 0:
        raise SystemExit("--batch-size must be greater than 0.")
    if args.cycles <= 0:
        raise SystemExit("--cycles must be greater than 0.")

    wlasl_path = args.wlasl_path.resolve()
    manifest_path = args.manifest.resolve()
    signs_dir = args.signs_dir.resolve()
    data_dir = PROJECT_ROOT / "data"
    status_path = data_dir / STATUS_NAME
    failed_downloads_path = data_dir / FAILED_DOWNLOADS_NAME
    failed_processing_path = data_dir / FAILED_PROCESSING_NAME

    if not wlasl_path.exists():
        raise SystemExit(f"WLASL path not found: {wlasl_path}")

    for path in [videos_path(wlasl_path), *raw_video_paths(wlasl_path), signs_dir, data_dir]:
        path.mkdir(parents=True, exist_ok=True)

    requested_words = load_word_file(args.word_file.resolve()) if args.word_file else []
    status = read_json(status_path, {})
    failed_downloads = read_json(failed_downloads_path, {})
    failed_processing = read_json(failed_processing_path, {})
    metadata = metadata_by_gloss(wlasl_path)
    consecutive_failure_cycles = int(status.get("consecutiveFailureCycles", 0))

    print("=" * 72)
    print("WLASL Auto Expansion Pipeline")
    print("=" * 72)
    print(f"Batch size: {args.batch_size}")
    print(f"Cycles: {args.cycles}")
    print(f"Upload enabled: {args.upload}")
    print(f"Cleanup enabled: {args.cleanup}")
    print(f"Max video storage: {args.max_storage_gb} GB")
    print("=" * 72)

    if args.upload:
        try:
            service_account = require_service_account(
                os.environ.get("GOOGLE_APPLICATION_CREDENTIALS") or PROJECT_ROOT / "firebase-service-account.json"
            )
            bucket_name = resolve_bucket(None, service_account)
            print(f"Firebase Admin upload ready: {bucket_name}")
        except RuntimeError as exc:
            raise SystemExit(f"--upload requires Firebase Admin credentials:\n{exc}") from exc

    for cycle in range(1, args.cycles + 1):
        try:
            print(f"\nCycle {cycle}/{args.cycles}")
            storage_gb = video_storage_gb(wlasl_path)
            if storage_gb > args.max_storage_gb:
                print(f"Stopping: video folders use {storage_gb:.2f} GB, above {args.max_storage_gb:.2f} GB.")
                manifest_for_status = read_json(manifest_path, {})
                status.update(
                    {
                        "totalWlaslGlosses": manifest_for_status.get("stats", {}).get("totalWlaslWords", len(metadata)),
                        "processedSigns": manifest_for_status.get("stats", {}).get("landmarksGenerated", 0),
                        "uploadedSigns": int(status.get("uploadedSigns", 0)),
                        "failedDownloads": len(failed_downloads),
                        "failedProcessing": len(failed_processing),
                        "currentCycle": cycle,
                        "lastProcessedWords": [],
                        "videoStorageGb": round(storage_gb, 4),
                        "stopReason": "max storage exceeded",
                    }
                )
                write_status(status_path, status)
                break

            print("Refreshing WLASL manifest...")
            manifest = build_manifest(wlasl_path=wlasl_path, signs_path=signs_dir, output_path=manifest_path)
            candidate_words = select_words(metadata, manifest, signs_dir, failed_processing, requested_words)
            if not candidate_words:
                print("Stopping: no more downloadable or processable WLASL signs were found.")
                status.update(
                    {
                        "totalWlaslGlosses": manifest.get("stats", {}).get("totalWlaslWords", len(metadata)),
                        "processedSigns": manifest.get("stats", {}).get("landmarksGenerated", 0),
                        "uploadedSigns": int(status.get("uploadedSigns", 0)),
                        "failedDownloads": len(failed_downloads),
                        "failedProcessing": len(failed_processing),
                        "currentCycle": cycle,
                        "lastProcessedWords": [],
                        "videoStorageGb": round(video_storage_gb(wlasl_path), 4),
                        "stopReason": "no candidate signs",
                    }
                )
                write_status(status_path, status)
                break

            print(f"Downloading {args.batch_size} videos...")
            batch_words, raw_downloads, failed_download_count = ensure_downloaded_batch(
                wlasl_path=wlasl_path,
                words=candidate_words,
                metadata=metadata,
                manifest=manifest,
                failed_downloads=failed_downloads,
                batch_size=args.batch_size,
                max_storage_gb=args.max_storage_gb,
            )
            write_json(failed_downloads_path, failed_downloads)

            if not batch_words:
                print("Stopping: no more downloadable videos are available for the current candidate set.")
                status.update(
                    {
                        "totalWlaslGlosses": manifest.get("stats", {}).get("totalWlaslWords", len(metadata)),
                        "processedSigns": manifest.get("stats", {}).get("landmarksGenerated", 0),
                        "uploadedSigns": int(status.get("uploadedSigns", 0)),
                        "failedDownloads": len(failed_downloads),
                        "failedProcessing": len(failed_processing),
                        "currentCycle": cycle,
                        "lastProcessedWords": [],
                        "videoStorageGb": round(video_storage_gb(wlasl_path), 4),
                        "stopReason": "no downloadable videos",
                    }
                )
                write_status(status_path, status)
                break

            print(f"Processing {len(batch_words)} signs...")
            processed_words, successful_videos, failed_processing_count = process_words(
                wlasl_path=wlasl_path,
                signs_dir=signs_dir,
                manifest_path=manifest_path,
                words=batch_words,
                fps=args.fps,
                failed_processing=failed_processing,
            )

            uploaded_count = 0
            upload_confirmed_words = set(processed_words)
            if args.upload:
                print("Uploading successful signs...")
                upload_confirmed_words = set()
                for gloss in processed_words:
                    json_file = output_file_for(signs_dir, gloss)
                    try:
                        upload_one(json_file, manifest_path)
                        uploaded_count += 1
                        upload_confirmed_words.add(gloss)
                        print(f"  uploaded: {gloss}")
                    except Exception as exc:
                        print(f"  upload failed for {gloss}: {exc}")

            if args.cleanup:
                print("Cleaning up raw videos...")
                cleanup_roots = [videos_path(wlasl_path), *raw_video_paths(wlasl_path)]
                for gloss in upload_confirmed_words:
                    extracted_video = successful_videos.get(gloss)
                    if extracted_video and safe_delete_file(extracted_video, cleanup_roots):
                        print(f"  cleaned extracted video: {extracted_video.name}")
                    raw_video = raw_downloads.get(gloss)
                    if raw_video and safe_delete_file(raw_video, cleanup_roots):
                        print(f"  cleaned raw video: {raw_video.name}")

            manifest = build_manifest(wlasl_path=wlasl_path, signs_path=signs_dir, output_path=manifest_path)
            processed_total = manifest.get("stats", {}).get("landmarksGenerated", 0)
            status.update(
                {
                    "totalWlaslGlosses": manifest.get("stats", {}).get("totalWlaslWords", len(metadata)),
                    "processedSigns": processed_total,
                    "uploadedSigns": int(status.get("uploadedSigns", 0)) + uploaded_count,
                    "failedDownloads": len(failed_downloads),
                    "failedProcessing": len(failed_processing),
                    "currentCycle": cycle,
                    "lastProcessedWords": processed_words,
                    "videoStorageGb": round(video_storage_gb(wlasl_path), 4),
                    "stopReason": None,
                }
            )

            if processed_words:
                consecutive_failure_cycles = 0
            else:
                consecutive_failure_cycles += 1
            status["consecutiveFailureCycles"] = consecutive_failure_cycles
            write_status(status_path, status)

            print("Cycle complete.")
            print(f"  processed this cycle: {len(processed_words)}")
            print(f"  uploaded this cycle: {uploaded_count}")
            print(f"  failed downloads this cycle: {failed_download_count}")
            print(f"  failed processing this cycle: {failed_processing_count}")

            if consecutive_failure_cycles >= MAX_CONSECUTIVE_FAILURE_CYCLES:
                print(f"Stopping: {consecutive_failure_cycles} consecutive cycles completed without processing a sign.")
                break
        except Exception as exc:
            status["lastError"] = str(exc)
            write_status(status_path, status)
            print(f"Cycle error: {exc}")
            if args.stop_on_error:
                raise
            consecutive_failure_cycles += 1
            status["consecutiveFailureCycles"] = consecutive_failure_cycles
            write_status(status_path, status)
            if consecutive_failure_cycles >= MAX_CONSECUTIVE_FAILURE_CYCLES:
                print(f"Stopping: too many consecutive failures ({consecutive_failure_cycles}).")
                break
            time.sleep(1)

    print("\nExpansion pipeline finished.")
    print(f"Status written to: {status_path}")


if __name__ == "__main__":
    main()
