#!/usr/bin/env python3
"""
Build /data/signManifest.json from a local WLASL checkout.

Official WLASL setup:
  git clone https://github.com/dxli94/WLASL.git
  cd WLASL/start_kit
  pip install yt-dlp
  python video_downloader.py
  python preprocess.py

After preprocessing, this script expects extracted samples under:
  WLASL/start_kit/videos/
"""

import argparse
import json
import re
import sys
from datetime import datetime
from pathlib import Path
from typing import Any


VIDEO_EXTENSIONS = {".mp4", ".avi", ".mov", ".mkv", ".webm"}


def normalize_word(value: str) -> str:
    return " ".join(value.strip().lower().split())


def safe_sign_filename(word: str) -> str:
    safe = re.sub(r"[^a-z0-9]+", "_", normalize_word(word))
    return safe.strip("_") or "sign"


def load_json(path: Path) -> Any:
    with path.open("r", encoding="utf-8") as handle:
        return json.load(handle)


def find_metadata(wlasl_path: Path) -> Path:
    candidates = [
        wlasl_path / "start_kit" / "WLASL_v0.3.json",
        wlasl_path / "WLASL_v0.3.json",
    ]

    for candidate in candidates:
        if candidate.exists():
            return candidate

    for candidate in wlasl_path.rglob("*.json"):
        try:
            data = load_json(candidate)
        except (OSError, json.JSONDecodeError):
            continue
        if isinstance(data, list) and data and {"gloss", "instances"} <= set(data[0]):
            return candidate

    raise FileNotFoundError(
        "Could not find WLASL_v0.3.json. Clone WLASL and run from the repository root path."
    )


def video_directory(wlasl_path: Path) -> Path:
    return wlasl_path / "start_kit" / "videos"


def scan_videos(videos_path: Path) -> dict[str, Path]:
    if not videos_path.exists():
        return {}

    videos: dict[str, Path] = {}
    for file_path in videos_path.rglob("*"):
        if file_path.is_file() and file_path.suffix.lower() in VIDEO_EXTENSIONS:
            videos[file_path.stem.lower()] = file_path
    return videos


def scan_landmarks(signs_path: Path) -> set[str]:
    if not signs_path.exists():
        return set()
    return {file_path.stem.lower() for file_path in signs_path.glob("*.json")}


def relative_to_repo(path: Path, repo_root: Path) -> str:
    try:
        return path.relative_to(repo_root).as_posix()
    except ValueError:
        return path.as_posix()


def matching_videos(entry: dict[str, Any], videos_by_stem: dict[str, Path]) -> list[Path]:
    gloss = normalize_word(entry.get("gloss", ""))
    safe_gloss = safe_sign_filename(gloss)
    matches: list[Path] = []
    seen: set[Path] = set()

    def add(stem: str) -> None:
        video = videos_by_stem.get(stem.lower())
        if video and video not in seen:
            seen.add(video)
            matches.append(video)

    for instance in entry.get("instances", []):
        video_id = str(instance.get("video_id", "")).strip()
        if video_id:
            add(video_id)

    add(gloss)
    add(gloss.replace(" ", "_"))
    add(safe_gloss)

    return matches


def build_manifest(wlasl_path: Path, signs_path: Path, output_path: Path) -> dict[str, Any]:
    metadata_path = find_metadata(wlasl_path)
    videos_path = video_directory(wlasl_path)
    metadata = load_json(metadata_path)
    videos_by_stem = scan_videos(videos_path)
    landmark_files = scan_landmarks(signs_path)

    entries: dict[str, Any] = {}

    for item in metadata:
        gloss = normalize_word(item.get("gloss", ""))
        if not gloss:
            continue

        word = gloss
        file_stem = safe_sign_filename(word)
        video_matches = matching_videos(item, videos_by_stem)
        video_paths = [relative_to_repo(path, wlasl_path) for path in video_matches]
        landmarks_available = file_stem in landmark_files or word in landmark_files
        json_path = f"/data/signs/{file_stem}.json" if landmarks_available else f"/data/signs/{file_stem}.json"

        entries[word] = {
            "word": word,
            "gloss": item.get("gloss", word),
            "videoPath": video_paths[0] if video_paths else None,
            "videoPaths": video_paths,
            "jsonPath": json_path,
            "available": bool(video_paths),
            "videoAvailable": bool(video_paths),
            "landmarksAvailable": landmarks_available,
            "instanceCount": len(item.get("instances", [])),
        }

    stats = {
        "totalWlaslWords": len(entries),
        "videosDownloaded": sum(1 for entry in entries.values() if entry["videoAvailable"]),
        "landmarksGenerated": sum(1 for entry in entries.values() if entry["landmarksAvailable"]),
    }

    manifest = {
        "version": "1.0.0",
        "generatedAt": datetime.now().isoformat(),
        "wlaslPath": str(wlasl_path.resolve()),
        "metadataPath": str(metadata_path.resolve()),
        "videosPath": str(videos_path.resolve()),
        "stats": stats,
        "entries": dict(sorted(entries.items())),
    }

    output_path.parent.mkdir(parents=True, exist_ok=True)
    with output_path.open("w", encoding="utf-8") as handle:
        json.dump(manifest, handle, indent=2)
        handle.write("\n")

    print("WLASL manifest built")
    print(f"  Metadata: {metadata_path}")
    print(f"  Videos: {videos_path}")
    print(f"  Total WLASL words found: {stats['totalWlaslWords']}")
    print(f"  Videos downloaded: {stats['videosDownloaded']}")
    print(f"  Landmark animations generated: {stats['landmarksGenerated']}")
    print(f"  Output: {output_path}")
    return manifest


def main() -> None:
    project_root = Path(__file__).resolve().parents[1]
    parser = argparse.ArgumentParser(description="Build signManifest.json from WLASL metadata and videos.")
    parser.add_argument("--wlasl-path", "-w", default=str(project_root / "WLASL"), help="Path to WLASL repo root.")
    parser.add_argument("--signs-path", "-s", default=str(project_root / "data" / "signs"), help="Path to generated landmark JSON files.")
    parser.add_argument("--output", "-o", default=str(project_root / "data" / "signManifest.json"), help="Manifest output path.")
    args = parser.parse_args()

    wlasl_path = Path(args.wlasl_path).resolve()
    if not wlasl_path.exists():
        print(f"ERROR: WLASL path does not exist: {wlasl_path}")
        print("Clone it first: git clone https://github.com/dxli94/WLASL.git")
        sys.exit(1)

    build_manifest(
        wlasl_path=wlasl_path,
        signs_path=Path(args.signs_path).resolve(),
        output_path=Path(args.output).resolve(),
    )


if __name__ == "__main__":
    main()
