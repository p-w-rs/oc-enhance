import shutil
import sys
from pathlib import Path

import pytest


@pytest.fixture(autouse=True)
def isolated_home(tmp_path, monkeypatch):
    monkeypatch.setenv("OPEN_ENHANCE_HOME", str(tmp_path / "enhance-data"))
    rg = shutil.which("rg")
    assert rg, "Run tests through pixi: the managed ripgrep is required"
    assert Path(rg).resolve().is_relative_to(Path(sys.prefix).resolve()), "Use ripgrep from the pixi environment"


@pytest.fixture
def workspace(tmp_path):
    root = tmp_path / "workspace"
    root.mkdir()
    return root
