#!/usr/bin/env python3
"""
WLASL Dataset Setup Script

This script helps set up the WLASL dataset for the ASL visualization project.
It downloads video samples and organizes them for processing.

Requirements:
    pip install requests tqdm

Usage:
    python setup_dataset.py --output ./raw_dataset --words hello,yes,no,please
    python setup_dataset.py --output ./raw_dataset --common 100
"""

import argparse
import json
import os
import sys
from pathlib import Path
from typing import Optional
from urllib.parse import urlparse

try:
    import requests
    from tqdm import tqdm
except ImportError:
    print("Missing dependencies. Please install:")
    print("  pip install requests tqdm")
    sys.exit(1)


# Common ASL words for the project
COMMON_WORDS = [
    "hello", "thank you", "yes", "no", "please", "sorry", "help", "friend",
    "love", "eat", "drink", "happy", "sad", "good", "bad", "water", "food",
    "home", "family", "mother", "father", "baby", "work", "school", "learn",
    "understand", "know", "want", "need", "like", "name", "what", "where",
    "when", "why", "how", "who", "more", "again", "stop", "go", "come",
    "sit", "stand", "walk", "run", "sleep", "wake", "morning", "night",
    "today", "tomorrow", "yesterday", "week", "month", "year", "time", "day",
    "hot", "cold", "big", "small", "new", "old", "beautiful", "easy", "hard",
    "fast", "slow", "right", "wrong", "true", "false", "same", "different",
    "all", "many", "few", "one", "two", "three", "four", "five", "book",
    "read", "write", "sign", "language", "deaf", "hearing", "speak", "say",
    "ask", "answer", "think", "feel", "see", "look", "watch", "wait",
    "finish", "start", "try", "practice"
]


WLASL_JSON_URL = "https://raw.githubusercontent.com/dxli94/WLASL/master/start_kit/WLASL_v0.3.json"


def download_file(url: str, output_path: Path, timeout: int = 30) -> bool:
    """
    Download a file from URL to output path.
    
    Args:
        url: URL to download from
        output_path: Path to save the file
        timeout: Request timeout in seconds
    
    Returns:
        True if successful, False otherwise
    """
    try:
        response = requests.get(url, stream=True, timeout=timeout)
        response.raise_for_status()
        
        total_size = int(response.headers.get('content-length', 0))
        
        with open(output_path, 'wb') as f:
            if total_size:
                with tqdm(total=total_size, unit='B', unit_scale=True, desc=output_path.name) as pbar:
                    for chunk in response.iter_content(chunk_size=8192):
                        f.write(chunk)
                        pbar.update(len(chunk))
            else:
                for chunk in response.iter_content(chunk_size=8192):
                    f.write(chunk)
        
        return True
    except Exception as e:
        print(f"Error downloading {url}: {e}")
        return False


def load_wlasl_metadata(cache_dir: Path) -> Optional[list]:
    """
    Load WLASL metadata JSON, downloading if necessary.
    
    Args:
        cache_dir: Directory to cache the metadata file
    
    Returns:
        List of word entries, or None if failed
    """
    cache_dir.mkdir(parents=True, exist_ok=True)
    metadata_path = cache_dir / "WLASL_v0.3.json"
    
    if not metadata_path.exists():
        print("Downloading WLASL metadata...")
        if not download_file(WLASL_JSON_URL, metadata_path):
            return None
    
    try:
        with open(metadata_path) as f:
            return json.load(f)
    except Exception as e:
        print(f"Error loading metadata: {e}")
        return None


def find_word_videos(metadata: list, word: str) -> list[dict]:
    """
    Find video entries for a specific word in WLASL metadata.
    
    Args:
        metadata: WLASL metadata list
        word: Word to search for
    
    Returns:
        List of video instances for the word
    """
    word_lower = word.lower().replace(" ", "_")
    
    for entry in metadata:
        gloss = entry.get("gloss", "").lower().replace(" ", "_")
        if gloss == word_lower:
            return entry.get("instances", [])
    
    return []


def setup_dataset(
    output_dir: str,
    words: list[str],
    max_videos_per_word: int = 1
) -> tuple[int, int]:
    """
    Set up the dataset by creating placeholder structure.
    
    Note: Due to YouTube video availability, this script creates a placeholder
    structure. Users should manually download videos or use alternative sources.
    
    Args:
        output_dir: Output directory for videos
        words: List of words to include
        max_videos_per_word: Maximum videos per word
    
    Returns:
        Tuple of (found_count, missing_count)
    """
    output_path = Path(output_dir)
    output_path.mkdir(parents=True, exist_ok=True)
    
    # Load WLASL metadata
    cache_dir = output_path.parent / ".wlasl_cache"
    metadata = load_wlasl_metadata(cache_dir)
    
    if metadata is None:
        print("Failed to load WLASL metadata")
        return 0, len(words)
    
    print(f"\nSetting up dataset for {len(words)} words...")
    print("-" * 50)
    
    found = 0
    missing = 0
    video_info = []
    
    for word in words:
        videos = find_word_videos(metadata, word)
        
        if videos:
            found += 1
            # Store video info for reference
            video_info.append({
                "word": word,
                "video_count": len(videos),
                "sample_url": videos[0].get("url", "N/A") if videos else "N/A"
            })
            print(f"  {word}: {len(videos)} videos available")
        else:
            missing += 1
            print(f"  {word}: Not found in WLASL")
    
    # Create info file
    info_path = output_path / "dataset_info.json"
    with open(info_path, 'w') as f:
        json.dump({
            "source": "WLASL Dataset",
            "repository": "https://github.com/dxli94/WLASL",
            "words_requested": words,
            "words_found": found,
            "words_missing": missing,
            "video_info": video_info,
            "notes": [
                "This is a placeholder structure for the WLASL dataset.",
                "Videos need to be downloaded manually or using the WLASL download tools.",
                "Place downloaded videos in this directory with the format: {word}.mp4",
                "Then run extract_landmarks.py to process the videos."
            ]
        }, f, indent=2)
    
    # Create placeholder README
    readme_path = output_path / "README.md"
    with open(readme_path, 'w') as f:
        f.write("""# Raw Dataset Directory

This directory should contain ASL video files for processing.

## Expected Format

- Video files should be named after the sign word: `hello.mp4`, `yes.mp4`, etc.
- Supported formats: .mp4, .avi, .mov, .mkv, .webm
- Videos should clearly show the signer performing a single sign

## Downloading Videos

The WLASL dataset videos are sourced from YouTube. To download:

1. Visit the [WLASL repository](https://github.com/dxli94/WLASL)
2. Follow their instructions to download the video dataset
3. Place relevant videos in this directory

## Processing

After adding videos, run the extraction script:

```bash
python scripts/extract_landmarks.py --input ./raw_dataset --output ./data/signs
```

## Notes

- Some videos may no longer be available on YouTube
- Ensure you comply with YouTube's Terms of Service and any applicable licenses
- This project is for educational/research purposes only
""")
    
    print("-" * 50)
    print(f"\nDataset info saved to: {info_path}")
    print(f"README created at: {readme_path}")
    print(f"\nFound: {found} words, Missing: {missing} words")
    print("\nNext steps:")
    print("1. Download ASL videos for the words you want to use")
    print("2. Place them in the raw_dataset directory")
    print("3. Run: python scripts/extract_landmarks.py -i ./raw_dataset -o ./data/signs")
    
    return found, missing


def main():
    parser = argparse.ArgumentParser(
        description="Set up WLASL dataset for ASL visualization project"
    )
    parser.add_argument(
        "--output", "-o",
        default="./raw_dataset",
        help="Output directory for dataset (default: ./raw_dataset)"
    )
    parser.add_argument(
        "--words", "-w",
        help="Comma-separated list of words to include"
    )
    parser.add_argument(
        "--common", "-c",
        type=int,
        default=0,
        help="Include first N common words (default: 0, max: 100)"
    )
    
    args = parser.parse_args()
    
    # Determine words to include
    words = []
    
    if args.words:
        words.extend([w.strip() for w in args.words.split(",")])
    
    if args.common > 0:
        words.extend(COMMON_WORDS[:min(args.common, len(COMMON_WORDS))])
    
    # Remove duplicates while preserving order
    seen = set()
    words = [w for w in words if not (w in seen or seen.add(w))]
    
    if not words:
        # Default to common words
        words = COMMON_WORDS[:20]
        print("No words specified, using 20 common words")
    
    print("=" * 50)
    print("WLASL Dataset Setup")
    print("=" * 50)
    
    found, missing = setup_dataset(args.output, words)
    
    print("=" * 50)
    print("Setup complete!")
    print("=" * 50)


if __name__ == "__main__":
    main()
