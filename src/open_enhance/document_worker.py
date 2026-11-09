"""Disposable, resource-limited document parser. No source paths cross the boundary."""
from __future__ import annotations

import ctypes
import json
import os
import resource
import signal
import subprocess
import sys
import threading
from pathlib import Path

from .runtime import pixi_python

MAX_INPUT = 20 * 1024 * 1024
MAX_TEXT = 4 * 1024 * 1024


def parser_environment() -> dict[str, str]:
    # Sandbox profiles do not hide environment variables. Even the standalone
    # CLI must not hand provider tokens/config/loader injection to a parser.
    allowed = {"PATH", "HOME", "USER", "LOGNAME", "TMPDIR", "LANG", "LC_ALL", "LC_CTYPE", "TZ", "OPEN_ENHANCE_PIXI", "PIXI_CACHE_DIR"}
    return {**{key: value for key, value in os.environ.items() if key in allowed}, "PYTHONNOUSERSITE": "1", "PYTHONDONTWRITEBYTECODE": "1"}


def constrain_parser() -> None:
    if sys.platform != "darwin":
        raise RuntimeError("Document sandbox requires macOS; refusing unsandboxed parsing")
    resource.setrlimit(resource.RLIMIT_CPU, (5, 5))
    # macOS rejects RLIMIT_DATA/AS caps on supported hosts. Do not pretend those
    # provide a hard memory sandbox; parser deadlines/CPU/output are bounded.
    resource.setrlimit(resource.RLIMIT_FSIZE, (0, 0))
    resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
    resource.setrlimit(resource.RLIMIT_NOFILE, (64, 64))
    library = ctypes.CDLL("/usr/lib/libsandbox.dylib", use_errno=True)
    library.sandbox_init.argtypes = [ctypes.c_char_p, ctypes.c_uint64, ctypes.POINTER(ctypes.c_char_p)]
    library.sandbox_init.restype = ctypes.c_int
    # Input is already in memory. Reading project files, writes, network, and
    # subprocess creation are all excluded; allow only Python/runtime resources.
    runtime = str(Path(sys.prefix).resolve())
    package = str(Path(__file__).resolve().parent)
    profile = f'''(version 1)
      (deny default)
      (allow file-read* (subpath "/System") (subpath "/usr/lib")
        (subpath {json.dumps(runtime)}) (subpath {json.dumps(package)}))
      (allow sysctl-read)
      (allow mach-lookup)
      (allow process-info* (target self))
      (allow signal (target self))'''
    error = ctypes.c_char_p()
    if library.sandbox_init(profile.encode(), 0, ctypes.byref(error)) != 0:
        raise RuntimeError("Could not apply document sandbox; refusing extraction")


def extract_isolated(data: bytes, suffix: str):
    from .extract import Unit
    if len(data) > MAX_INPUT:
        raise ValueError("Document exceeds parser input budget")
    process = subprocess.Popen(
        pixi_python("-m", "open_enhance.document_worker", suffix),
        stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
        # Remain in the owning worker group so OpenCode cancellation also stops
        # parsers. Never detach descendants from WorkerPool's cancellation tree.
        env=parser_environment(),
    )
    finished = threading.Event()
    exceeded = threading.Event()

    descendants = {process.pid}
    tree_lock = threading.RLock()

    def snapshot_tree() -> int:
        snapshot = subprocess.run(["/bin/ps", "-axo", "pid=,ppid=,rss="], capture_output=True, text=True, timeout=1)
        if snapshot.returncode != 0:
            raise OSError("Parser memory monitoring failed")
        rows = [tuple(map(int, line.split())) for line in snapshot.stdout.splitlines() if len(line.split()) == 3]
        with tree_lock:
            changed = True
            while changed:
                children = {pid for pid, parent, _ in rows if parent in descendants}
                changed = not children.issubset(descendants)
                descendants.update(children)
            return sum(rss for pid, _, rss in rows if pid in descendants)

    def stop() -> None:
        try:
            snapshot_tree()
        except (OSError, ValueError, subprocess.TimeoutExpired):
            pass
        with tree_lock:
            targets = sorted(descendants, reverse=True)
        for pid in targets:
            try:
                os.kill(pid, signal.SIGKILL)
            except ProcessLookupError:
                pass

    def monitor() -> None:
        while not finished.wait(0.1):
            try:
                if snapshot_tree() > 512 * 1024:
                    exceeded.set()
                    stop()
                    return
            except (OSError, ValueError, subprocess.TimeoutExpired):
                exceeded.set()
                stop()
                return

    watcher = threading.Thread(target=monitor, daemon=True)
    watcher.start()
    try:
        output, _ = process.communicate(data, timeout=12)
    except subprocess.TimeoutExpired:
        stop()
        process.communicate()
        raise ValueError("Document parser exceeded its deadline") from None
    finally:
        finished.set()
        watcher.join(timeout=2)
    if exceeded.is_set():
        raise ValueError("Document parser exceeded its resident-memory budget or monitoring failed")
    if process.returncode:
        if output == b'{"error":"entities"}':
            raise ValueError("XML entities are not supported")
        raise ValueError("Document parsing failed or exceeded sandbox/resource limits")
    if len(output) > MAX_TEXT * 2:
        raise ValueError("Parser output exceeds budget")
    parsed = json.loads(output)
    if not isinstance(parsed, list) or len(parsed) > 10000:
        raise ValueError("Invalid parser response")
    return [Unit(item["text"], item["locator"]) for item in parsed]


def main() -> None:
    from .extract import extract_raw
    # Import parsers before lockdown; their data inputs are still unparsed.
    import pypdf  # noqa: F401
    data = sys.stdin.buffer.read(MAX_INPUT + 1)
    if len(data) > MAX_INPUT or len(sys.argv) != 2 or sys.argv[1] not in {".pdf", ".docx"}:
        raise ValueError("Invalid document request")
    constrain_parser()
    units = extract_raw(data, sys.argv[1])
    if len(units) > 10000 or sum(len(unit.text.encode()) for unit in units) > MAX_TEXT:
        raise ValueError("Extracted document exceeds output budget")
    output = json.dumps([{"text": unit.text, "locator": unit.locator} for unit in units], ensure_ascii=False).encode()
    if len(output) > MAX_TEXT * 2:
        raise ValueError("Serialized document exceeds output budget")
    sys.stdout.buffer.write(output)


if __name__ == "__main__":
    try:
        main()
    except ValueError as error:
        if str(error) == "XML entities are not supported":
            sys.stdout.buffer.write(b'{"error":"entities"}')
        raise SystemExit(1)
