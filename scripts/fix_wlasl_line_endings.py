#!/usr/bin/env python3
"""Normalize WLASL shell scripts to LF line endings for Bash on Windows."""

from pathlib import Path


def normalize_file(path: Path) -> bool:
    data = path.read_bytes()
    normalized = data.replace(b"\r\n", b"\n").replace(b"\r", b"\n")
    if normalized == data:
        return False
    path.write_bytes(normalized)
    return True


def main() -> None:
    project_root = Path(__file__).resolve().parents[1]
    wlasl_root = project_root / "WLASL"

    if not wlasl_root.exists():
        raise SystemExit(f"WLASL checkout not found: {wlasl_root}")

    changed = []
    for script_path in wlasl_root.rglob("*.sh"):
        if normalize_file(script_path):
            changed.append(script_path)

    if changed:
        print("Normalized LF line endings:")
        for script_path in changed:
            print(f"  {script_path}")
    else:
        print("All WLASL shell scripts already use LF line endings.")


if __name__ == "__main__":
    main()
