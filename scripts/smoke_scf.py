"""仅用于测试本次本地生成的 ZIP；绝不下载或执行云端代码包。"""

import argparse
import os
from pathlib import Path, PurePosixPath
import stat
import subprocess
import tempfile
import zipfile


ROOT = Path(__file__).resolve().parents[1]


def extract_package(archive: Path, destination: Path) -> None:
    with zipfile.ZipFile(archive) as bundle:
        seen = set()
        size = 0
        for item in bundle.infolist():
            path = PurePosixPath(item.filename)
            size += item.file_size
            if (
                path.is_absolute()
                or ".." in path.parts
                or "\\" in item.filename
                or item.filename in seen
                or not path.parts
                or path.parts[0]
                not in {"dist", "node_modules", "package.json", "scf_bootstrap"}
                or any(part.startswith(".") for part in path.parts)
                or stat.S_ISLNK(item.external_attr >> 16)
                or size > 64 * 1024 * 1024
            ):
                raise ValueError("UnsafeSmokeArchive")
            seen.add(item.filename)
        if not {"dist/index.js", "package.json", "scf_bootstrap"} <= seen:
            raise ValueError("IncompleteSmokeArchive")
        bundle.extractall(destination)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--package", required=True, type=Path)
    args = parser.parse_args()
    Path("/tmp/opencode").mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(
        prefix="musicapi-artifact-", dir="/tmp/opencode"
    ) as directory:
        destination = Path(directory)
        extract_package(args.package, destination)
        env = {
            **os.environ,
            "MUSICAPI_TEST_DIST_ENTRY": str(destination / "dist/index.js"),
        }
        for name in ("NODE_PATH", "NODE_OPTIONS"):
            env.pop(name, None)
        subprocess.run(
            ["node", "--test", str(ROOT / "test/startup-bootstrap.test.mjs")],
            cwd=destination,
            env=env,
            check=True,
            timeout=120,
        )


if __name__ == "__main__":
    main()
