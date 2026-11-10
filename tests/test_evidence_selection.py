from pathlib import Path

import pytest

from open_enhance.cli import dispatch
from open_enhance.policy import PolicyError, discover, eligible


def test_scoped_partial_inventory_and_search(workspace):
    (workspace / "docs").mkdir()
    (workspace / "docs/a.md").write_text("quarantine queue")
    (workspace / "docs/b.md").write_text("quarantine queue")
    (workspace / "outside.md").write_text("quarantine outside")
    request = {"root": str(workspace), "scope": "docs", "policy": {"maxFiles": 1}}
    inventory = dispatch({**request, "operation": "inventory"})
    assert inventory["paths"] == ["docs/a.md"]
    assert inventory["coverage"]["truncated"] is True
    result = dispatch({**request, "operation": "search", "query": "quarantine", "mode": "lexical", "allowed_paths": inventory["paths"]})
    assert [hit["evidence"]["path"] for hit in result["results"]] == ["docs/a.md"]
    assert result["coverage"]["truncated"] is True


def test_filename_filters_can_be_explicitly_adjusted(workspace):
    (workspace / "tokens.ts").write_text("synthetic token type declaration")
    (workspace / ".notes.md").write_text("synthetic hidden notes")
    assert not eligible(Path("tokens.ts"))
    options = {"includeSensitiveNames": True, "includeHidden": True, "includeGenerated": True}
    files, _ = discover(workspace, options)
    assert {str(p) for p in files} == {"tokens.ts", ".notes.md"}
    assert not eligible(Path(".git/config"), options)
    assert not eligible(Path(".local/cache.txt"), options)


def test_invalid_scope_and_policy_never_escape_or_remove_bounds(workspace):
    for options in [{"maxFiles": 5001}, {"maxSourceBytes": -1}, {"includeHidden": "yes"}, {"unknown": True}]:
        with pytest.raises(PolicyError):
            discover(workspace, options)
    with pytest.raises(PolicyError):
        discover(workspace, scope="../outside")


def test_single_token_read_does_not_require_whole_workspace_budget(workspace):
    (workspace / "a.md").write_text("synthetic first document")
    (workspace / "z.md").write_text("quarantine queue target")
    root = {"root": str(workspace)}
    result = dispatch({**root, "operation": "search", "query": "quarantine", "mode": "lexical"})
    token = result["results"][0]["evidence"]
    verified = dispatch({**root, "operation": "read", "evidence": token, "policy": {"maxFiles": 1, "maxSourceBytes": 1}})
    assert verified["status"] == "verified"
