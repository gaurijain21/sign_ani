#!/usr/bin/env python3
"""Build fingerspelling landmark JSON from the Kaggle ASL Alphabet image dataset.

Expected input layout:
  asl_alphabet_train/
    A/*.jpg
    B/*.jpg
    ...
    Z/*.jpg

Install dependencies:
  pip install mediapipe opencv-python
"""

from __future__ import annotations

import argparse
import json
import sys
import types
from pathlib import Path
from typing import Any

LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ"
IMAGE_EXTENSIONS = {".jpg", ".jpeg", ".png", ".bmp", ".webp"}
VIDEO_EXTENSIONS = {".mp4", ".mov", ".avi", ".mkv", ".webm"}
MOTION_LETTERS = {"J", "Z"}


def landmark_list(landmarks: Any) -> list[dict[str, float]] | None:
    if not landmarks:
        return None
    return [
        {
            "x": float(point.x),
            "y": float(point.y),
            "z": float(getattr(point, "z", 0.0)),
        }
        for point in landmarks.landmark
    ]


def clone_landmarks(points: list[dict[str, float]] | None) -> list[dict[str, float]] | None:
    if points is None:
        return None
    return [dict(point) for point in points]


def make_frames(
    right_hand: list[dict[str, float]] | None,
    left_hand: list[dict[str, float]] | None,
    frame_count: int,
) -> list[dict[str, Any]]:
    return [
        {
            "leftHand": clone_landmarks(left_hand),
            "rightHand": clone_landmarks(right_hand),
            "pose": None,
        }
        for _ in range(frame_count)
    ]


def iter_images(letter_dir: Path, max_images: int) -> list[Path]:
    images = [
        path
        for path in letter_dir.iterdir()
        if path.is_file() and path.suffix.lower() in IMAGE_EXTENSIONS
    ]
    return sorted(images)[:max_images]


def iter_videos(letter_dir: Path) -> list[Path]:
    return sorted(
        path
        for path in letter_dir.iterdir()
        if path.is_file() and path.suffix.lower() in VIDEO_EXTENSIONS
    )


def parse_letters(value: str | None) -> list[str]:
    if not value:
        return list(LETTERS)

    requested = []
    for raw_letter in value.split(","):
        letter = raw_letter.strip().upper()
        if len(letter) != 1 or letter not in LETTERS:
            raise ValueError(f"Unsupported letter in --letters: {raw_letter}")
        if letter not in requested:
            requested.append(letter)
    return requested


def load_vision_dependencies() -> tuple[Any, Any]:
    # MediaPipe imports TensorFlow doc_controls as an optional docs helper in
    # some environments. A broken TensorFlow install should not block Hands
    # landmark extraction, so provide a tiny no-op doc_controls shim first.
    class _DocControls(types.ModuleType):
        def __getattr__(self, _name: str) -> Any:
            def decorator(obj: Any = None, *_args: Any, **_kwargs: Any) -> Any:
                if obj is None:
                    return lambda actual: actual
                return obj

            return decorator

    if "tensorflow.tools.docs.doc_controls" not in sys.modules:
        tensorflow_module = types.ModuleType("tensorflow")
        tools_module = types.ModuleType("tensorflow.tools")
        docs_module = types.ModuleType("tensorflow.tools.docs")
        doc_controls_module = _DocControls("tensorflow.tools.docs.doc_controls")
        docs_module.doc_controls = doc_controls_module
        tools_module.docs = docs_module
        tensorflow_module.tools = tools_module
        sys.modules.setdefault("tensorflow", tensorflow_module)
        sys.modules.setdefault("tensorflow.tools", tools_module)
        sys.modules.setdefault("tensorflow.tools.docs", docs_module)
        sys.modules.setdefault("tensorflow.tools.docs.doc_controls", doc_controls_module)

    try:
        import cv2
        import mediapipe as mp
    except ImportError as exc:
        raise RuntimeError(
            "Missing or incompatible MediaPipe/OpenCV dependencies. Install or repair them with: "
            "pip install --upgrade mediapipe opencv-python protobuf"
        ) from exc

    return cv2, mp


def extract_best_letter_pose(letter: str, letter_dir: Path, max_images: int) -> dict[str, Any] | None:
    cv2, mp = load_vision_dependencies()

    hands = mp.solutions.hands.Hands(
        static_image_mode=True,
        max_num_hands=1,
        model_complexity=1,
        min_detection_confidence=0.55,
    )
    best: dict[str, Any] | None = None

    try:
        for image_path in iter_images(letter_dir, max_images):
            image = cv2.imread(str(image_path))
            if image is None:
                continue

            rgb = cv2.cvtColor(image, cv2.COLOR_BGR2RGB)
            result = hands.process(rgb)
            if not result.multi_hand_landmarks:
                continue

            confidence = 0.0
            if result.multi_handedness:
                confidence = float(result.multi_handedness[0].classification[0].score)

            landmarks = landmark_list(result.multi_hand_landmarks[0])
            if not landmarks or len(landmarks) != 21:
                continue

            candidate = {
                "letter": letter,
                "confidence": confidence,
                "image": image_path.name,
                "rightHand": landmarks,
                "leftHand": None,
            }
            if best is None or confidence > best["confidence"]:
                best = candidate

            if confidence >= 0.9:
                break
    finally:
        hands.close()

    return best


def extract_motion_letter_frames(
    letter: str,
    video_path: Path,
    target_fps: int,
    max_frames: int,
) -> dict[str, Any] | None:
    cv2, mp = load_vision_dependencies()
    cap = cv2.VideoCapture(str(video_path))
    if not cap.isOpened():
        print(f"[buildAslAlphabetLandmarks] Unable to open video for {letter}: {video_path}")
        return None

    source_fps = cap.get(cv2.CAP_PROP_FPS) or target_fps
    sample_step = max(1, round(source_fps / max(1, target_fps)))
    frames: list[dict[str, Any]] = []
    confidences: list[float] = []

    hands = mp.solutions.hands.Hands(
        static_image_mode=False,
        max_num_hands=1,
        model_complexity=1,
        min_detection_confidence=0.5,
        min_tracking_confidence=0.5,
    )

    frame_index = 0
    try:
        while len(frames) < max_frames:
            ok, image = cap.read()
            if not ok:
                break

            if frame_index % sample_step != 0:
                frame_index += 1
                continue

            rgb = cv2.cvtColor(image, cv2.COLOR_BGR2RGB)
            result = hands.process(rgb)
            frame_index += 1

            if not result.multi_hand_landmarks:
                continue

            landmarks = landmark_list(result.multi_hand_landmarks[0])
            if not landmarks or len(landmarks) != 21:
                continue

            confidence = 0.0
            if result.multi_handedness:
                confidence = float(result.multi_handedness[0].classification[0].score)
                confidences.append(confidence)

            frames.append({
                "leftHand": None,
                "rightHand": landmarks,
                "pose": None,
            })
    finally:
        hands.close()
        cap.release()

    if not frames:
        return None

    return {
        "letter": letter,
        "video": video_path.name,
        "frames": frames,
        "sourceFps": source_fps,
        "confidence": sum(confidences) / len(confidences) if confidences else 0.0,
    }


def write_letter_json(output_dir: Path, pose: dict[str, Any], frame_count: int, fps: int) -> None:
    letter = pose["letter"]
    output = {
        "word": letter,
        "fps": fps,
        "frames": make_frames(pose["rightHand"], pose["leftHand"], frame_count),
        "source": "fingerspelling",
        "metadata": {
            "type": "fingerspell_letter",
            "source": "kaggle_asl_alphabet",
            "letter": letter,
            "confidence": pose["confidence"],
            "image": pose["image"],
        },
    }

    output_dir.mkdir(parents=True, exist_ok=True)
    with (output_dir / f"{letter}.json").open("w", encoding="utf-8") as handle:
        json.dump(output, handle, indent=2)
        handle.write("\n")


def write_motion_letter_json(output_dir: Path, motion: dict[str, Any], fps: int) -> None:
    letter = motion["letter"]
    frame_count = len(motion["frames"])
    output = {
        "word": letter,
        "type": "fingerspell_letter",
        "isMotionLetter": True,
        "fps": fps,
        "frames": motion["frames"],
        "source": "fingerspelling",
        "metadata": {
            "type": "fingerspell_letter",
            "source": "kaggle_asl_alphabet_video",
            "letter": letter,
            "inputFile": motion["video"],
            "frameCount": frame_count,
            "sourceFps": motion["sourceFps"],
            "confidence": motion["confidence"],
            "isMotionLetter": True,
        },
    }

    output_dir.mkdir(parents=True, exist_ok=True)
    with (output_dir / f"{letter}.json").open("w", encoding="utf-8") as handle:
        json.dump(output, handle, indent=2)
        handle.write("\n")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", required=True, help="Path to Kaggle asl_alphabet_train folder")
    parser.add_argument("--output", default="public/data/fingerspelling")
    parser.add_argument("--letters", help="Comma-separated letters to process, for example J,Z")
    parser.add_argument("--prefer-video", action="store_true", help="Use MP4/video input when present for motion letters")
    parser.add_argument("--max-images", type=int, default=200)
    parser.add_argument("--video-fps", type=int, default=12)
    parser.add_argument("--max-video-frames", type=int, default=24)
    parser.add_argument("--min-video-frames", type=int, default=3)
    parser.add_argument("--frames-per-letter", type=int, default=8)
    parser.add_argument("--fps", type=int, default=12)
    args = parser.parse_args()

    input_dir = Path(args.input).expanduser().resolve()
    output_dir = Path(args.output)
    letters = parse_letters(args.letters)
    failed: list[str] = []

    for letter in letters:
        letter_dir = input_dir / letter
        if not letter_dir.exists():
            print(f"[buildAslAlphabetLandmarks] Missing folder for {letter}: {letter_dir}")
            failed.append(letter)
            continue

        videos = iter_videos(letter_dir)
        if args.prefer_video and letter in MOTION_LETTERS:
            if not videos:
                print(
                    f"[buildAslAlphabetLandmarks] No MP4/video found for motion letter {letter}; "
                    "leaving existing JSON unchanged."
                )
                failed.append(letter)
                continue

            motion = extract_motion_letter_frames(letter, videos[0], args.video_fps, args.max_video_frames)
            valid_frames = len(motion["frames"]) if motion else 0
            if not motion or valid_frames < args.min_video_frames:
                print(
                    f"[buildAslAlphabetLandmarks] Only {valid_frames} valid video frames for {letter}; "
                    f"need at least {args.min_video_frames}. Existing JSON left unchanged."
                )
                failed.append(letter)
                continue

            write_motion_letter_json(output_dir, motion, args.video_fps)
            print(
                f"[buildAslAlphabetLandmarks] {letter}: {videos[0].name} "
                f"motionFrames={valid_frames} confidence={motion['confidence']:.3f}"
            )
            continue

        pose = extract_best_letter_pose(letter, letter_dir, args.max_images)
        if pose is None:
            print(f"[buildAslAlphabetLandmarks] No clean landmark detection for {letter}; continuing.")
            failed.append(letter)
            continue

        write_letter_json(output_dir, pose, args.frames_per_letter, args.fps)
        print(
            f"[buildAslAlphabetLandmarks] {letter}: {pose['image']} "
            f"confidence={pose['confidence']:.3f}"
        )

    if failed:
        print(f"[buildAslAlphabetLandmarks] Failed letters: {', '.join(failed)}")
    print(f"[buildAslAlphabetLandmarks] output: {output_dir}")


if __name__ == "__main__":
    main()
