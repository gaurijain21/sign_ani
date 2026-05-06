#!/usr/bin/env python3
"""Shared utilities for Firebase-backed ASL landmark processing scripts."""

import json
import os
import re
import shutil
import subprocess
import sys
from datetime import datetime
from pathlib import Path
from typing import Any


MOUTH_LANDMARK_INDICES = sorted({
    0, 13, 14, 17, 37, 39, 40, 61, 78, 80, 81, 82, 84, 87, 88, 91,
    95, 146, 178, 181, 185, 191, 267, 269, 270, 291, 308, 310, 311,
    312, 314, 317, 318, 321, 324, 375, 402, 405, 409, 415,
})


firebase_admin = None
credentials = None
firestore = None
storage = None


def normalize_word(value: str) -> str:
    return " ".join(str(value or "").strip().lower().split())


def slugify(value: str) -> str:
    slug = re.sub(r"[^a-z0-9]+", "-", normalize_word(value))
    return slug.strip("-") or "sign"


def safe_variant_id(dataset: str, split: str, unique_value: str) -> str:
    parts = [dataset, split, unique_value]
    return slugify("-".join(str(part) for part in parts if part))


def load_status(path: Path) -> dict[str, Any]:
    if not path.exists():
        return {
            "processedVideoKeys": [],
            "failedUrls": {},
            "failedProcessing": {},
            "counts": {"processed": 0, "uploaded": 0, "failedDownloads": 0, "failedProcessing": 0},
        }
    with path.open("r", encoding="utf-8-sig") as handle:
        return json.load(handle)


def save_status(path: Path, status: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    status["timestamp"] = datetime.now().isoformat()
    with path.open("w", encoding="utf-8") as handle:
        json.dump(status, handle, indent=2)
        handle.write("\n")


def write_json(path: Path, data: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8") as handle:
        json.dump(data, handle, indent=2)
        handle.write("\n")


def cleanup_temp_files(*paths: Path) -> None:
    for path in paths:
        try:
            if path.exists() and path.is_file():
                path.unlink()
        except OSError:
            pass


def _load_service_account_project(service_account: Path) -> str | None:
    try:
        with service_account.open("r", encoding="utf-8") as handle:
            return json.load(handle).get("project_id")
    except (OSError, json.JSONDecodeError):
        return None


def resolve_bucket(bucket: str | None, service_account: Path | None = None) -> str:
    if bucket:
        return bucket
    env_bucket = os.environ.get("FIREBASE_STORAGE_BUCKET")
    if env_bucket:
        return env_bucket
    if service_account:
        project_id = _load_service_account_project(service_account)
        if project_id:
            return f"{project_id}.firebasestorage.app"
    raise RuntimeError(
        "Missing Firebase Storage bucket. Pass --bucket, set FIREBASE_STORAGE_BUCKET, "
        "or use a service account JSON containing project_id."
    )


def require_service_account(service_account: str | Path | None) -> Path:
    raw_path = service_account or os.environ.get("GOOGLE_APPLICATION_CREDENTIALS")
    if not raw_path:
        raise RuntimeError(
            "Missing Firebase Admin credentials. Pass --service-account path\\to\\key.json "
            "or set PowerShell env var:\n"
            '$env:GOOGLE_APPLICATION_CREDENTIALS="C:\\Gauri\\sign_ani\\firebase-service-account.json"'
        )
    path = Path(raw_path).expanduser().resolve()
    if not path.exists():
        raise RuntimeError(
            f"Firebase service account file not found: {path}\n"
            "Generate one in Firebase Console > Project settings > Service accounts, "
            "then pass --service-account or set GOOGLE_APPLICATION_CREDENTIALS."
        )
    return path


def init_firebase(service_account: str | Path | None = None, bucket: str | None = None) -> tuple[Any, Any, str]:
    """Initialize Firebase Admin and return (firestore_client, storage_bucket, bucket_name)."""
    global firebase_admin, credentials, firestore, storage

    service_account_path = require_service_account(service_account)
    bucket_name = resolve_bucket(bucket, service_account_path)

    if firebase_admin is None:
        try:
            import firebase_admin as firebase_admin_module
            from firebase_admin import credentials as credentials_module
            from firebase_admin import firestore as firestore_module
            from firebase_admin import storage as storage_module
        except ImportError as exc:
            raise RuntimeError(
                "Missing firebase-admin. Install script dependencies with:\n"
                "pip install firebase-admin mediapipe opencv-python yt-dlp tqdm"
            ) from exc

        firebase_admin = firebase_admin_module
        credentials = credentials_module
        firestore = firestore_module
        storage = storage_module

    if not firebase_admin._apps:
        cred = credentials.Certificate(str(service_account_path))
        firebase_admin.initialize_app(cred, {"storageBucket": bucket_name})

    return firestore.client(), storage.bucket(bucket_name), bucket_name


def _landmarks_to_list(landmarks: Any) -> list[dict[str, float]] | None:
    if not landmarks:
        return None
    return [
        {
            "x": float(point.x),
            "y": float(point.y),
            "z": float(getattr(point, "z", 0.0)),
            "visibility": float(getattr(point, "visibility", 1.0)),
        }
        for point in landmarks.landmark
    ]


def _mouth_from_face(face: list[dict[str, float]] | None) -> list[dict[str, float]] | None:
    if not face:
        return None
    return [face[index] for index in MOUTH_LANDMARK_INDICES if index < len(face)]


def extract_holistic_landmarks(
    video_path: Path,
    word: str,
    dataset: str,
    variant_id: str,
    max_frames: int = 120,
    start_frame: int | None = None,
    end_frame: int | None = None,
) -> dict[str, Any] | None:
    """Extract MediaPipe Holistic pose, hands, face, and mouth landmarks."""
    import cv2
    import mediapipe as mp

    cap = cv2.VideoCapture(str(video_path))
    if not cap.isOpened():
        return None

    fps = cap.get(cv2.CAP_PROP_FPS) or 30
    total_frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT) or 0)
    first_frame = max(0, int(start_frame or 0))
    last_frame = int(end_frame) if end_frame is not None and int(end_frame) > first_frame else total_frames
    clip_frame_count = max(0, last_frame - first_frame) if total_frames else 0
    step = max(1, clip_frame_count // max_frames) if max_frames and clip_frame_count > max_frames else 1
    width = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH) or 0)
    height = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT) or 0)
    frames: list[dict[str, Any]] = []
    has_pose = has_hands = has_face = has_mouth = False

    holistic = mp.solutions.holistic.Holistic(
        static_image_mode=False,
        model_complexity=1,
        smooth_landmarks=True,
        refine_face_landmarks=True,
        min_detection_confidence=0.5,
        min_tracking_confidence=0.5,
    )

    frame_index = 0
    try:
        while len(frames) < max_frames:
            ok, frame = cap.read()
            if not ok:
                break
            if frame_index < first_frame:
                frame_index += 1
                continue
            if last_frame and frame_index > last_frame:
                break
            if (frame_index - first_frame) % step != 0:
                frame_index += 1
                continue

            rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
            result = holistic.process(rgb)
            pose = _landmarks_to_list(result.pose_landmarks)
            left_hand = _landmarks_to_list(result.left_hand_landmarks)
            right_hand = _landmarks_to_list(result.right_hand_landmarks)
            face = _landmarks_to_list(result.face_landmarks)
            mouth = _mouth_from_face(face)

            has_pose = has_pose or bool(pose)
            has_hands = has_hands or bool(left_hand or right_hand)
            has_face = has_face or bool(face)
            has_mouth = has_mouth or bool(mouth)

            frames.append(
                {
                    "frameIndex": frame_index,
                    "pose": pose,
                    "leftHand": left_hand,
                    "rightHand": right_hand,
                    "face": face,
                    "mouth": mouth,
                    "pose_landmarks": pose,
                    "left_hand_landmarks": left_hand,
                    "right_hand_landmarks": right_hand,
                    "face_landmarks": face,
                    "mouth_landmarks": mouth,
                }
            )
            frame_index += 1
    finally:
        cap.release()
        holistic.close()

    if not frames:
        return None

    return {
        "word": normalize_word(word),
        "dataset": dataset,
        "variantId": variant_id,
        "fps": fps,
        "frameCount": len(frames),
        "sourceFrameCount": total_frames,
        "width": width,
        "height": height,
        "hasPose": has_pose,
        "hasHands": has_hands,
        "hasFace": has_face,
        "hasMouth": has_mouth,
        "mouthLandmarkIndices": MOUTH_LANDMARK_INDICES,
        "frames": frames,
    }


def upload_json_to_storage(bucket_obj: Any, local_json: Path, storage_path: str) -> dict[str, str]:
    blob = bucket_obj.blob(storage_path)
    blob.upload_from_filename(str(local_json), content_type="application/json")
    return {
        "storagePath": storage_path,
        "gsUrl": f"gs://{bucket_obj.name}/{storage_path}",
    }


def update_sign_doc_duplicate_safe(db: Any, word: str, variant: dict[str, Any], source: str) -> bool:
    """Merge a variant into signs/{word_slug} without creating duplicate word docs."""
    normalized = normalize_word(word)
    doc_ref = db.collection("signs").document(slugify(normalized))
    snapshot = doc_ref.get()
    now = datetime.now().isoformat()

    if snapshot.exists:
        data = snapshot.to_dict() or {}
    else:
        data = {}

    variants = data.get("variants") or []
    existing_ids = {item.get("variantId") for item in variants if isinstance(item, dict)}
    inserted = False
    if variant["variantId"] not in existing_ids:
        variants.append(variant)
        inserted = True

    sources = data.get("sources") or []
    if source not in sources:
        sources.append(source)

    update = {
        "word": data.get("word") or normalized,
        "normalizedWord": normalized,
        "sources": sources,
        "variants": variants,
        "updatedAt": now,
    }
    if not data.get("primaryVariantId"):
        update["primaryVariantId"] = variant["variantId"]

    doc_ref.set(update, merge=True)
    return inserted


def ensure_youtube_url(url: str) -> str:
    url = str(url or "").strip()
    if not url:
        return url
    if url.startswith("http://") or url.startswith("https://"):
        return url
    return f"https://{url}"


def _deno_runtime_arg() -> str:
    deno_path = shutil.which("deno")
    if not deno_path:
        candidates = list(Path(os.environ.get("LOCALAPPDATA", "")).glob("Microsoft/WinGet/Packages/DenoLand.Deno*/deno.exe"))
        if candidates:
            deno_path = str(candidates[0])
    return f"deno:{deno_path}" if deno_path else "deno"


def download_with_ytdlp(
    url: str,
    output_path: Path,
    start_time: float | None = None,
    end_time: float | None = None,
    extra_args: list[str] | None = None,
) -> None:
    output_path.parent.mkdir(parents=True, exist_ok=True)
    if shutil.which("yt-dlp"):
        command = ["yt-dlp"]
    else:
        command = [sys.executable, "-m", "yt_dlp"]
    command.extend(
        [
            "--js-runtimes",
            _deno_runtime_arg(),
            "--remote-components",
            "ejs:github",
            "--ignore-errors",
            "--no-playlist",
            "--retries",
            "3",
            "--fragment-retries",
            "3",
            "-f",
            "mp4/best[ext=mp4]/best",
            "-o",
            str(output_path),
        ]
    )
    if extra_args:
        command.extend(extra_args)
    command.append(ensure_youtube_url(url))
    subprocess.run(command, check=True, capture_output=True, text=True, timeout=180)
    if not output_path.exists() or output_path.stat().st_size < 1024:
        raise subprocess.CalledProcessError(
            returncode=1,
            cmd=command,
            stderr="yt-dlp completed without producing a usable video file. The source may be unavailable/private/deleted.",
        )
