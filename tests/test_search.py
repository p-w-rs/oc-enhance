import importlib
import json
from concurrent.futures import ThreadPoolExecutor

import pytest

from open_enhance.evidence import read_evidence
from open_enhance.policy import PolicyError
from tests.fixtures import pdf_bytes

search_module = importlib.import_module("open_enhance.search")


def test_lexical_source_coordinates_and_no_backend(workspace, monkeypatch):
    lines = ["ordinary filler"] * 80
    lines[74] = "uniqueDispatchSymbol handles an exact operation"
    (workspace / "worker.py").write_text("\n".join(lines))

    def forbidden(*args):
        pytest.fail("Lexical searches must not call a semantic backend")

    monkeypatch.setattr(search_module, "semantic", forbidden)
    result = search_module.search(workspace, "uniqueDispatchSymbol", "lexical")
    assert result["route"] == "lexical"
    hit = result["results"][0]
    assert hit["evidence"]["path"] == "worker.py"
    assert hit["evidence"]["locator"]["line_start"] == 49
    assert hit["status"] == "verified"
    assert "uniqueDispatchSymbol" in read_evidence(workspace, hit["evidence"])["text"]


def test_refresh_removes_deleted_and_modified_units(workspace):
    source = workspace / "worker.py"
    source.write_text("obsolete_dispatch_marker")
    assert search_module.search(workspace, "obsolete_dispatch_marker", "lexical")["results"]
    home = search_module.workspace_home(workspace)
    source.write_text("replacement_dispatch_marker")
    assert not search_module.search(workspace, "obsolete", "lexical")["results"]
    assert search_module.search(workspace, "replacement", "lexical")["results"]
    source.unlink()
    assert not search_module.search(workspace, "replacement", "lexical")["results"]
    assert list((home / "mirror").iterdir()) == []
    assert json.loads((home / "manifest.json").read_text())["sources"] == {}


def test_empty_long_query_invalid_mode_and_limit(workspace):
    for query, mode, limit in [("", "lexical", 5), (" \n", "auto", 5), ("x" * 4001, "auto", 5),
                               ("x", "invalid", 5), ("x", "lexical", 0), ("x", "lexical", 11)]:
        with pytest.raises(PolicyError):
            search_module.search(workspace, query, mode, limit)
    assert not search_module.workspace_home(workspace).exists()


def test_empty_workspace_is_not_proof_of_absence(workspace):
    result = search_module.search(workspace, "unknown", "auto")
    assert result["results"] == []
    assert result["coverage"]["eligible_files"] == 0
    assert "do not prove absence" in result["notice"]


def test_absent_semantic_backend_falls_back_without_download(workspace):
    (workspace / "notes.txt").write_text("quarantine queue")
    for mode in ("auto", "semantic"):
        result = search_module.search(workspace, "quarantine", mode)
        assert result["route"] == "lexical_fallback"
        assert result["warning"]
        assert result["results"][0]["evidence"]["path"] == "notes.txt"


def test_semantic_remaps_mirror_ids_to_source_evidence(workspace, monkeypatch):
    (workspace / "handbook.md").write_text("Park repeatedly failing work for human review.")

    def mocked_semantic(home, query, limit):
        records, _ = search_module.prepare(workspace, home)
        assert query == "Where do poison messages go?"
        return [("unknown-forged-id.md", 1.0), (records[0]["id"], 0.9)]

    monkeypatch.setattr(search_module, "semantic", mocked_semantic)
    result = search_module.search(workspace, "Where do poison messages go?", "semantic")
    assert result["route"] == "semantic"
    assert len(result["results"]) == 1
    evidence = result["results"][0]["evidence"]
    assert evidence["path"] == "handbook.md"
    assert evidence["locator"]["line_start"] == 1
    assert read_evidence(workspace, evidence)["status"] == "verified"


@pytest.mark.parametrize("operation", ["modify", "delete"])
def test_semantic_race_drops_stale_results(workspace, monkeypatch, operation):
    source = workspace / "handbook.md"
    source.write_text("quarantine queue")

    def mocked_semantic(home, query, limit):
        records, _ = search_module.prepare(workspace, home)
        if operation == "modify":
            source.write_text("new unrelated source")
        else:
            source.unlink()
        return [(records[0]["id"], 0.9)]

    monkeypatch.setattr(search_module, "semantic", mocked_semantic)
    result = search_module.search(workspace, "quarantine", "semantic")
    assert result["results"] == []
    assert result["stale_results_dropped"] == 1


def test_hybrid_fusion_deduplicates_evidence_and_honors_limit(workspace, monkeypatch):
    for i in range(4):
        (workspace / f"note{i}.txt").write_text(f"quarantine queue number {i}")

    def mocked_semantic(home, query, limit):
        records, _ = search_module.prepare(workspace, home)
        return [(record["id"], 0.5) for record in reversed(records)]

    monkeypatch.setattr(search_module, "semantic", mocked_semantic)
    result = search_module.search(workspace, "quarantine", "auto", 2)
    paths = [hit["evidence"]["path"] for hit in result["results"]]
    assert result["route"] == "hybrid"
    assert len(paths) == len(set(paths)) == 2


def test_corrupt_binary_and_no_native_text_have_coverage_errors(workspace):
    (workspace / "binary.txt").write_bytes(b"not\0text")
    (workspace / "corrupt.pdf").write_bytes(b"not a PDF")
    (workspace / "scan.pdf").write_bytes(pdf_bytes([""]))
    (workspace / "good.md").write_text("valid quarantine instructions")
    result = search_module.search(workspace, "quarantine", "lexical")
    assert [hit["evidence"]["path"] for hit in result["results"]] == ["good.md"]
    failures = {item["path"]: item["reason"] for item in result["coverage"]["extraction_failures"]}
    assert set(failures) == {"binary.txt", "corrupt.pdf", "scan.pdf"}
    assert "No native text" in failures["scan.pdf"]
    repeated = search_module.search(workspace, "quarantine", "lexical")
    repeated_failures = {item["path"]: item["reason"] for item in repeated["coverage"]["extraction_failures"]}
    assert repeated_failures == failures, "Cached extraction must not hide missing native-text coverage"


def test_parallel_searches_share_atomic_manifest_and_leave_source_unchanged(workspace):
    source = workspace / "guide.md"
    source.write_text("quarantine queue human review\n")
    original = source.read_bytes()
    with ThreadPoolExecutor(max_workers=4) as pool:
        results = list(pool.map(lambda _: search_module.search(workspace, "quarantine", "lexical"), range(8)))
    assert all(result["results"][0]["status"] == "verified" for result in results)
    home = search_module.workspace_home(workspace)
    manifest = json.loads((home / "manifest.json").read_text())
    assert set(manifest["sources"]) == {"guide.md"}
    assert len(list((home / "mirror").iterdir())) == 1
    assert not list(home.rglob("*.tmp"))
    assert source.read_bytes() == original
    assert {path.name for path in workspace.iterdir()} == {"guide.md"}


def test_workspace_lock_releases_after_exception(tmp_path):
    home = tmp_path / "lock-test"
    with pytest.raises(RuntimeError):
        with search_module.workspace_lock(home):
            raise RuntimeError("synthetic failure")
    with search_module.workspace_lock(home):
        assert (home / "lock").exists()
