#!/usr/bin/env python3
"""Regenerate WLASL landmark variants with MediaPipe Holistic face/mouth data."""

import argparse
import json
from datetime import datetime
from pathlib import Path
from typing import Any

from build_manifest import find_metadata
from sign_landmark_utils import (
    cleanup_temp_files,
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
WLASL_ROOT = PROJECT_ROOT / "WLASL"
STATUS_PATH = PROJECT_ROOT / "data" / "wlasl_face_regen_status.json"
TEMP_ROOT = PROJECT_ROOT / "data" / "temp_wlasl_face"


def load_wlasl_metadata(wlasl_path: Path) -> list[dict[str, Any]]:
    with find_metadata(wlasl_path).open("r", encoding="utf-8") as handle:
        return json.load(handle)


def iter_available_instances(wlasl_path: Path, metadata: list[dict[str, Any]]) -> list[dict[str, Any]]:
    videos_dir = wlasl_path / "start_kit" / "videos"
    rows = []
    for item in metadata:
        word = normalize_word(item.get("gloss", ""))
        if not word:
            continue
        for instance in item.get("instances", []):
            video_id = str(instance.get("video_id", "")).strip()
            if not video_id:
                continue
            video_path = videos_dir / f"{video_id}.mp4"
            if video_path.exists():
                row = dict(instance)
                row["_word"] = word
                row["_videoPath"] = str(video_path)
                row["_split"] = str(instance.get("split") or "wlasl")
                rows.append(row)
    return rows


def variant_for(instance: dict[str, Any]) -> tuple[str, str, str, Path]:
    word = normalize_word(instance["_word"])
    split = str(instance.get("_split") or "wlasl")
    video_id = str(instance.get("video_id"))
    variant_id = safe_variant_id("WLASL", split, video_id)
    return word, split, variant_id, Path(instance["_videoPath"])


def selected_instances(instances: list[dict[str, Any]], status: dict[str, Any]) -> list[dict[str, Any]]:
    processed = set(status.get("processedVideoKeys", []))
    failed = set((status.get("failedProcessing") or {}).keys())
    selected = []
    for instance in instances:
        _, _, variant_id, _ = variant_for(instance)
        if variant_id in processed or variant_id in failed:
            continue
        selected.append(instance)
    return selected


def update_counts(status: dict[str, Any]) -> None:
    status["counts"] = {
        "processed": len(status.get("processedVideoKeys", [])),
        "uploaded": status.get("uploadedCount", 0),
        "failedProcessing": len(status.get("failedProcessing", {})),
    }


def process_instance(
    instance: dict[str, Any],
    db: Any,
    bucket: Any,
    bucket_name: str,
    max_frames: int,
    delete_local_temp: bool,
) -> dict[str, Any]:
    word, split, variant_id, video_path = variant_for(instance)
    word_slug = slugify(word)
    json_path = TEMP_ROOT / "landmarks" / word_slug / f"{variant_id}.json"
    storage_path = f"sign-landmarks/wlasl/{word_slug}/{variant_id}.json"

    landmarks = extract_holistic_landmarks(
        video_path=video_path,
        word=word,
        dataset="WLASL",
        variant_id=variant_id,
        max_frames=max_frames,
    )
    if not landmarks:
        raise RuntimeError("MediaPipe Holistic produced no frames")

    landmarks["source"] = {
        "dataset": "WLASL",
        "split": split,
        "videoId": instance.get("video_id"),
        "url": instance.get("url"),
        "videoPath": str(video_path),
    }
    write_json(json_path, landmarks)
    upload_info = upload_json_to_storage(bucket, json_path, storage_path)

    variant = {
        "variantId": variant_id,
        "dataset": "WLASL",
        "split": split,
        "url": instance.get("url"),
        "storagePath": upload_info["storagePath"],
        "gsUrl": upload_info["gsUrl"],
        "frameCount": landmarks["frameCount"],
        "hasPose": landmarks["hasPose"],
        "hasHands": landmarks["hasHands"],
        "hasFace": landmarks["hasFace"],
        "hasMouth": landmarks["hasMouth"],
        "createdAt": datetime.now().isoformat(),
    }
    inserted = update_sign_doc_duplicate_safe(db, word, variant, "WLASL")
    if delete_local_temp:
        cleanup_temp_files(json_path)
    return {"word": word, "variantId": variant_id, "inserted": inserted, "bucket": bucket_name}


def main() -> None:
    parser = argparse.ArgumentParser(description="Regenerate WLASL Firebase variants with face and mouth landmarks.")
    parser.add_argument("--batch-size", type=int, default=25)
    parser.add_argument("--max-frames", type=int, default=120)
    parser.add_argument("--service-account", default=str(PROJECT_ROOT / "firebase-service-account.json"))
    parser.add_argument("--bucket")
    parser.add_argument("--delete-local-temp", action="store_true")
    parser.add_argument("--wlasl-path", type=Path, default=WLASL_ROOT)
    args = parser.parse_args()

    if args.batch_size <= 0:
        raise SystemExit("--batch-size must be greater than 0.")

    wlasl_path = args.wlasl_path.resolve()
    db, bucket, bucket_name = init_firebase(args.service_account, args.bucket)
    status = load_status(STATUS_PATH)
    instances = selected_instances(iter_available_instances(wlasl_path, load_wlasl_metadata(wlasl_path)), status)
    batch = instances[: args.batch_size]

    print("=" * 72)
    print("WLASL Holistic Face Regenerator")
    print("=" * 72)
    print(f"Batch size: {len(batch)}")
    print(f"Bucket: {bucket_name}")
    print(f"Delete local temp JSON: {args.delete_local_temp}")
    print("=" * 72)

    if not batch:
        print("No unprocessed local WLASL videos found.")
        update_counts(status)
        save_status(STATUS_PATH, status)
        return

    processed_keys = set(status.get("processedVideoKeys", []))
    status.setdefault("failedProcessing", {})
    status.setdefault("lastProcessedWords", [])
    status.setdefault("uploadedCount", 0)

    for index, instance in enumerate(batch, start=1):
        word, _, variant_id, video_path = variant_for(instance)
        print(f"[{index}/{len(batch)}] {word} ({video_path.name})")
        try:
            result = process_instance(instance, db, bucket, bucket_name, args.max_frames, args.delete_local_temp)
            processed_keys.add(variant_id)
            status["processedVideoKeys"] = sorted(processed_keys)
            status["uploadedCount"] = int(status.get("uploadedCount", 0)) + 1
            status["lastProcessedWords"] = [*status.get("lastProcessedWords", [])[-24:], result["word"]]
            status["failedProcessing"].pop(variant_id, None)
            print(f"  uploaded variant: {result['variantId']}")
        except Exception as exc:
            status["failedProcessing"][variant_id] = {
                "word": word,
                "videoPath": str(video_path),
                "error": str(exc),
                "timestamp": datetime.now().isoformat(),
            }
            print(f"  failed: {exc}")
        finally:
            update_counts(status)
            save_status(STATUS_PATH, status)

    print("Batch complete.")
    print(f"Status: {STATUS_PATH}")


if __name__ == "__main__":
    main()
