#!/usr/bin/env python3
"""
ASL Video Landmark Extraction Script

This script processes ASL video files and extracts hand and pose landmarks
plus face and mouth landmarks using MediaPipe Holistic. The extracted
landmarks are saved as JSON files that can be used by the frontend avatar
animation system.

This script can work with the WLASL manifest or process videos directly.

Requirements:
    pip install mediapipe opencv-python numpy

Usage:
    # Process all videos from manifest
    python extract_landmarks.py --manifest ../data/signManifest.json --output ../data/signs
    
    # Process a single video
    python extract_landmarks.py --input ./video.mp4 --output ./data/signs/word.json
    
    # Process a directory of videos
    python extract_landmarks.py --input ./videos --output ./data/signs
"""

import argparse
import json
import os
import re
import sys
from pathlib import Path
from typing import Optional

import cv2
import mediapipe as mp
import numpy as np


# MediaPipe setup
mp_hands = mp.solutions.hands
mp_pose = mp.solutions.pose
mp_holistic = mp.solutions.holistic

MOUTH_LANDMARK_INDICES = sorted({
    0, 13, 14, 17, 37, 39, 40, 61, 78, 80, 81, 82, 84, 87, 88, 91,
    95, 146, 178, 181, 185, 191, 267, 269, 270, 291, 308, 310, 311,
    312, 314, 317, 318, 321, 324, 375, 402, 405, 409, 415,
})
OUTER_LIP_COUNT = 21


def normalize_word(value: str) -> str:
    return " ".join(value.strip().lower().split())


def safe_sign_filename(word: str) -> str:
    safe = re.sub(r"[^a-z0-9]+", "_", normalize_word(word))
    return safe.strip("_") or "sign"


def smooth_landmarks(landmarks_sequence: list, window_size: int = 3) -> list:
    """
    Apply simple moving average smoothing to landmark sequences.
    
    Args:
        landmarks_sequence: List of landmark frames
        window_size: Size of smoothing window (default: 3)
    
    Returns:
        Smoothed landmark sequence
    """
    if len(landmarks_sequence) < window_size:
        return landmarks_sequence
    
    smoothed = []
    half_window = window_size // 2
    
    for i in range(len(landmarks_sequence)):
        start_idx = max(0, i - half_window)
        end_idx = min(len(landmarks_sequence), i + half_window + 1)
        
        frame_window = landmarks_sequence[start_idx:end_idx]
        
        if frame_window[0] is None:
            smoothed.append(None)
            continue
        
        # Average the landmarks in the window
        avg_frame = []
        num_landmarks = len(frame_window[0])
        
        for j in range(num_landmarks):
            valid_points = [
                f[j] for f in frame_window 
                if f is not None and j < len(f) and f[j] is not None
            ]
            
            if valid_points:
                avg_x = sum(p['x'] for p in valid_points) / len(valid_points)
                avg_y = sum(p['y'] for p in valid_points) / len(valid_points)
                avg_z = sum(p.get('z', 0) for p in valid_points) / len(valid_points)
                avg_frame.append({'x': avg_x, 'y': avg_y, 'z': avg_z})
            else:
                avg_frame.append(None)
        
        smoothed.append(avg_frame)
    
    return smoothed


def interpolate_missing(landmarks_sequence: list) -> list:
    """
    Interpolate missing landmarks using neighboring frames.
    
    Args:
        landmarks_sequence: List of landmark frames (may contain None values)
    
    Returns:
        Interpolated landmark sequence
    """
    if not landmarks_sequence:
        return landmarks_sequence
    
    result = landmarks_sequence.copy()
    
    # Find runs of None values and interpolate
    i = 0
    while i < len(result):
        if result[i] is None:
            # Find the start and end of the None run
            start = i
            while i < len(result) and result[i] is None:
                i += 1
            end = i
            
            # Get surrounding valid frames
            prev_frame = result[start - 1] if start > 0 else None
            next_frame = result[end] if end < len(result) else None
            
            # Interpolate
            if prev_frame is not None and next_frame is not None:
                for j in range(start, end):
                    t = (j - start + 1) / (end - start + 1)
                    interpolated = []
                    for k in range(len(prev_frame)):
                        if prev_frame[k] is not None and next_frame[k] is not None:
                            interpolated.append({
                                'x': prev_frame[k]['x'] + (next_frame[k]['x'] - prev_frame[k]['x']) * t,
                                'y': prev_frame[k]['y'] + (next_frame[k]['y'] - prev_frame[k]['y']) * t,
                                'z': prev_frame[k].get('z', 0) + (next_frame[k].get('z', 0) - prev_frame[k].get('z', 0)) * t
                            })
                        else:
                            interpolated.append(prev_frame[k] if prev_frame[k] is not None else next_frame[k])
                    result[j] = interpolated
            elif prev_frame is not None:
                for j in range(start, end):
                    result[j] = prev_frame
            elif next_frame is not None:
                for j in range(start, end):
                    result[j] = next_frame
        else:
            i += 1
    
    return result


def normalize_landmarks(landmarks: list, image_width: int, image_height: int) -> list:
    """
    Normalize landmark coordinates to 0-1 range.
    
    Args:
        landmarks: List of landmark points
        image_width: Width of source image
        image_height: Height of source image
    
    Returns:
        Normalized landmarks
    """
    if landmarks is None:
        return None
    
    normalized = []
    for lm in landmarks:
        if lm is None:
            normalized.append(None)
        else:
            normalized.append({
                'x': lm.x if hasattr(lm, 'x') else lm['x'],
                'y': lm.y if hasattr(lm, 'y') else lm['y'],
                'z': lm.z if hasattr(lm, 'z') else lm.get('z', 0)
            })
    
    return normalized


def extract_mouth_landmarks(face_landmarks: list | None) -> list | None:
    if not face_landmarks:
        return None
    return [
        face_landmarks[index]
        for index in MOUTH_LANDMARK_INDICES
        if index < len(face_landmarks)
    ]


def clone_frame(frame: list | None) -> list | None:
    if frame is None:
        return None
    return [
        None if point is None else {"x": point["x"], "y": point["y"], "z": point.get("z", 0)}
        for point in frame
    ]


def fill_missing_mouth_frames(mouth_frames: list) -> tuple[list, int, int]:
    """Fill gaps using nearby frames, preferring interpolation then carry-forward."""
    if not mouth_frames:
        return mouth_frames, 0, 0

    result = [clone_frame(frame) for frame in mouth_frames]
    interpolated = 0

    for index, frame in enumerate(result):
        if frame is not None:
            continue

        prev_index = index - 1
        while prev_index >= 0 and result[prev_index] is None:
            prev_index -= 1

        next_index = index + 1
        while next_index < len(result) and result[next_index] is None:
            next_index += 1

        prev_frame = result[prev_index] if prev_index >= 0 else None
        next_frame = result[next_index] if next_index < len(result) else None

        if prev_frame is not None and next_frame is not None:
            t = (index - prev_index) / max(1, next_index - prev_index)
            filled = []
            for landmark_index in range(len(prev_frame)):
                prev_point = prev_frame[landmark_index]
                next_point = next_frame[landmark_index] if landmark_index < len(next_frame) else None
                if prev_point is None and next_point is None:
                    filled.append(None)
                elif prev_point is None:
                    filled.append(next_point)
                elif next_point is None:
                    filled.append(prev_point)
                else:
                    filled.append({
                        "x": prev_point["x"] + (next_point["x"] - prev_point["x"]) * t,
                        "y": prev_point["y"] + (next_point["y"] - prev_point["y"]) * t,
                        "z": prev_point.get("z", 0) + (next_point.get("z", 0) - prev_point.get("z", 0)) * t,
                    })
            result[index] = filled
            interpolated += 1
        elif prev_frame is not None:
            result[index] = clone_frame(prev_frame)
            interpolated += 1
        elif next_frame is not None:
            result[index] = clone_frame(next_frame)
            interpolated += 1

    missing = sum(1 for frame in result if frame is None)
    return result, interpolated, missing


def compute_mouth_movement_score(mouth_frames: list) -> float:
    valid_frames = [frame for frame in mouth_frames if frame]
    if len(valid_frames) < 2:
        return 0.0

    widths = []
    heights = []
    centers = []
    for frame in valid_frames:
        xs = [point["x"] for point in frame if point is not None]
        ys = [point["y"] for point in frame if point is not None]
        if not xs or not ys:
            continue
        min_x = min(xs)
        max_x = max(xs)
        min_y = min(ys)
        max_y = max(ys)
        widths.append(max_x - min_x)
        heights.append(max_y - min_y)
        centers.append(((min_x + max_x) / 2, (min_y + max_y) / 2))

    if len(widths) < 2 or len(heights) < 2:
        return 0.0

    width_range = max(widths) - min(widths)
    height_range = max(heights) - min(heights)
    center_motion = 0.0
    for previous, current in zip(centers, centers[1:]):
        center_motion += abs(current[0] - previous[0]) + abs(current[1] - previous[1])
    center_motion /= max(1, len(centers) - 1)

    return round(width_range * 1200 + height_range * 1800 + center_motion * 600, 4)


def extract_landmarks_from_video(
    video_path: str,
    word: Optional[str] = None,
    target_fps: int = 30,
    min_detection_confidence: float = 0.5,
    min_tracking_confidence: float = 0.5
) -> Optional[dict]:
    """
    Extract hand, pose, face, and mouth landmarks from a video file.
    
    Args:
        video_path: Path to the video file
        target_fps: Target frames per second for output
        min_detection_confidence: Minimum confidence for detection
        min_tracking_confidence: Minimum confidence for tracking
    
    Returns:
        Dictionary containing extracted landmark data, or None if extraction fails
    """
    cap = cv2.VideoCapture(video_path)
    
    if not cap.isOpened():
        print(f"Error: Could not open video file: {video_path}")
        return None
    
    # Get video properties
    original_fps = cap.get(cv2.CAP_PROP_FPS)
    frame_count = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
    width = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
    height = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
    
    if original_fps <= 0:
        original_fps = 30  # Default if FPS detection fails
    
    # Calculate frame sampling rate
    frame_interval = max(1, int(original_fps / target_fps))
    
    print(f"Processing: {video_path}")
    print(f"  Original: {frame_count} frames at {original_fps:.1f} FPS")
    print(f"  Target: ~{frame_count // frame_interval} frames at {target_fps} FPS")
    
    # Initialize landmark sequences. Keep pose/hand keys unchanged for the
    # existing Version 1 animation, and store only the mouth layer from face
    # detection so sign JSON stays smaller than full Face Mesh output.
    left_hand_frames = []
    right_hand_frames = []
    pose_frames = []
    mouth_frames = []
    
    # Process video with MediaPipe Holistic so face and mouth data are sampled
    # in the same frame loop as the existing pose/hand landmarks.
    with mp_holistic.Holistic(
        static_image_mode=False,
        model_complexity=1,
        smooth_landmarks=True,
        refine_face_landmarks=True,
        min_detection_confidence=min_detection_confidence,
        min_tracking_confidence=min_tracking_confidence
    ) as holistic:
        frame_idx = 0
        processed_count = 0
        
        while True:
            ret, frame = cap.read()
            if not ret:
                break
            
            # Sample frames at target FPS
            if frame_idx % frame_interval == 0:
                # Convert BGR to RGB
                rgb_frame = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
                results = holistic.process(rgb_frame)
                
                left_hand = normalize_landmarks(
                    results.left_hand_landmarks.landmark,
                    width,
                    height,
                ) if results.left_hand_landmarks else None
                right_hand = normalize_landmarks(
                    results.right_hand_landmarks.landmark,
                    width,
                    height,
                ) if results.right_hand_landmarks else None
                
                left_hand_frames.append(left_hand)
                right_hand_frames.append(right_hand)
                
                # Process pose
                if results.pose_landmarks:
                    # Extract upper body landmarks (indices 0-16 are relevant)
                    pose_landmarks = normalize_landmarks(
                        results.pose_landmarks.landmark[:17], 
                        width, 
                        height
                    )
                    pose_frames.append(pose_landmarks)
                else:
                    pose_frames.append(None)

                if results.face_landmarks:
                    face_landmarks = normalize_landmarks(
                        results.face_landmarks.landmark,
                        width,
                        height,
                    )
                    mouth_frames.append(extract_mouth_landmarks(face_landmarks))
                else:
                    mouth_frames.append(None)
                
                processed_count += 1
            
            frame_idx += 1
    
    cap.release()
    
    if processed_count == 0:
        print(f"Error: No frames processed from {video_path}")
        return None
    
    print(f"  Processed: {processed_count} frames")
    
    mouth_frames_detected = sum(1 for frame in mouth_frames if frame is not None)

    # Apply smoothing
    left_hand_frames = smooth_landmarks(left_hand_frames)
    right_hand_frames = smooth_landmarks(right_hand_frames)
    pose_frames = smooth_landmarks(pose_frames)
    mouth_frames = smooth_landmarks(mouth_frames)
    
    # Interpolate missing detections
    left_hand_frames = interpolate_missing(left_hand_frames)
    right_hand_frames = interpolate_missing(right_hand_frames)
    pose_frames = interpolate_missing(pose_frames)
    mouth_frames, mouth_frames_interpolated, mouth_frames_missing = fill_missing_mouth_frames(mouth_frames)
    mouth_movement_score = compute_mouth_movement_score(mouth_frames)
    
    # Build output frames
    frames = []
    for i in range(processed_count):
        frame_data = {
            'leftHand': left_hand_frames[i] if i < len(left_hand_frames) else None,
            'rightHand': right_hand_frames[i] if i < len(right_hand_frames) else None,
            'pose': pose_frames[i] if i < len(pose_frames) else None,
            'mouthLandmarks': mouth_frames[i] if i < len(mouth_frames) else None,
        }
        frames.append(frame_data)
    
    if word is None:
        word = Path(video_path).stem.lower()
        parts = word.rsplit('_', 1)
        if len(parts) > 1 and parts[1].isdigit():
            word = parts[0]
    else:
        word = normalize_word(word)
    
    return {
        'word': word,
        'fps': target_fps,
        'frames': frames,
        'source': 'wlasl',
        'hasMouth': any(frame is not None for frame in mouth_frames),
        'mouthLandmarkIndices': MOUTH_LANDMARK_INDICES,
        'mouthFramesDetected': mouth_frames_detected,
        'mouthFramesInterpolated': mouth_frames_interpolated,
        'mouthFramesMissing': mouth_frames_missing,
        'mouthMovementScore': mouth_movement_score,
        'metadata': {
            'original_fps': original_fps,
            'original_frame_count': frame_count,
            'processed_frame_count': processed_count,
            'width': width,
            'height': height,
            'mouthFramesDetected': mouth_frames_detected,
            'mouthFramesInterpolated': mouth_frames_interpolated,
            'mouthFramesMissing': mouth_frames_missing,
            'mouthMovementScore': mouth_movement_score,
        }
    }


def process_directory(
    input_dir: str,
    output_dir: str,
    target_fps: int = 30
) -> tuple[int, int]:
    """
    Process all video files in a directory.
    
    Args:
        input_dir: Input directory containing video files
        output_dir: Output directory for JSON files
        target_fps: Target frames per second
    
    Returns:
        Tuple of (successful_count, failed_count)
    """
    input_path = Path(input_dir)
    output_path = Path(output_dir)
    
    # Create output directory
    output_path.mkdir(parents=True, exist_ok=True)
    
    # Find video files
    video_extensions = {'.mp4', '.avi', '.mov', '.mkv', '.webm'}
    video_files = [
        f for f in input_path.iterdir()
        if f.suffix.lower() in video_extensions
    ]
    
    if not video_files:
        print(f"No video files found in {input_dir}")
        return 0, 0
    
    print(f"Found {len(video_files)} video files")
    print("-" * 50)
    
    successful = 0
    failed = 0
    
    for video_file in sorted(video_files):
        word = video_file.stem.lower()
        # Remove numeric suffixes
        parts = word.rsplit('_', 1)
        if len(parts) > 1 and parts[1].isdigit():
            word = parts[0]
        
        output_file = output_path / f"{safe_sign_filename(word)}.json"
        
        # Skip if already processed
        if output_file.exists():
            print(f"Skipping {video_file.name} (already processed)")
            successful += 1
            continue
        
        result = extract_landmarks_from_video(str(video_file), word=word, target_fps=target_fps)
        
        if result:
            with open(output_file, 'w') as f:
                json.dump(result, f, indent=2)
            print(f"  Saved: {output_file}")
            successful += 1
        else:
            print(f"  Failed: {video_file}")
            failed += 1
        
        print()
    
    return successful, failed


def process_from_manifest(
    manifest_path: str,
    output_dir: str,
    target_fps: int = 30,
    limit: Optional[int] = None
) -> tuple[int, int, int]:
    """
    Process videos listed in the manifest that have videos but no landmarks.
    
    Args:
        manifest_path: Path to signManifest.json
        output_dir: Output directory for JSON files
        target_fps: Target frames per second
        limit: Maximum number of videos to process (None for all)
    
    Returns:
        Tuple of (successful_count, failed_count, skipped_count)
    """
    manifest_file = Path(manifest_path)
    output_path = Path(output_dir)
    
    if not manifest_file.exists():
        print(f"Error: Manifest file not found: {manifest_path}")
        print("Run build_manifest.py first to create the manifest.")
        sys.exit(1)
    
    # Load manifest
    with open(manifest_file, 'r') as f:
        manifest = json.load(f)
    
    wlasl_path = Path(manifest.get('wlaslPath', ''))
    
    # Find videos that need processing
    to_process = []
    for word, entry in manifest['entries'].items():
        if entry['videoAvailable'] and not entry['landmarksAvailable']:
            video_path = wlasl_path / entry['videoPath'] if entry['videoPath'] else None
            if video_path and video_path.exists():
                to_process.append({
                    'word': word,
                    'video_path': str(video_path)
                })
    
    if not to_process:
        print("No videos need processing!")
        print(f"Total landmarks available: {manifest['stats']['landmarksGenerated']}")
        return 0, 0, 0
    
    if limit:
        to_process = to_process[:limit]
    
    print(f"Processing {len(to_process)} videos...")
    print("-" * 50)
    
    # Create output directory
    output_path.mkdir(parents=True, exist_ok=True)
    
    successful = 0
    failed = 0
    skipped = 0
    
    for item in to_process:
        word = item['word']
        video_path = item['video_path']
        output_file = output_path / f"{safe_sign_filename(word)}.json"
        
        # Skip if already processed
        if output_file.exists():
            print(f"Skipping {word} (already processed)")
            skipped += 1
            continue
        
        result = extract_landmarks_from_video(video_path, word=word, target_fps=target_fps)
        
        if result:
            with open(output_file, 'w') as f:
                json.dump(result, f, indent=2)
            print(f"  Saved: {output_file}")
            successful += 1
        else:
            print(f"  Failed: {word}")
            failed += 1
        
        print()
    
    return successful, failed, skipped


def main():
    parser = argparse.ArgumentParser(
        description="Extract ASL landmarks from videos using MediaPipe"
    )
    parser.add_argument(
        "--input", "-i",
        help="Input video file or directory containing videos"
    )
    parser.add_argument(
        "--manifest", "-m",
        help="Path to signManifest.json (process videos listed in manifest)"
    )
    parser.add_argument(
        "--output", "-o",
        required=True,
        help="Output JSON file or directory"
    )
    parser.add_argument(
        "--fps",
        type=int,
        default=30,
        help="Target frames per second (default: 30)"
    )
    parser.add_argument(
        "--limit",
        type=int,
        help="Maximum number of videos to process (manifest mode only)"
    )
    parser.add_argument(
        "--min-detection",
        type=float,
        default=0.5,
        help="Minimum detection confidence (default: 0.5)"
    )
    parser.add_argument(
        "--min-tracking",
        type=float,
        default=0.5,
        help="Minimum tracking confidence (default: 0.5)"
    )
    
    args = parser.parse_args()
    
    if not args.input and not args.manifest:
        print("Error: Either --input or --manifest must be specified")
        sys.exit(1)
    
    print("=" * 50)
    print("ASL Landmark Extraction")
    print("=" * 50)
    print()
    
    if args.manifest:
        # Process from manifest
        successful, failed, skipped = process_from_manifest(
            args.manifest,
            args.output,
            args.fps,
            args.limit
        )
        
        print("=" * 50)
        print(f"Complete: {successful} successful, {failed} failed, {skipped} skipped")
        print("=" * 50)
        print()
        print("Next steps:")
        print("1. Re-run build_manifest.py to update the manifest")
        print("2. Restart the Next.js dev server to load new sign data")
        
    else:
        input_path = Path(args.input)
        output_path = Path(args.output)
        
        if not input_path.exists():
            print(f"Error: Input path does not exist: {args.input}")
            sys.exit(1)
        
        if input_path.is_file():
            # Process single file
            result = extract_landmarks_from_video(
                str(input_path),
                target_fps=args.fps,
                min_detection_confidence=args.min_detection,
                min_tracking_confidence=args.min_tracking
            )
            
            if result:
                # Ensure output directory exists
                output_path.parent.mkdir(parents=True, exist_ok=True)
                
                with open(output_path, 'w') as f:
                    json.dump(result, f, indent=2)
                
                print(f"\nSaved: {output_path}")
                print(f"Frames: {len(result['frames'])}")
            else:
                print("\nExtraction failed")
                sys.exit(1)
        else:
            # Process directory
            successful, failed = process_directory(
                str(input_path),
                str(output_path),
                args.fps
            )
            
            print("=" * 50)
            print(f"Complete: {successful} successful, {failed} failed")
            print("=" * 50)
            
            if failed > 0:
                sys.exit(1)


if __name__ == "__main__":
    main()
