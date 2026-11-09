from __future__ import annotations

import os
import secrets
import stat
from pathlib import Path

from .policy import PolicyError, secure_open_directory


class SafeDirectory:
    """Descriptor-relative cache I/O. Cache symlinks never become source writes."""

    def __init__(self, path: Path, *, create: bool = False):
        self.fd = secure_open_directory(path, create=create)

    def __enter__(self):
        return self

    def __exit__(self, *args):
        os.close(self.fd)

    @staticmethod
    def name(value: str) -> str:
        if not value or value in {".", ".."} or "/" in value or "\0" in value:
            raise PolicyError("Invalid cache entry")
        return value

    def read(self, name: str, *, limit: int = 128 * 1024 * 1024) -> bytes | None:
        try:
            descriptor = os.open(self.name(name), os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=self.fd)
        except FileNotFoundError:
            return None
        with os.fdopen(descriptor, "rb") as handle:
            if not stat.S_ISREG(os.fstat(handle.fileno()).st_mode):
                raise PolicyError("Cache entry is not a regular file")
            data = handle.read(limit + 1)
            if len(data) > limit:
                raise PolicyError("Cache entry exceeds its budget")
            return data

    def write(self, name: str, data: bytes) -> None:
        name = self.name(name)
        temporary = f".write-{secrets.token_hex(16)}"
        descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=self.fd)
        try:
            with os.fdopen(descriptor, "wb") as handle:
                handle.write(data)
                handle.flush()
            os.replace(temporary, name, src_dir_fd=self.fd, dst_dir_fd=self.fd)
        finally:
            try:
                os.unlink(temporary, dir_fd=self.fd)
            except FileNotFoundError:
                pass

    def entries(self) -> list[str]:
        return os.listdir(self.fd)

    def lock_file(self) -> int:
        # Separate existing/open and exclusive/create paths. On macOS a racing
        # O_CREAT|O_NOFOLLOW can report ENOENT even after another creator wins.
        for _ in range(10):
            try:
                descriptor = os.open("lock", os.O_WRONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=self.fd)
            except FileNotFoundError:
                try:
                    descriptor = os.open("lock", os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_NONBLOCK, 0o600, dir_fd=self.fd)
                except (FileExistsError, FileNotFoundError):
                    continue
            if not stat.S_ISREG(os.fstat(descriptor).st_mode):
                os.close(descriptor)
                raise PolicyError("Workspace lock must be a regular file")
            return descriptor
        raise PolicyError("Unable to acquire a stable workspace lock file")

    def unlink_file(self, name: str) -> None:
        info = os.stat(self.name(name), dir_fd=self.fd, follow_symlinks=False)
        if stat.S_ISREG(info.st_mode) or stat.S_ISLNK(info.st_mode):
            os.unlink(name, dir_fd=self.fd)
