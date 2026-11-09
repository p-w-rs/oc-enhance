"""All plugin-owned Python subprocesses re-enter through Pixi, never the interpreter."""
from __future__ import annotations

import os
import shutil
from pathlib import Path

from .paths import repo_root


def pixi_python(*arguments: str) -> list[str]:
    executable = os.environ.get("OPEN_ENHANCE_PIXI") or shutil.which("pixi")
    if not executable or not Path(executable).is_absolute():
        raise RuntimeError("Pixi is required; direct Python fallback is forbidden")
    # The outer locked task has provisioned this exact environment. --as-is avoids
    # concurrent environment mutation/lock acquisition for descriptor handoffs.
    return [executable, "run", "--as-is", "--offline", "--manifest-path", str(repo_root() / "pixi.toml"), "python", *arguments]
