from __future__ import annotations

import argparse
import json
import os
import platform
import shutil
import sys
import sys
from pathlib import Path

from .evidence import read_evidence
from .paths import child_env, data_root
from .policy import discover
from .search import search


def dispatch(request: dict) -> dict:
    operation = request.get("operation")
    if operation == "doctor":
        home = data_root()
        return {
            "platform": {"system": platform.system(), "machine": platform.machine()},
            "data_directory": str(home), "python": sys.executable,
            "ripgrep": shutil.which("rg"),
            "backend_installed": (home / "bin/colgrep").is_file(),
            "retrieval_model_installed": (home / "models/lateon-code-edge/model_int8.onnx").is_file(),
            "onnxruntime_library": child_env().get("ORT_DYLIB_PATH"),
            "plugin_host": "requires permission.assert; tested OpenCode 2.2.6; no host configuration changed",
            "decisions": "experimental_disabled", "shell_enhancements": "not_implemented_native_preserved",
        }
    raw = request.get("root", "")
    if not isinstance(raw, str) or not Path(raw).is_absolute():
        raise ValueError("An absolute session workspace root is required")
    root = Path(raw).absolute()
    if operation == "inventory":
        paths, coverage = discover(root)
        return {"paths": [str(path) for path in paths], "coverage": coverage}
    if operation == "search":
        allowed = request.get("allowed_paths")
        if allowed is not None and (not isinstance(allowed, list) or len(allowed) > 5000 or not all(isinstance(path, str) for path in allowed)):
            raise ValueError("Invalid authorized source inventory")
        return search(root, request["query"], request.get("mode", "semantic"), request.get("limit", 5), allowed)
    if operation == "read":
        return read_evidence(root, request["evidence"])
    raise ValueError("Unknown operation")


def main() -> None:
    os.umask(0o077)
    parser = argparse.ArgumentParser(prog="open-enhance")
    sub = parser.add_subparsers(dest="command", required=True)
    sub.add_parser("rpc")
    sub.add_parser("doctor")
    search_parser = sub.add_parser("search")
    search_parser.add_argument("root", type=Path)
    search_parser.add_argument("query")
    search_parser.add_argument("--mode", choices=["auto", "semantic", "lexical"], default="semantic")
    search_parser.add_argument("--limit", type=int, default=5)
    args = parser.parse_args()
    try:
        if args.command == "rpc":
            data = sys.stdin.buffer.read(2 * 1024 * 1024 + 1)
            if len(data) > 2 * 1024 * 1024:
                raise ValueError("Request exceeds 2 MiB")
            request = json.loads(data)
        elif args.command == "doctor":
            request = {"operation": "doctor"}
        else:
            request = {"operation": "search", "root": str(args.root.resolve()), "query": args.query, "mode": args.mode, "limit": args.limit}
        print(json.dumps(dispatch(request), ensure_ascii=False))
    except Exception as error:
        print(json.dumps({"error": type(error).__name__, "message": str(error)}), file=sys.stderr)
        raise SystemExit(1)


if __name__ == "__main__":
    main()
