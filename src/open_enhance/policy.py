from __future__ import annotations

import os
import re
import shutil
import stat
import subprocess
from pathlib import Path

from .runtime import pixi_python

TEXT_SUFFIXES = frozenset(".md .mdx .txt .rst .adoc .org .tex .py .pyi .ts .tsx .js .jsx .mjs .cjs .rs .go .odin .swift .c .h .cpp .hpp .java .rb .sh .bash .zsh .toml .yaml .yml .json .jsonc .html .htm .css .sql .csv .xml .ini .cfg .r .jl .lua .ex .exs .zig .proto .graphql .cmake .vue .svelte".split())
DOCUMENT_SUFFIXES = frozenset({".pdf", ".docx"})
EXCLUDED_DIRS = frozenset({"vendor", "node_modules", "build", "dist", "target", "out", "prebuilt", "runtimes", "toolchain", "__pycache__", ".git", ".local", ".pixi"})
SENSITIVE = re.compile(r"(^|[._-])(secrets?|credentials?|passwords?|tokens?|private[-_]?key|id_rsa|id_ed25519)([._-]|$)", re.I)
MAX_FILE_BYTES = 2 * 1024 * 1024
MAX_DOCUMENT_BYTES = 20 * 1024 * 1024
MAX_FILES = 5000
MAX_SOURCE_BYTES = 96 * 1024 * 1024


class PolicyError(ValueError):
    pass


def secure_open_directory(path: Path, *, create: bool = False) -> int:
    """Acquire a directory without following symlinks in *any* path component."""
    if not path.is_absolute() or ".." in path.parts:
        raise PolicyError("A canonical absolute directory is required")
    descriptor = os.open("/", os.O_RDONLY | os.O_DIRECTORY)
    try:
        for part in path.parts[1:]:
            if create:
                try:
                    os.mkdir(part, mode=0o700, dir_fd=descriptor)
                except FileExistsError:
                    pass
            child = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=descriptor)
            os.close(descriptor)
            descriptor = child
        return descriptor
    except BaseException:
        os.close(descriptor)
        raise


def eligible(relative: Path) -> bool:
    if relative.is_absolute() or ".." in relative.parts:
        return False
    if any(part.startswith(".") or part.lower() in EXCLUDED_DIRS or SENSITIVE.search(part) for part in relative.parts):
        return False
    return relative.suffix.lower() in TEXT_SUFFIXES | DOCUMENT_SUFFIXES or relative.name in {"Dockerfile", "Makefile", "CMakeLists.txt"}


def resolve_source(root: Path, relative: str) -> Path:
    rel = Path(relative)
    if not eligible(rel):
        raise PolicyError("Source is excluded by the local evidence policy")
    current = root
    for part in rel.parts:
        current = current / part
        if current.is_symlink():
            raise PolicyError("Symlinks are not eligible evidence sources")
    resolved = current.resolve(strict=True)
    if not resolved.is_relative_to(root) or not resolved.is_file():
        raise PolicyError("Source escapes the selected workspace or is not a regular file")
    return resolved


def read_source(root: Path, relative: str) -> bytes:
    """Walk with openat/O_NOFOLLOW: replacing a checked path cannot follow a symlink."""
    rel = Path(relative)
    if not eligible(rel):
        raise PolicyError("Source is excluded by the local evidence policy")
    directory = secure_open_directory(root)
    try:
        for component in rel.parts[:-1]:
            next_directory = os.open(component, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=directory)
            os.close(directory)
            directory = next_directory
        descriptor = os.open(rel.name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=directory)
        with os.fdopen(descriptor, "rb") as handle:
            if not stat.S_ISREG(os.fstat(handle.fileno()).st_mode):
                raise PolicyError("Evidence must be a regular file")
            limit = MAX_DOCUMENT_BYTES if rel.suffix.lower() in DOCUMENT_SUFFIXES else MAX_FILE_BYTES
            data = handle.read(limit + 1)
            if len(data) > limit:
                raise PolicyError("Source exceeds its read budget")
            return data
    finally:
        os.close(directory)


def discover(root: Path) -> tuple[list[Path], dict]:
    if not root.is_absolute() or not root.is_dir():
        raise PolicyError("An existing absolute workspace root is required")
    descriptor = secure_open_directory(root)
    try:
        rg = shutil.which("rg")
        if not rg:
            raise PolicyError("The Pixi-managed ripgrep executable is missing")
        # macOS /dev/fd entries cannot be used as directory pathnames. A tiny
        # fresh child fchdirs the pinned descriptor, then execs rg in-place.
        # Unlike preexec_fn this does not run Python after fork in a threaded parent.
        launcher = "import os,sys;os.fchdir(int(sys.argv[1]));os.execv(sys.argv[2],sys.argv[2:])"
        proc = subprocess.run(pixi_python("-c", launcher, str(descriptor), rg, "--no-config", "--files", "--null", "--no-require-git", "--no-ignore-dot", "--no-ignore-global", "--", "."), cwd="/", pass_fds=(descriptor,), capture_output=True, timeout=20)
    finally:
        os.close(descriptor)
    if proc.returncode not in (0, 1):
        raise PolicyError("File discovery failed")
    files: list[Path] = []
    excluded = 0
    size = 0
    for item in sorted(proc.stdout.split(b"\0")):
        if not item:
            continue
        rel = Path(item.decode("utf-8", errors="strict"))
        if not eligible(rel):
            excluded += 1
            continue
        try:
            source = resolve_source(root, str(rel))
            count = source.stat().st_size
        except (OSError, PolicyError):
            excluded += 1
            continue
        limit = MAX_DOCUMENT_BYTES if source.suffix.lower() in DOCUMENT_SUFFIXES else MAX_FILE_BYTES
        if count > limit:
            excluded += 1
            continue
        size += count
        files.append(rel)
        if len(files) > MAX_FILES or size > MAX_SOURCE_BYTES:
            raise PolicyError("Workspace exceeds the bounded indexing budget; select a narrower folder")
    return files, {"eligible_files": len(files), "excluded_files": excluded, "source_bytes": size}
