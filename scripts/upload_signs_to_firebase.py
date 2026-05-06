#!/usr/bin/env python3
"""Upload data/signs JSON files to Firebase Storage and update Firestore signs documents."""

import argparse
import json
import os
import re
from pathlib import Path

from sign_landmark_utils import require_service_account, resolve_bucket

firebase_admin = None
credentials = None
firestore = None
storage = None


def normalize_gloss(value: str) -> str:
    return " ".join(value.strip().lower().split())


def safe_doc_id(gloss: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", normalize_gloss(gloss)).strip("-")


def load_manifest(path: Path) -> dict:
    with path.open("r", encoding="utf-8") as handle:
        return json.load(handle)


def init_firebase(service_account: Path, bucket: str) -> None:
    global firebase_admin, credentials, firestore, storage
    if firebase_admin is None:
        try:
            import firebase_admin as firebase_admin_module
            from firebase_admin import credentials as credentials_module
            from firebase_admin import firestore as firestore_module
            from firebase_admin import storage as storage_module
        except ImportError as exc:
            raise SystemExit("Install firebase-admin first: pip install firebase-admin") from exc

        firebase_admin = firebase_admin_module
        credentials = credentials_module
        firestore = firestore_module
        storage = storage_module

    if firebase_admin._apps:
        return
    cred = credentials.Certificate(str(service_account))
    firebase_admin.initialize_app(cred, {"storageBucket": bucket})


def upload_files(
    files: list[Path],
    manifest_path: Path,
    service_account: Path,
    bucket_name: str,
    collection_name: str = "signs",
) -> int:
    manifest = load_manifest(manifest_path)
    init_firebase(service_account, bucket_name)
    bucket = storage.bucket()
    db = firestore.client()

    uploaded = 0
    for json_file in files:
        if not json_file.exists():
            print(f"Skipping missing JSON: {json_file}")
            continue

        with json_file.open("r", encoding="utf-8") as handle:
            sign_data = json.load(handle)

        gloss = normalize_gloss(sign_data.get("word") or json_file.stem.replace("_", " "))
        manifest_entry = manifest.get("entries", {}).get(gloss, {})
        storage_path = f"signs/{json_file.name}"
        blob = bucket.blob(storage_path)
        blob.upload_from_filename(str(json_file), content_type="application/json")

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
        db.collection(collection_name).document(safe_doc_id(gloss)).set(doc, merge=True)
        uploaded += 1
        print(f"Uploaded {gloss} -> {storage_path}")

    return uploaded


def main() -> None:
    project_root = Path(__file__).resolve().parents[1]
    parser = argparse.ArgumentParser(description="Upload generated sign JSON files to Firebase.")
    parser.add_argument(
        "--service-account",
        default=os.environ.get("GOOGLE_APPLICATION_CREDENTIALS") or str(project_root / "firebase-service-account.json"),
        help="Firebase Admin service account JSON path. Defaults to GOOGLE_APPLICATION_CREDENTIALS or ./firebase-service-account.json.",
    )
    parser.add_argument("--bucket", default=os.environ.get("FIREBASE_STORAGE_BUCKET"), help="Firebase Storage bucket, e.g. project.appspot.com.")
    parser.add_argument("--manifest", default=str(project_root / "data" / "signManifest.json"))
    parser.add_argument("--signs-dir", default=str(project_root / "data" / "signs"))
    parser.add_argument("--files", nargs="*", help="Specific JSON files to upload. Defaults to all data/signs/*.json.")
    parser.add_argument("--collection", default="signs")
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()

    try:
        service_account = require_service_account(args.service_account)
        bucket_name = resolve_bucket(args.bucket, service_account)
    except RuntimeError as exc:
        raise SystemExit(f"Firebase Admin credentials are not ready:\n{exc}") from exc

    signs_dir = Path(args.signs_dir)
    json_files = [Path(file).resolve() for file in args.files] if args.files else sorted(signs_dir.glob("*.json"))

    if args.dry_run:
        print(f"Would upload {len(json_files)} sign JSON files to {bucket_name}.")
        return

    uploaded = upload_files(
        files=json_files,
        manifest_path=Path(args.manifest),
        service_account=service_account,
        bucket_name=bucket_name,
        collection_name=args.collection,
    )
    print(f"Uploaded and indexed {uploaded} signs.")


if __name__ == "__main__":
    main()
