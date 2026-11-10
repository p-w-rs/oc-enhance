import importlib
import json

import pytest

from open_enhance.cli import dispatch

search_module = importlib.import_module("open_enhance.search")


def test_inventory_does_not_extract_source(workspace, monkeypatch):
    (workspace / "guide.md").write_text("eligible source")

    def forbidden(*args):
        pytest.fail("Inventory must not read or extract source content")

    monkeypatch.setattr(search_module, "extract", forbidden)
    result = dispatch({"operation": "inventory", "root": str(workspace)})
    assert result["paths"] == ["guide.md"]
    assert not search_module.workspace_home(workspace).exists()


def test_files_added_after_authorization_never_enter_index(workspace):
    (workspace / "approved.md").write_text("quarantine queue")
    inventory = dispatch({"operation": "inventory", "root": str(workspace)})
    (workspace / "unapproved.md").write_text("quarantine queue extra")
    result = dispatch({"operation": "search", "root": str(workspace), "query": "quarantine", "mode": "lexical", "allowed_paths": inventory["paths"]})
    assert [hit["evidence"]["path"] for hit in result["results"]] == ["approved.md"]
    manifest = json.loads((search_module.workspace_home(workspace, search_module.selection_key(inventory["paths"])) / "manifest.json").read_text())
    assert set(manifest["sources"]) == {"approved.md"}


def test_empty_authorization_uses_an_empty_isolated_index(workspace):
    (workspace / "guide.md").write_text("quarantine queue")
    assert search_module.search(workspace, "quarantine", "lexical")["results"]
    result = search_module.search(workspace, "quarantine", "lexical", allowed_paths=[])
    assert result["results"] == []
    assert not list((search_module.workspace_home(workspace, search_module.selection_key([])) / "mirror").iterdir())


@pytest.mark.parametrize("allowed", ["guide.md", [1], [None]])
def test_invalid_authorization_shape_is_rejected(workspace, allowed):
    with pytest.raises(ValueError):
        dispatch({"operation": "search", "root": str(workspace), "query": "test", "allowed_paths": allowed})
