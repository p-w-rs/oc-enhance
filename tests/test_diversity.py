import importlib

search_module = importlib.import_module("open_enhance.search")


def test_large_file_windows_do_not_consume_every_result_slot(workspace):
    (workspace / "large.md").write_text("quarantine queue worker failure\n" * 500)
    (workspace / "other.md").write_text("quarantine queue human review")
    result = search_module.search(workspace, "quarantine queue", "lexical", 5)
    paths = [hit["evidence"]["path"] for hit in result["results"]]
    assert len(paths) == len(set(paths)) == 2
    assert "other.md" in paths
