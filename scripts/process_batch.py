#!/usr/bin/env python3
"""Safely process WLASL signs in small Windows-friendly batches.

Examples:
  python scripts/process_batch.py --limit 25
  python scripts/process_batch.py --word-file data/priority_words.txt
  python scripts/process_batch.py --limit 25 --dry-run
  python scripts/process_batch.py --limit 25 --upload
  python scripts/process_batch.py --limit 25 --upload --cleanup
"""

import argparse
import json
import os
import sys
from pathlib import Path
from typing import Any

from build_manifest import build_manifest, normalize_word, safe_sign_filename
from sign_landmark_utils import require_service_account, resolve_bucket


FAILED_LOG_NAME = "failedSignExtractions.json"


def load_json(path: Path, default: Any) -> Any:
    if not path.exists():
        return default
    with path.open("r", encoding="utf-8") as handle:
        return json.load(handle)


def write_json(path: Path, data: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8") as handle:
        json.dump(data, handle, indent=2)
        handle.write("\n")


def load_word_file(path: Path) -> list[str]:
    if not path.exists():
        raise SystemExit(f"Word file not found: {path}")
    words = []
    for line in path.read_text(encoding="utf-8").splitlines():
        value = line.split("#", 1)[0].strip()
        if value:
            words.append(normalize_word(value))
    return words


def output_file_for(signs_dir: Path, gloss: str) -> Path:
    return signs_dir / f"{safe_sign_filename(gloss)}.json"


def resolved_video_paths(wlasl_path: Path, entry: dict[str, Any]) -> list[Path]:
    paths = []
    for raw_path in entry.get("videoPaths") or ([entry.get("videoPath")] if entry.get("videoPath") else []):
        path = Path(raw_path)
        if not path.is_absolute():
            path = wlasl_path / path
        paths.append(path.resolve())
    return paths


def is_safe_cleanup_path(path: Path, wlasl_path: Path) -> bool:
    resolved = path.resolve()
    allowed_roots = [
        (wlasl_path / "start_kit" / "videos").resolve(),
        (wlasl_path / "start_kit" / "raw_videos_mp4").resolve(),
        (wlasl_path / "start_kit" / "raw_videos").resolve(),
    ]
    return any(root == resolved or root in resolved.parents for root in allowed_roots)


def cleanup_video(path: Path, wlasl_path: Path) -> bool:
    if not path.exists() or not is_safe_cleanup_path(path, wlasl_path):
        return False
    path.unlink()
    return True


def select_candidates(
    manifest: dict[str, Any],
    signs_dir: Path,
    failed_log: dict[str, Any],
    limit: int | None,
    requested_words: list[str],
    retry_failed: bool,
    force: bool,
) -> tuple[list[tuple[str, dict[str, Any]]], dict[str, int]]:
    requested = set(requested_words)
    candidates: list[tuple[str, dict[str, Any]]] = []
    counts = {
        "already_processed": 0,
        "missing_video": 0,
        "previously_failed": 0,
        "requested_missing": 0,
    }

    entries = manifest.get("entries", {})
    iterable = (
        [(word, entries[word]) for word in requested_words if word in entries]
        if requested
        else list(entries.items())
    )
    counts["requested_missing"] = len([word for word in requested_words if word not in entries])

    for gloss, entry in iterable:
        output_file = output_file_for(signs_dir, gloss)
        if not force and (output_file.exists() or entry.get("landmarksAvailable")):
            counts["already_processed"] += 1
            continue
        if not entry.get("videoAvailable"):
            counts["missing_video"] += 1
            continue
        if not retry_failed and failed_log.get(gloss, {}).get("allVideosFailed"):
            counts["previously_failed"] += 1
            continue
        candidates.append((gloss, entry))
        if limit and len(candidates) >= limit:
            break

    return candidates, counts


def update_manifest(project_root: Path, wlasl_path: Path, signs_dir: Path, manifest_path: Path) -> dict[str, Any]:
    return build_manifest(wlasl_path=wlasl_path, signs_path=signs_dir, output_path=manifest_path)


def upload_one(json_file: Path, manifest_path: Path) -> None:
    from upload_signs_to_firebase import upload_files

    project_root = Path(__file__).resolve().parents[1]
    service_account = require_service_account(
        os.environ.get("GOOGLE_APPLICATION_CREDENTIALS") or project_root / "firebase-service-account.json"
    )
    bucket = resolve_bucket(os.environ.get("FIREBASE_STORAGE_BUCKET"), service_account)
    upload_files(
        files=[json_file],
        manifest_path=manifest_path,
        service_account=service_account,
        bucket_name=bucket,
        collection_name="signs",
    )


def extract_video_landmarks(video_path: Path, gloss: str, fps: int) -> dict[str, Any] | None:
    try:
        from extract_landmarks import extract_landmarks_from_video
    except Exception as exc:
        raise RuntimeError(
            "Could not import MediaPipe landmark extraction. "
            "Check the Python environment and scripts/requirements.txt."
        ) from exc

    return extract_landmarks_from_video(str(video_path), word=gloss, target_fps=fps)


def main() -> None:
    project_root = Path(__file__).resolve().parents[1]
    parser = argparse.ArgumentParser(description="Safely process the next WLASL signs in a small batch.")
    parser.add_argument("--limit", type=int, help="Process only the next N unprocessed WLASL signs.")
    parser.add_argument("--word-file", type=Path, help="Process only words listed in this file.")
    parser.add_argument("--words", nargs="*", default=[], help="Optional explicit gloss list.")
    parser.add_argument("--upload", action="store_true", help="Upload successful JSONs to Firebase Storage/Firestore.")
    parser.add_argument("--cleanup", action="store_true", help="Delete source video samples after successful JSON generation.")
    parser.add_argument("--dry-run", action="store_true", help="Preview the batch without extracting, uploading, or cleanup.")
    parser.add_argument("--retry-failed", action="store_true", help="Retry signs whose videos failed in an earlier batch.")
    parser.add_argument("--force", action="store_true", help="Overwrite existing JSONs for explicitly selected words.")
    parser.add_argument("--wlasl-path", type=Path, default=project_root / "WLASL")
    parser.add_argument("--manifest", type=Path, default=project_root / "data" / "signManifest.json")
    parser.add_argument("--signs-dir", type=Path, default=project_root / "data" / "signs")
    parser.add_argument("--fps", type=int, default=30)
    args = parser.parse_args()

    if not args.limit and not args.word_file and not args.words:
        raise SystemExit("Refusing to process everything. Use --limit 25, --word-file, or --words.")
    if args.limit is not None and args.limit <= 0:
        raise SystemExit("--limit must be greater than 0.")

    wlasl_path = args.wlasl_path.resolve()
    signs_dir = args.signs_dir.resolve()
    manifest_path = args.manifest.resolve()
    signs_dir.mkdir(parents=True, exist_ok=True)

    if not wlasl_path.exists():
        raise SystemExit(f"WLASL path not found: {wlasl_path}")

    print("Refreshing manifest from WLASL metadata and local videos.")
    manifest = update_manifest(project_root, wlasl_path, signs_dir, manifest_path)

    word_file_words = load_word_file(args.word_file.resolve()) if args.word_file else []
    requested_words = [normalize_word(word) for word in [*word_file_words, *args.words]]

    failed_log_path = project_root / "data" / FAILED_LOG_NAME
    failed_log = load_json(failed_log_path, {})
    candidates, skip_counts = select_candidates(
        manifest=manifest,
        signs_dir=signs_dir,
        failed_log=failed_log,
        limit=args.limit,
        requested_words=requested_words,
        retry_failed=args.retry_failed,
        force=args.force,
    )

    total_glosses = len(manifest.get("entries", {}))
    videos_downloaded = sum(1 for entry in manifest.get("entries", {}).values() if entry.get("videoAvailable"))
    already_processed = sum(
        1
        for gloss, entry in manifest.get("entries", {}).items()
        if output_file_for(signs_dir, gloss).exists() or entry.get("landmarksAvailable")
    )
    remaining_unprocessed = max(0, total_glosses - already_processed)

    print("=" * 72)
    print("WLASL Safe Batch Processor")
    print("=" * 72)
    print(f"Total WLASL glosses found: {total_glosses}")
    print(f"Videos downloaded: {videos_downloaded}")
    print(f"Already processed: {already_processed}")
    print(f"Remaining unprocessed: {remaining_unprocessed}")
    print(f"Skipped missing videos: {skip_counts['missing_video']}")
    print(f"Skipped previous failures: {skip_counts['previously_failed']}")
    print(f"Requested words missing from WLASL: {skip_counts['requested_missing']}")
    print(f"Current batch size: {len(candidates)}")
    print(f"Upload enabled: {args.upload}")
    print(f"Cleanup enabled: {args.cleanup}")
    print(f"Dry run: {args.dry_run}")
    print("=" * 72)

    if args.dry_run:
        if candidates:
            print("Batch preview:")
            for index, (gloss, entry) in enumerate(candidates, start=1):
                video_count = len(resolved_video_paths(wlasl_path, entry))
                print(f"  {index}. {gloss} ({video_count} video candidate{'s' if video_count != 1 else ''})")
        else:
            print("Batch preview: no unprocessed signs matched this request.")
        print("=" * 72)
        return

    successful = 0
    failed = 0
    skipped = (
        skip_counts["already_processed"]
        + skip_counts["missing_video"]
        + skip_counts["previously_failed"]
        + skip_counts["requested_missing"]
    )

    for batch_index, (gloss, entry) in enumerate(candidates, start=1):
        output_file = output_file_for(signs_dir, gloss)
        print(f"\n[{batch_index}/{len(candidates)}] {gloss}")

        if output_file.exists() and not args.force:
            skipped += 1
            print(f"  skipped: already exists at {output_file}")
            continue

        video_paths = resolved_video_paths(wlasl_path, entry)
        if not video_paths:
            failed += 1
            print("  failed: no local video paths")
            continue

        result = None
        successful_video: Path | None = None
        video_failures = []

        for video_path in video_paths:
            if not video_path.exists():
                video_failures.append({"video": str(video_path), "error": "missing"})
                print(f"  skip video: missing {video_path.name}")
                continue
            try:
                result = extract_video_landmarks(video_path, gloss, args.fps)
            except Exception as exc:  # Keep batch alive for bad files/codecs.
                result = None
                video_failures.append({"video": str(video_path), "error": str(exc)})
                print(f"  failed video: {video_path.name} ({exc})")
                continue
            if result and result.get("frames"):
                successful_video = video_path
                break
            video_failures.append({"video": str(video_path), "error": "landmark extraction failed"})
            print(f"  failed video: {video_path.name}")

        if not result or not successful_video:
            failed += 1
            failed_log[gloss] = {
                "allVideosFailed": True,
                "failures": video_failures,
            }
            write_json(failed_log_path, failed_log)
            print("  failed: all candidate videos failed")
            continue

        write_json(output_file, result)
        successful += 1
        failed_log.pop(gloss, None)
        write_json(failed_log_path, failed_log)
        print(f"  saved: {output_file}")

        manifest = update_manifest(project_root, wlasl_path, signs_dir, manifest_path)
        print("  manifest updated")

        if args.upload:
            try:
                upload_one(output_file, manifest_path)
                print("  uploaded to Firebase")
            except Exception as exc:
                print(f"  upload failed: {exc}")

        if args.cleanup and successful_video:
            if cleanup_video(successful_video, wlasl_path):
                print(f"  cleaned up: {successful_video}")
                manifest = update_manifest(project_root, wlasl_path, signs_dir, manifest_path)
                print("  manifest updated after cleanup")
            else:
                print(f"  cleanup skipped for safety: {successful_video}")

        print(f"  progress: successful={successful}, failed={failed}, skipped={skipped}")

    print("\n" + "=" * 72)
    print("Batch Summary")
    print("=" * 72)
    print(f"Total WLASL glosses found: {total_glosses}")
    print(f"Videos downloaded: {videos_downloaded}")
    print(f"Already processed before batch: {already_processed}")
    print(f"Current batch size: {len(candidates)}")
    print(f"Successful: {successful}")
    print(f"Failed: {failed}")
    print(f"Skipped: {skipped}")
    print("=" * 72)


if __name__ == "__main__":
    main()
