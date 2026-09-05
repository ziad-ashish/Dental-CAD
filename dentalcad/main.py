"""DentalCAD Python entry point.

Run from the repository root with ``python main.py``.  Python is the
developer-facing launcher; the CAD renderer runs in the isolated Electron
desktop shell so the same entry point works without opening a browser tab.
"""

from __future__ import annotations

import os
from pathlib import Path
import shutil
import subprocess
import sys


def _electron_binary(root: Path) -> Path | None:
    configured = os.environ.get("DENTALCAD_ELECTRON")
    candidates = [
        Path(configured) if configured else None,
        root / "desktop" / "node_modules" / "electron" / "dist" / "electron.exe",
        root / "desktop" / "node_modules" / ".bin" / "electron.cmd",
        root / "node_modules" / "electron" / "dist" / "electron.exe",
        root / "node_modules" / ".bin" / "electron.cmd",
        Path(shutil.which("electron") or ""),
    ]
    for candidate in candidates:
        if candidate and candidate.is_file():
            return candidate
    return None


def main() -> int:
    root = Path(__file__).resolve().parent.parent
    electron = _electron_binary(root)
    if electron is None:
        print("DentalCAD desktop dependencies are not installed.", file=sys.stderr)
        print("Run: cd desktop && npm install", file=sys.stderr)
        print("Then run: python main.py", file=sys.stderr)
        return 2

    desktop = root / "desktop"
    process = subprocess.Popen([str(electron), str(desktop)], cwd=str(desktop))
    return process.wait()


if __name__ == "__main__":
    main()
