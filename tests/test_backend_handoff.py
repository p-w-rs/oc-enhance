import importlib
import json
import os
import shutil
import time
from pathlib import Path

import pytest

from open_enhance.policy import PolicyError

search_module = importlib.import_module("open_enhance.search")


def test_fifo_lock_never_blocks_before_deadline(workspace):
    home = search_module.workspace_home(workspace)
    home.mkdir(parents=True)
    os.mkfifo(home / "lock")
    before = time.monotonic()
    with pytest.raises((OSError, PolicyError)):
        with search_module.workspace_lock(home):
            pytest.fail("A FIFO cannot be used as a workspace lock")
    assert time.monotonic() - before < 1


def test_mirror_replacement_at_backend_launch_cannot_redirect_reads(tmp_path, monkeypatch):
    data = Path(os.environ["OPEN_ENHANCE_HOME"])
    (data / "bin").mkdir(parents=True)
    binary = data / "bin/colgrep"
    node = shutil.which("node")
    assert node, "Use the Pixi-managed test environment"
    binary.write_text(f"#!{node}\nconsole.log(JSON.stringify(require('node:fs').readdirSync('.').map(name=>({{unit:{{file:name}},score:1}}))))\n")
    binary.chmod(0o700)
    (data / "models/lateon-code-edge").mkdir(parents=True)
    home = tmp_path / "index"
    mirror = home / "mirror"
    mirror.mkdir(parents=True)
    (mirror / "allowed.md").write_text("approved mirror")
    outside = tmp_path / "outside"
    outside.mkdir()
    (outside / "not-authorized.md").write_text("outside source")
    original_run = search_module.subprocess.run

    def replace_before_spawn(command, **kwargs):
        mirror.rename(home / "pinned-mirror")
        mirror.symlink_to(outside, target_is_directory=True)
        return original_run(command, **kwargs)

    monkeypatch.setattr(search_module.subprocess, "run", replace_before_spawn)
    assert search_module.semantic(home, "query", 5) == [("allowed.md", 1.0)]
    assert (outside / "not-authorized.md").read_text() == "outside source"
