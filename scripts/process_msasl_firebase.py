#!/usr/bin/env python3
"""Batch-process MS-ASL clips into Firebase-backed landmark variants."""

import argparse
import hashlib
import json
import shlex
import subprocess
from datetime import datetime
from pathlib import Path
from typing import Any

from sign_landmark_utils import (
    cleanup_temp_files,
    download_with_ytdlp,
    extract_holistic_landmarks,
    init_firebase,
    load_status,
    normalize_word,
    safe_variant_id,
    save_status,
    slugify,
    update_sign_doc_duplicate_safe,
    upload_json_to_storage,
    write_json,
)


PROJECT_ROOT = Path(__file__).resolve().parents[1]
MSASL_ROOT = PROJECT_ROOT / "MSASL"
STATUS_PATH = PROJECT_ROOT / "data" / "msasl_expansion_status.json"
TEMP_ROOT = PROJECT_ROOT / "data" / "temp_msasl"


def load_split(split: str) -> list[dict[str, Any]]:
    path = MSASL_ROOT / f"MSASL_{split}.json"
    with path.open("r", encoding="utf-8") as handle:
        rows = json.load(handle)
    for row in rows:
        row["_split"] = split
    return rows


def load_entries(split: str) -> list[dict[str, Any]]:
    if split == "all":
        entries: list[dict[str, Any]] = []
        for name in ["train", "val", "test"]:
            entries.extend(load_split(name))
        return entries
    return load_split(split)


def video_key(entry: dict[str, Any]) -> str:
    raw = "|".join(
        [
            str(entry.get("url", "")),
            str(entry.get("start_time", entry.get("start", ""))),
            str(entry.get("end_time", entry.get("end", ""))),
            normalize_word(entry.get("clean_text") or entry.get("text") or entry.get("org_text") or ""),
        ]
    )
    return hashlib.sha1(raw.encode("utf-8")).hexdigest()[:16]


def variant_for(entry: dict[str, Any]) -> tuple[str, str, str]:
    word = normalize_word(entry.get("clean_text") or entry.get("text") or entry.get("org_text") or "")
    split = entry.get("_split", "all")
    key = video_key(entry)
    variant_id = safe_variant_id("MSASL", split, key)
    return word, split, variant_id


def selected_entries(entries: list[dict[str, Any]], status: dict[str, Any], resume: bool) -> list[dict[str, Any]]:
    processed = set(status.get("processedVideoKeys", [])) if resume else set()
    failed_downloads = set((status.get("failedUrls") or {}).keys()) if resume else set()
    failed_processing = set((status.get("failedProcessing") or {}).keys()) if resume else set()
    seen: set[str] = set()
    selected = []
    for entry in entries:
        word, _, _ = variant_for(entry)
        if not word:
            continue
        key = video_key(entry)
        if key in seen or key in processed or key in failed_downloads or key in failed_processing:
            continue
        seen.add(key)
        selected.append(entry)
    return selected


def update_counts(status: dict[str, Any]) -> None:
    status["counts"] = {
        "processed": len(status.get("processedVideoKeys", [])),
        "uploaded": status.get("uploadedCount", 0),
        "failedDownloads": len(status.get("failedUrls", {})),
        "failedProcessing": len(status.get("failedProcessing", {})),
    }


def is_transient_network_error(message: str) -> bool:
    lowered = message.lower()
    return any(
        token in lowered
        for token in [
            "winerror 10013",
            "failed to establish a new connection",
            "network is unreachable",
            "temporary failure in name resolution",
            "connection aborted",
        ]
    )


def process_entry(
    entry: dict[str, Any],
    db: Any,
    bucket: Any,
    bucket_name: str,
    max_frames: int,
    yt_dlp_extra_args: list[str],
) -> dict[str, Any]:
    word, split, variant_id = variant_for(entry)
    word_slug = slugify(word)
    key = video_key(entry)
    video_path = TEMP_ROOT / "videos" / f"{variant_id}.mp4"
    json_path = TEMP_ROOT / "landmarks" / word_slug / f"{variant_id}.json"
    storage_path = f"sign-landmarks/msasl/{word_slug}/{variant_id}.json"

    start_time = entry.get("start_time")
    end_time = entry.get("end_time")
    download_with_ytdlp(
        entry["url"],
        video_path,
        start_time=start_time,
        end_time=end_time,
        extra_args=yt_dlp_extra_args,
    )

    landmarks = extract_holistic_landmarks(
        video_path=video_path,
        word=word,
        dataset="MSASL",
        variant_id=variant_id,
        max_frames=max_frames,
        start_frame=entry.get("start"),
        end_frame=entry.get("end"),
    )
    if not landmarks:
        raise RuntimeError("MediaPipe Holistic produced no frames")

    landmarks["source"] = {
        "dataset": "MSASL",
        "split": split,
        "url": entry.get("url"),
        "startTime": start_time,
        "endTime": end_time,
        "label": entry.get("label"),
        "videoKey": key,
    }
    write_json(json_path, landmarks)
    upload_info = upload_json_to_storage(bucket, json_path, storage_path)

    variant = {
        "variantId": variant_id,
        "dataset": "MSASL",
        "split": split,
        "url": entry.get("url"),
        "storagePath": upload_info["storagePath"],
        "gsUrl": upload_info["gsUrl"],
        "frameCount": landmarks["frameCount"],
        "hasPose": landmarks["hasPose"],
        "hasHands": landmarks["hasHands"],
        "hasFace": landmarks["hasFace"],
        "hasMouth": landmarks["hasMouth"],
        "createdAt": datetime.now().isoformat(),
    }
    inserted = update_sign_doc_duplicate_safe(db, word, variant, "MSASL")
    cleanup_temp_files(video_path, json_path)
    return {"word": word, "variantId": variant_id, "videoKey": key, "inserted": inserted, "bucket": bucket_name}


def main() -> None:
    parser = argparse.ArgumentParser(description="Process MS-ASL clips into Firebase landmark variants.")
    parser.add_argument("--batch-size", type=int, default=25)
    parser.add_argument("--split", choices=["all", "train", "val", "test"], default="all")
    parser.add_argument("--max-frames", type=int, default=120)
    parser.add_argument("--bucket")
    parser.add_argument("--service-account", default=str(PROJECT_ROOT / "firebase-service-account.json"))
    parser.add_argument("--resume", type=lambda value: str(value).lower() not in {"false", "0", "no"}, default=True)
    parser.add_argument(
        "--yt-dlp-extra-args",
        default="",
        help='Additional yt-dlp args, e.g. "--cookies-from-browser chrome".',
    )
    args = parser.parse_args()

    if args.batch_size <= 0:
        raise SystemExit("--batch-size must be greater than 0.")

    db, bucket, bucket_name = init_firebase(args.service_account, args.bucket)
    status = load_status(STATUS_PATH)
    entries = selected_entries(load_entries(args.split), status, args.resume)
    yt_dlp_extra_args = shlex.split(args.yt_dlp_extra_args, posix=False) if args.yt_dlp_extra_args else []

    print("=" * 72)
    print("MS-ASL Firebase Batch Processor")
    print("=" * 72)
    print(f"Split: {args.split}")
    print(f"Requested successes: {args.batch_size}")
    print(f"Candidate clips: {len(entries)}")
    print(f"Bucket: {bucket_name}")
    print(f"Resume: {args.resume}")
    print("=" * 72)

    if not entries:
        print("No unprocessed MS-ASL clips found.")
        update_counts(status)
        save_status(STATUS_PATH, status)
        return

    processed_keys = set(status.get("processedVideoKeys", []))
    status.setdefault("failedUrls", {})
    status.setdefault("failedProcessing", {})
    status.setdefault("lastProcessedWords", [])
    status.setdefault("uploadedCount", 0)

    attempted = 0
    succeeded = 0
    for index, entry in enumerate(entries, start=1):
        if succeeded >= args.batch_size:
            break
        attempted += 1
        word, split, variant_id = variant_for(entry)
        key = video_key(entry)
        print(f"[attempt {attempted}, success {succeeded}/{args.batch_size}] {word} ({split})")
        try:
            result = process_entry(entry, db, bucket, bucket_name, args.max_frames, yt_dlp_extra_args)
            processed_keys.add(key)
            status["processedVideoKeys"] = sorted(processed_keys)
            status["lastProcessedWords"] = [*status.get("lastProcessedWords", [])[-24:], result["word"]]
            status["uploadedCount"] = int(status.get("uploadedCount", 0)) + 1
            succeeded += 1
            status.get("failedUrls", {}).pop(key, None)
            status.get("failedProcessing", {}).pop(key, None)
            print(f"  uploaded variant: {result['variantId']}")
        except subprocess.CalledProcessError as exc:
            message = (exc.stderr or exc.stdout or str(exc)).strip()
            if is_transient_network_error(message):
                status.setdefault("transientErrors", []).append(
                    {"word": word, "url": entry.get("url"), "error": message[:1000], "timestamp": datetime.now().isoformat()}
                )
                print(f"  transient network/download error: {message[:240]}")
                break
            status["failedUrls"][key] = {"word": word, "url": entry.get("url"), "error": message, "timestamp": datetime.now().isoformat()}
            cleanup_temp_files(TEMP_ROOT / "videos" / f"{variant_id}.mp4")
            print(f"  download failed: {message[:240]}")
        except subprocess.TimeoutExpired as exc:
            status.setdefault("failedUrls", {})[key] = {
                "word": word,
                "url": entry.get("url"),
                "error": f"yt-dlp timed out after {exc.timeout} seconds",
                "timestamp": datetime.now().isoformat(),
            }
            cleanup_temp_files(TEMP_ROOT / "videos" / f"{variant_id}.mp4")
            print(f"  download timed out after {exc.timeout} seconds")
        except Exception as exc:
            status["failedProcessing"][key] = {"word": word, "url": entry.get("url"), "error": str(exc), "timestamp": datetime.now().isoformat()}
            cleanup_temp_files(TEMP_ROOT / "videos" / f"{variant_id}.mp4", TEMP_ROOT / "landmarks" / slugify(word) / f"{variant_id}.json")
            print(f"  processing failed: {exc}")
        finally:
            update_counts(status)
            save_status(STATUS_PATH, status)

    print("Batch complete.")
    print(f"Attempted: {attempted}")
    print(f"Succeeded: {succeeded}")
    print(f"Failed downloads: {len(status.get('failedUrls', {}))}")
    print(f"Failed processing: {len(status.get('failedProcessing', {}))}")
    print(f"Status: {STATUS_PATH}")


if __name__ == "__main__":
    main()
