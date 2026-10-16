#!/usr/bin/env python3
"""Build the minimal production ZIP used by the existing SCF function."""

from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import tempfile
import zipfile
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
MAX_ARCHIVE_BYTES = 3 * 1024 * 1024


def validate_tree(source: Path, *, compiled: bool = False) -> None:
    for item in [source, *source.rglob("*")]:
        if item.is_symlink():
            raise ValueError("PackageSymlinkRejected")
        parts = item.relative_to(source).parts
        if any(
            part.startswith(".") or part in {"data", "credentials"} for part in parts
        ):
            if parts == (".package-lock.json",) and not compiled:
                continue
            raise ValueError("PackageSensitivePathRejected")
        if (
            item.is_file()
            and compiled
            and not item.name.endswith((".js", ".d.ts", ".js.map"))
        ):
            raise ValueError("UnexpectedDistFile")


def create_package(root: Path = ROOT, output: Path | None = None) -> Path:
    dist = root / "dist"
    package_json = root / "package.json"
    if not (dist / "index.js").is_file():
        raise ValueError("dist/index.js is missing; run npm run build first")
    if not package_json.is_file():
        raise ValueError("package.json is missing")
    validate_tree(dist, compiled=True)
    for name in ("package.json", "package-lock.json", "scf_bootstrap"):
        if (root / name).is_symlink():
            raise ValueError("PackageSymlinkRejected")
    if not (root / "package-lock.json").is_file():
        raise ValueError("package-lock.json is missing")

    destination = output or root / "musicapi-scf.zip"
    destination.parent.mkdir(parents=True, exist_ok=True)
    Path("/tmp/opencode").mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(
        prefix="musicapi-scf-", dir="/tmp/opencode"
    ) as temp:
        staging = Path(temp) / "bundle"
        staging.mkdir()
        # Fresh output prevents stale JS left by an earlier build from shipping.
        subprocess.run(
            [
                "node",
                str(root / "node_modules/typescript/bin/tsc"),
                "--project",
                str(root / "tsconfig.json"),
                "--outDir",
                str(staging / "dist"),
            ],
            cwd=root,
            check=True,
        )
        validate_tree(staging / "dist", compiled=True)
        if not (staging / "dist/index.js").is_file():
            raise ValueError("FreshBuildMissingEntry")
        shutil.copy2(package_json, staging / "package.json")
        package_lock = root / "package-lock.json"
        if package_lock.is_file():
            shutil.copy2(package_lock, staging / "package-lock.json")
        bootstrap = root / "scf_bootstrap"
        if not bootstrap.is_file():
            raise ValueError("scf_bootstrap is missing")
        shutil.copy2(bootstrap, staging / "scf_bootstrap")
        os.chmod(staging / "scf_bootstrap", 0o755)

        subprocess.run(
            [
                "npm",
                "ci",
                "--omit=dev",
                "--ignore-scripts",
                "--no-audit",
                "--no-fund",
            ],
            cwd=staging,
            check=True,
        )
        generated_lock = staging / "package-lock.json"
        if generated_lock.exists():
            generated_lock.unlink()
        validate_tree(staging / "node_modules")

        with zipfile.ZipFile(destination, "w", zipfile.ZIP_DEFLATED) as archive:
            for item in sorted(staging.rglob("*")):
                if item.is_file():
                    if (
                        item.relative_to(staging).as_posix()
                        == "node_modules/.package-lock.json"
                    ):
                        continue
                    archive.write(item, item.relative_to(staging).as_posix())
        if destination.stat().st_size > MAX_ARCHIVE_BYTES:
            destination.unlink()
            raise ValueError("PackageSizeLimit")

    return destination


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    output = create_package(output=args.output)
    with zipfile.ZipFile(output) as archive:
        names = archive.namelist()
    print(json.dumps({"package": str(output), "files": len(names)}, ensure_ascii=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
