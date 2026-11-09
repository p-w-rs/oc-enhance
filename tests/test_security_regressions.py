"""Synthetic regressions for source confinement, policy, and cache recovery."""

import importlib
import json
import os
from pathlib import Path
from subprocess import CompletedProcess

import pytest

from open_enhance.evidence import read_evidence
from open_enhance.extract import digest
from open_enhance.policy import PolicyError, discover, read_source

search_module = importlib.import_module("open_enhance.search")


def snapshot(root):
    return {
        str(path.relative_to(root)): path.read_bytes() if path.is_file() else None
        for path in root.rglob("*")
    }


def assert_lexical_hit(result):
    assert result["results"]
    assert result["results"][0]["evidence"]["path"] == "guide.md"
    assert result["results"][0]["status"] == "verified"
    assert "quarantine queue" in result["results"][0]["text"]


def test_mirror_directory_symlink_never_mutates_sources(workspace):
    (workspace / "guide.md").write_text("quarantine queue")
    (workspace / "unrelated.txt").write_text("must never be deleted")
    home = search_module.workspace_home(workspace)
    home.mkdir(parents=True)
    (home / "mirror").symlink_to(workspace, target_is_directory=True)
    before = snapshot(workspace)

    try:
        search_module.search(workspace, "quarantine", "lexical")
    except (OSError, PolicyError):
        pass  # Rejection and safe replacement both preserve the source boundary.
    finally:
        assert snapshot(workspace) == before


@pytest.mark.parametrize("suffix", [".md", ".tmp"])
def test_mirror_output_symlink_never_changes_original_file(workspace, suffix):
    source = workspace / "guide.md"
    source.write_text("quarantine queue")
    home = search_module.workspace_home(workspace)
    mirror = home / "mirror"
    mirror.mkdir(parents=True)
    identifier = digest(b"guide.md")[:20] + "-0"
    (mirror / (identifier + suffix)).symlink_to(source)
    before = snapshot(workspace)

    try:
        search_module.search(workspace, "quarantine", "lexical")
    except (OSError, PolicyError):
        pass
    finally:
        assert snapshot(workspace) == before


@pytest.mark.parametrize("placement", ["inside", "equal", "ancestor"])
def test_overlapping_source_and_data_directories_are_rejected(workspace, monkeypatch, placement):
    (workspace / "guide.md").write_text("quarantine queue")
    data = {
        "inside": workspace / "storage",
        "equal": workspace,
        "ancestor": workspace.parent,
    }[placement]
    monkeypatch.setenv("OPEN_ENHANCE_HOME", str(data))
    before = snapshot(workspace)
    try:
        with pytest.raises((PolicyError, OSError)):
            search_module.search(workspace, "quarantine", "lexical")
    finally:
        assert snapshot(workspace) == before


def test_source_read_rejects_replaced_ancestor_symlink(tmp_path):
    parent = tmp_path / "approved-parent"
    root = parent / "project"
    root.mkdir(parents=True)
    (root / "guide.md").write_text("approved synthetic source")
    other = tmp_path / "unapproved-parent"
    (other / "project").mkdir(parents=True)
    (other / "project" / "guide.md").write_text("unapproved synthetic source")
    # The caller retained this canonical path before an ancestor was replaced.
    root = root.resolve(strict=True)
    parent.rename(tmp_path / "saved-parent")
    parent.symlink_to(other, target_is_directory=True)

    with pytest.raises((PolicyError, OSError)):
        read_source(root, "guide.md")


def test_ignore_file_cannot_unignore_gitignored_source(workspace):
    (workspace / ".git").mkdir()
    (workspace / "guide.md").write_text("quarantine queue")
    (workspace / "excluded.md").write_text("synthetic excluded content")
    (workspace / ".gitignore").write_text("excluded.md\n")
    (workspace / ".ignore").write_text("!excluded.md\n")

    paths, _ = discover(workspace)
    assert {str(path) for path in paths} == {"guide.md"}
    result = search_module.search(workspace, "quarantine", "lexical")
    assert_lexical_hit(result)
    manifest = json.loads((search_module.workspace_home(workspace) / "manifest.json").read_text())
    assert set(manifest["sources"]) == {"guide.md"}


def test_old_evidence_token_rejected_when_source_becomes_gitignored(workspace):
    (workspace / ".git").mkdir()
    (workspace / "guide.md").write_text("quarantine queue")
    result = search_module.search(workspace, "quarantine", "lexical")
    evidence = result["results"][0]["evidence"]
    assert read_evidence(workspace, evidence)["status"] == "verified"
    (workspace / ".gitignore").write_text("guide.md\n")

    with pytest.raises(PolicyError):
        read_evidence(workspace, evidence)


@pytest.mark.parametrize("manifest", ["{", "null", '{"sources": []}'])
def test_malformed_manifest_is_rebuilt_for_lexical_search(workspace, manifest):
    (workspace / "guide.md").write_text("quarantine queue")
    home = search_module.workspace_home(workspace)
    home.mkdir(parents=True)
    (home / "manifest.json").write_text(manifest)

    assert_lexical_hit(search_module.search(workspace, "quarantine", "lexical"))
    repaired = json.loads((home / "manifest.json").read_text())
    assert set(repaired["sources"]) == {"guide.md"}


@pytest.mark.parametrize("units", [[None], "not-a-unit-list", [{"text": 123, "locator": {}}], [{"text": "invalid cache", "locator": []}]])
def test_malformed_cached_units_are_reextracted(workspace, units):
    (workspace / "guide.md").write_text("quarantine queue")
    assert_lexical_hit(search_module.search(workspace, "quarantine", "lexical"))
    manifest_path = search_module.workspace_home(workspace) / "manifest.json"
    manifest = json.loads(manifest_path.read_text())
    manifest["sources"]["guide.md"]["units"] = units
    manifest_path.write_text(json.dumps(manifest))

    assert_lexical_hit(search_module.search(workspace, "quarantine", "lexical"))
    repaired = json.loads(manifest_path.read_text())
    assert repaired["sources"]["guide.md"]["units"][0]["text"] == "quarantine queue"


@pytest.mark.parametrize("mode", ["auto", "semantic"])
@pytest.mark.parametrize("error_type", [ValueError, AttributeError, OSError])
def test_semantic_errors_fall_back_to_verified_lexical_results(workspace, monkeypatch, mode, error_type):
    (workspace / "guide.md").write_text("quarantine queue")

    def broken_backend(*args):
        raise error_type("synthetic backend failure")

    monkeypatch.setattr(search_module, "semantic", broken_backend)
    result = search_module.search(workspace, "quarantine", mode)
    assert result["route"] == "lexical_fallback"
    assert result["warning"]
    assert_lexical_hit(result)


@pytest.mark.parametrize("payload", [None, {"results": [{"file": "unit.md", "score": "not-numeric"}]}])
def test_semantic_validates_actual_backend_json(tmp_path, monkeypatch, payload):
    data = Path(os.environ["OPEN_ENHANCE_HOME"])
    (data / "bin").mkdir(parents=True)
    (data / "bin" / "colgrep").touch()
    (data / "models" / "lateon-code-edge").mkdir(parents=True)
    home = tmp_path / "backend-workspace"
    (home / "mirror").mkdir(parents=True)
    calls = []

    def backend_run(command, **kwargs):
        calls.append((command, kwargs))
        return CompletedProcess(command, 0, stdout=json.dumps(payload).encode(), stderr=b"")

    monkeypatch.setattr(search_module.subprocess, "run", backend_run)
    with pytest.raises((ValueError, RuntimeError)):
        search_module.semantic(home, "quarantine", 5)
    assert len(calls) == 1
    assert calls[0][1]["cwd"] == "/"
    assert calls[0][1]["pass_fds"]
    assert any("fchdir" in arg for arg in calls[0][0])
