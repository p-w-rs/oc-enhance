from __future__ import annotations

import os
import sys
from pathlib import Path


def repo_root() -> Path:
    return Path(__file__).resolve().parents[2]


def data_root() -> Path:
    configured = os.environ.get("OPEN_ENHANCE_HOME")
    return Path(configured).expanduser().absolute() if configured else Path.home() / "Library/Application Support/open-enhance"


def child_env() -> dict[str, str]:
    """Only child processes get relocated caches; never change the host environment."""
    home = data_root()
    runtime = next((Path(sys.prefix) / "lib/python3.12/site-packages/onnxruntime/capi").glob("libonnxruntime.*.dylib"), None)
    return {
        **os.environ,
        "XDG_DATA_HOME": str(home / "data"),
        "XDG_CONFIG_HOME": str(home / "config"),
        "XDG_CACHE_HOME": str(home / "cache"),
        "HF_HOME": str(home / "models/huggingface"),
        "HF_HUB_DISABLE_TELEMETRY": "1",
        "HF_HUB_DISABLE_IMPLICIT_TOKEN": "1",
        "DO_NOT_TRACK": "1",
        "TOKENIZERS_PARALLELISM": "false",
        **({"ORT_DYLIB_PATH": str(runtime)} if runtime else {}),
    }
