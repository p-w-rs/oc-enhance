import importlib

import pytest

from open_enhance.cli import dispatch
from open_enhance.policy import PolicyError

search_module = importlib.import_module("open_enhance.search")


@pytest.mark.parametrize("entrypoint", ["rpc", "search"])
def test_authorized_root_is_not_recanonicalized_after_ancestor_swap(tmp_path, entrypoint):
    parent = tmp_path / "original"
    source = parent / "workspace"
    source.mkdir(parents=True)
    (source / "guide.md").write_text("authorized content")
    outside = tmp_path / "outside"
    (outside / "workspace").mkdir(parents=True)
    (outside / "workspace/guide.md").write_text("not authorized evidence")
    inventory = dispatch({"operation": "inventory", "root": str(source)})
    parent.rename(tmp_path / "moved")
    parent.symlink_to(outside, target_is_directory=True)
    with pytest.raises((OSError, PolicyError)):
        if entrypoint == "rpc":
            dispatch({"operation": "search", "root": str(source), "query": "evidence", "mode": "lexical", "allowed_paths": inventory["paths"]})
        else:
            search_module.search(source, "evidence", "lexical", allowed_paths=inventory["paths"])
