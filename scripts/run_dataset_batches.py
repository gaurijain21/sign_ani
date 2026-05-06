#!/usr/bin/env python3
"""Run MS-ASL and WLASL dataset processors continuously in safe batches."""

import argparse
import json
import subprocess
import sys
import time
from datetime import datetime
from pathlib import Path
from typing import Any


PROJECT_ROOT = Path(__file__).resolve().parents[1]
DATA_DIR = PROJECT_ROOT / "data"
LOG_DIR = DATA_DIR / "batch_logs"
STATUS_PATH = DATA_DIR / "continuous_batch_status.json"
MSASL_STATUS = DATA_DIR / "msasl_expansion_status.json"
WLASL_STATUS = DATA_DIR / "wlasl_face_regen_status.json"


def parse_bool(value: str | bool) -> bool:
    if isinstance(value, bool):
        return value
    return str(value).strip().lower() not in {"false", "0", "no", "off"}


def load_json(path: Path) -> dict[str, Any]:
    if not path.exists():
        return {}
    with path.open("r", encoding="utf-8") as handle:
        return json.load(handle)


def save_json(path: Path, data: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    data["timestamp"] = datetime.now().isoformat()
    with path.open("w", encoding="utf-8") as handle:
        json.dump(data, handle, indent=2)
        handle.write("\n")


def counts_from_status(path: Path) -> dict[str, int]:
    data = load_json(path)
    counts = data.get("counts") or {}
    return {
        "processed": int(counts.get("processed", len(data.get("processedVideoKeys", [])))),
        "uploaded": int(counts.get("uploaded", data.get("uploadedCount", 0))),
        "failedDownloads": int(counts.get("failedDownloads", len(data.get("failedUrls", {})))),
        "failedProcessing": int(counts.get("failedProcessing", len(data.get("failedProcessing", {})))),
    }


def delta(before: dict[str, int], after: dict[str, int]) -> dict[str, int]:
    keys = set(before) | set(after)
    return {key: after.get(key, 0) - before.get(key, 0) for key in sorted(keys)}


def diagnose(text: str) -> list[str]:
    lowered = text.lower()
    hints = []
    if "no module named yt_dlp" in lowered or "yt-dlp" in lowered and "not recognized" in lowered:
        hints.append("Install yt-dlp in the active environment: python -m pip install yt-dlp")
    if "remote components" in lowered or "js challenge" in lowered:
        hints.append("YouTube JS challenge detected; downloader uses --js-runtimes deno and --remote-components ejs:github.")
    if "video unavailable" in lowered or "private video" in lowered:
        hints.append("Source video is unavailable/private/deleted; it should be marked failed and skipped on resume.")
    if "credentials" in lowered or "service account" in lowered:
        hints.append("Check --service-account or GOOGLE_APPLICATION_CREDENTIALS.")
    if "bucket" in lowered:
        hints.append("Check --bucket or FIREBASE_STORAGE_BUCKET.")
    return hints


def run_command(name: str, command: list[str], round_index: int, status_file: Path) -> dict[str, Any]:
    LOG_DIR.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    log_path = LOG_DIR / f"round_{round_index:04d}_{name}_{stamp}.log"
    before = counts_from_status(status_file)

    started = datetime.now()
    with log_path.open("w", encoding="utf-8") as log:
        log.write(f"$ {' '.join(command)}\n\n")
        result = subprocess.run(
            command,
            cwd=str(PROJECT_ROOT),
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
        )
        log.write(result.stdout or "")

    after = counts_from_status(status_file)
    text = log_path.read_text(encoding="utf-8", errors="replace")
    return {
        "name": name,
        "returnCode": result.returncode,
        "logPath": str(log_path),
        "startedAt": started.isoformat(),
        "finishedAt": datetime.now().isoformat(),
        "before": before,
        "after": after,
        "delta": delta(before, after),
        "diagnostics": diagnose(text),
    }


def main() -> None:
    parser = argparse.ArgumentParser(description="Continuously run MS-ASL and WLASL dataset batches.")
    parser.add_argument("--msasl-batch-size", type=int, default=25)
    parser.add_argument("--wlasl-batch-size", type=int, default=25)
    parser.add_argument("--sleep-seconds", type=float, default=5)
    parser.add_argument("--max-rounds", type=int)
    parser.add_argument("--bucket", default="sign-lang-fe04e.firebasestorage.app")
    parser.add_argument("--service-account", default="firebase-service-account.json")
    parser.add_argument("--run-msasl", type=parse_bool, default=True)
    parser.add_argument("--run-wlasl", type=parse_bool, default=True)
    args = parser.parse_args()

    if not args.run_msasl and not args.run_wlasl:
        raise SystemExit("Nothing to run. Enable --run-msasl or --run-wlasl.")

    status = load_json(STATUS_PATH)
    round_index = int(status.get("round", 0))

    print("=" * 72)
    print("Continuous Dataset Batch Runner")
    print("=" * 72)
    print(f"Logs: {LOG_DIR}")
    print(f"Bucket: {args.bucket}")
    print(f"Max rounds: {args.max_rounds or 'unlimited'}")
    print("=" * 72)

    while args.max_rounds is None or round_index < args.max_rounds:
        round_index += 1
        print(f"\nRound {round_index}")
        round_results = []

        if args.run_msasl:
            command = [
                sys.executable,
                "scripts/process_msasl_firebase.py",
                "--batch-size",
                str(args.msasl_batch_size),
                "--split",
                "all",
                "--bucket",
                args.bucket,
                "--service-account",
                args.service_account,
            ]
            print("  Running MS-ASL batch...")
            result = run_command("msasl", command, round_index, MSASL_STATUS)
            round_results.append(result)
            print(f"    return={result['returnCode']} delta={result['delta']} log={result['logPath']}")
            for hint in result["diagnostics"]:
                print(f"    note: {hint}")

        if args.run_wlasl:
            command = [
                sys.executable,
                "scripts/regenerate_wlasl_with_face.py",
                "--batch-size",
                str(args.wlasl_batch_size),
                "--bucket",
                args.bucket,
                "--service-account",
                args.service_account,
            ]
            print("  Running WLASL batch...")
            result = run_command("wlasl", command, round_index, WLASL_STATUS)
            round_results.append(result)
            print(f"    return={result['returnCode']} delta={result['delta']} log={result['logPath']}")
            for hint in result["diagnostics"]:
                print(f"    note: {hint}")

        status = {
            "round": round_index,
            "lastResults": round_results,
            "msasl": counts_from_status(MSASL_STATUS),
            "wlasl": counts_from_status(WLASL_STATUS),
            "logDir": str(LOG_DIR),
            "resumeCommand": (
                f"python scripts/run_dataset_batches.py --msasl-batch-size {args.msasl_batch_size} "
                f"--wlasl-batch-size {args.wlasl_batch_size} --bucket {args.bucket} "
                f"--service-account {args.service_account}"
            ),
        }
        save_json(STATUS_PATH, status)

        if args.max_rounds is not None and round_index >= args.max_rounds:
            break
        time.sleep(args.sleep_seconds)

    print("\nRunner stopped.")
    print(f"Status: {STATUS_PATH}")
    print(f"Logs: {LOG_DIR}")


if __name__ == "__main__":
    main()
