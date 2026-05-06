#!/usr/bin/env python3
"""Build data/localSignManifest.json from WLASL metadata and extracted videos."""

from pathlib import Path

from build_manifest import build_manifest


def main() -> None:
    project_root = Path(__file__).resolve().parents[1]
    build_manifest(
        wlasl_path=project_root / "WLASL",
        signs_path=project_root / "data" / "signs",
        output_path=project_root / "data" / "localSignManifest.json",
    )


if __name__ == "__main__":
    main()
