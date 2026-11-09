from __future__ import annotations

import hashlib
import json
import os
import platform
import shutil
import subprocess
import tarfile
import tempfile
import urllib.request
from pathlib import Path

from .paths import child_env, data_root, repo_root
from .storage import SafeDirectory


def provision() -> dict:
    os.umask(0o077)
    if platform.system() != "Darwin" or platform.machine() != "arm64":
        raise RuntimeError("open-enhance currently supports macOS arm64 only")
    lock = json.loads((repo_root() / "models.lock.json").read_text())
    home = data_root()
    with SafeDirectory(home, create=True) as storage:
        os.fchmod(storage.fd, 0o700)
    binary = home / "bin/colgrep"
    spec = lock["colgrep"]
    archive = home / f"downloads/colgrep-{spec['version']}.tar.xz"
    archive.parent.mkdir(parents=True, exist_ok=True)
    if not archive.exists() or hashlib.sha256(archive.read_bytes()).hexdigest() != spec["sha256"]:
        partial = archive.with_suffix(".part")
        urllib.request.urlretrieve(spec["url"], partial)
        if hashlib.sha256(partial.read_bytes()).hexdigest() != spec["sha256"]:
            partial.unlink()
            raise RuntimeError("ColGrep archive checksum mismatch")
        partial.replace(archive)
    # Re-extract the verified artifact, rather than trusting an existing executable.
    binary.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(dir=home) as directory:
        with tarfile.open(archive) as tar:
            tar.extractall(directory, filter="data")
        candidates = list(Path(directory).rglob("colgrep"))
        executable = next(p for p in candidates if p.is_file())
        shutil.copy2(executable, binary)
        binary.chmod(0o755)
        # Preserve dynamic libraries packaged alongside the executable, if present.
        for library in Path(directory).rglob("*.dylib"):
            shutil.copy2(library, binary.parent / library.name)
    os.environ.update({key: value for key, value in child_env().items() if key.startswith("HF_")})
    from huggingface_hub import snapshot_download

    model = lock["retrieval"]
    destination = home / "models/lateon-code-edge"
    snapshot_download(model["repository"], revision=model["revision"], allow_patterns=model["files"], local_dir=destination)
    # No implicit global CoreML cache and no automatic ONNX Runtime download.
    environment = child_env()
    if "ORT_DYLIB_PATH" not in environment:
        raise RuntimeError("The locked ONNX Runtime library is missing; run pixi install --locked")
    subprocess.run([str(binary), "settings", "--coreml-cache-dir", str(home / "cache/coreml")], env=environment, check=True, capture_output=True, timeout=20)
    receipt = {"colgrep": spec, "retrieval": model, "onnxruntime": "1.23.2", "binary_sha256": hashlib.sha256(binary.read_bytes()).hexdigest(), "model_sha256": {str(path.relative_to(destination)): hashlib.sha256(path.read_bytes()).hexdigest() for path in destination.rglob("*") if path.is_file() and ".cache" not in path.relative_to(destination).parts}}
    (home / "installation.json").write_text(json.dumps(receipt, indent=2) + "\n")
    return {"installed": True, "home": str(home), "retrieval_revision": model["revision"]}


if __name__ == "__main__":
    print(json.dumps(provision(), indent=2))
