import pytest

from open_enhance.evidence import read_evidence, token
from open_enhance.extract import digest, extract
from open_enhance.policy import PolicyError
from tests.fixtures import docx_bytes, pdf_bytes


def source_token(root, relative="source.txt", data=b"first\n\nthird\n", unit=0):
    source = root / relative
    source.write_bytes(data)
    return token(relative, digest(data), extract(data, source.suffix)[unit].locator)


def test_precise_original_line_evidence_and_detached_token(workspace):
    lines = [f"original line {i}" for i in range(1, 91)]
    evidence = source_token(workspace, data="\n".join(lines).encode(), unit=1)
    assert evidence["locator"]["line_start"] == 49
    verified = read_evidence(workspace, evidence)
    assert verified["status"] == "verified"
    assert verified["text"] == "\n".join(lines[48:])
    assert not verified["truncated"]
    assert "untrusted" in verified["warning"]
    locator = {"kind": "lines", "line_start": 1, "line_end": 2}
    detached = token("source.txt", "a" * 64, locator)
    locator["line_start"] = 999
    assert detached["locator"]["line_start"] == 1


def test_modification_and_forged_sha_are_stale(workspace):
    evidence = source_token(workspace)
    forged = {**evidence, "sha256": "0" * 64}
    assert read_evidence(workspace, forged)["status"] == "stale"
    (workspace / "source.txt").write_text("replaced content")
    result = read_evidence(workspace, evidence)
    assert result["status"] == "stale"
    assert "text" not in result


def test_deleted_source_is_not_verified(workspace):
    evidence = source_token(workspace)
    (workspace / "source.txt").unlink()
    with pytest.raises((OSError, PolicyError)):
        read_evidence(workspace, evidence)


def test_forged_locator_rejected(workspace):
    evidence = source_token(workspace)
    evidence["locator"]["line_start"] = 2
    with pytest.raises(PolicyError, match="locator"):
        read_evidence(workspace, evidence)


def test_forged_traversal_and_symlink_tokens_rejected(workspace, tmp_path):
    evidence = source_token(workspace)
    outside = tmp_path / "outside.txt"
    outside.write_bytes((workspace / "source.txt").read_bytes())
    (workspace / "alias.txt").symlink_to(outside)
    for path in ("../outside.txt", str(outside), "alias.txt"):
        with pytest.raises((PolicyError, OSError)):
            read_evidence(workspace, {**evidence, "path": path})


def test_document_evidence_uses_original_page_and_paragraph(workspace):
    for name, data, key in (
        ("manual.pdf", pdf_bytes(["first page", "second page"]), "page"),
        ("manual.docx", docx_bytes(["first paragraph", "second paragraph"]), "paragraph"),
    ):
        evidence = source_token(workspace, name, data, unit=1)
        assert evidence["locator"][key] == 2
        assert "second" in read_evidence(workspace, evidence)["text"]


def test_evidence_truncation_is_explicit(workspace):
    evidence = source_token(workspace, data=b"x" * 13000)
    result = read_evidence(workspace, evidence)
    assert len(result["text"]) == 12000
    assert result["truncated"] is True
