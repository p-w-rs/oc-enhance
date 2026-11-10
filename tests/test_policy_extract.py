from io import BytesIO
from pathlib import Path
from zipfile import ZipFile

import pytest

from open_enhance import policy
from open_enhance.extract import digest, extract, terms
from tests.fixtures import create_corpus, docx_bytes, pdf_bytes


def test_discovery_filters_sensitive_hidden_ignored_vendor_and_symlinks(workspace, tmp_path):
    files = ["src/ok.py", "notes.txt", ".hidden.md", ".config/info.txt", "vendor/lib.py",
             "node_modules/pkg/a.js", "secrets.json", "credentials.yaml", "private_key.txt", "ignored.md"]
    for name in files:
        path = workspace / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text("synthetic input")
    (workspace / ".git").mkdir()
    (workspace / ".gitignore").write_text("ignored.md\n")
    outside = tmp_path / "outside.txt"
    outside.write_text("outside root")
    (workspace / "link.txt").symlink_to(outside)
    (workspace / "linked").symlink_to(tmp_path, target_is_directory=True)
    discovered, stats = policy.discover(workspace)
    assert {str(path) for path in discovered} == {"src/ok.py", "notes.txt"}
    assert stats["eligible_files"] == 2


def test_resolve_rejects_traversal_and_symlink(workspace, tmp_path):
    (tmp_path / "outside.txt").write_text("outside")
    (workspace / "alias.txt").symlink_to(tmp_path / "outside.txt")
    for name in ("../outside.txt", str(tmp_path / "outside.txt"), "alias.txt", ".env"):
        with pytest.raises(policy.PolicyError):
            policy.resolve_source(workspace, name)


def test_discovery_respects_file_and_total_budgets(workspace, monkeypatch):
    (workspace / "large.txt").write_bytes(b"x" * 12)
    (workspace / "small.txt").write_bytes(b"abc")
    monkeypatch.setattr(policy, "MAX_FILE_BYTES", 10)
    files, stats = policy.discover(workspace)
    assert [str(path) for path in files] == ["small.txt"]
    assert stats["source_bytes"] == 3
    monkeypatch.setattr(policy, "MAX_SOURCE_BYTES", 2)
    files, stats = policy.discover(workspace)
    assert files == []
    assert stats["truncated"] is True


def test_discovery_ignores_user_rg_configuration_and_handles_ragged_paths(workspace, tmp_path, monkeypatch):
    config = tmp_path / "ripgrep-config"
    config.write_text("--glob=!*.txt\n")
    monkeypatch.setenv("RIPGREP_CONFIG_PATH", str(config))
    names = {"with spaces.txt", "with\nnewline.txt", "-option.txt", "résumé.txt"}
    for name in names:
        (workspace / name).write_text("synthetic text")
    files, _ = policy.discover(workspace)
    assert {str(path) for path in files} == names


def test_bounded_read_source_rejects_symlink_parents_and_nonregular_files(workspace, tmp_path, monkeypatch):
    import os

    (tmp_path / "outside.txt").write_text("outside")
    (workspace / "linked").symlink_to(tmp_path, target_is_directory=True)
    os.mkfifo(workspace / "pipe.txt")
    for name in ("linked/outside.txt", "pipe.txt"):
        with pytest.raises((OSError, policy.PolicyError)):
            policy.read_source(workspace, name)
    (workspace / "large.txt").write_text("0123456789")
    monkeypatch.setattr(policy, "MAX_FILE_BYTES", 5)
    with pytest.raises(policy.PolicyError, match="budget"):
        policy.read_source(workspace, "large.txt")


def test_text_utf8_bom_blank_lines_and_original_coordinates():
    lines = [f"line {i} café" if i != 2 else "" for i in range(1, 81)]
    units = extract(b"\xef\xbb\xbf" + "\r\n".join(lines).encode(), ".txt")
    assert [(u.locator["line_start"], u.locator["line_end"]) for u in units] == [(1, 64), (49, 80)]
    assert units[0].text == "\n".join(lines[:64])
    assert units[1].text == "\n".join(lines[48:])


def test_binary_and_invalid_utf8_rejected():
    for data in (b"header\0payload", b"\xff\xfeinvalid"):
        with pytest.raises(ValueError):
            extract(data, ".txt")
    assert extract(b"\n \n", ".txt") == []


def test_tokenization_and_sha256():
    assert terms("renewLease retry_delay CAFÉ") == ["renew", "lease", "retry", "delay", "café"]
    assert digest(b"abc") == "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"


def test_native_pdf_multiple_pages_and_empty_scanned_equivalent():
    units = extract(pdf_bytes(["First page recovery", "", "Third page checklist"]), ".pdf")
    assert [u.locator["page"] for u in units] == [1, 3]
    assert "First page recovery" in units[0].text
    assert "Third page checklist" in units[1].text
    assert all(u.locator["extraction"] == "native_pdf_text" for u in units)
    # No text operators, like an image-only scan: never manufacture OCR text.
    assert extract(pdf_bytes([""]), ".pdf") == []


def test_docx_paragraph_numbers_preserve_empty_paragraphs():
    units = extract(docx_bytes(["One & two", "", "Résumé handover"]), ".docx")
    assert [u.text for u in units] == ["One & two", "Résumé handover"]
    assert [u.locator["paragraph"] for u in units] == [1, 3]


def test_docx_rejects_entities():
    data = BytesIO()
    with ZipFile(data, "w") as archive:
        archive.writestr("word/document.xml", '<!DOCTYPE x [<!ENTITY x "bad">]><x/>')
    with pytest.raises(ValueError, match="entities"):
        extract(data.getvalue(), ".docx")


def test_synthetic_corpus_gold_contract_and_repeatability(workspace, tmp_path):
    cases = create_corpus(workspace)
    other = tmp_path / "repeat"
    assert create_corpus(other) == cases
    assert len(cases) >= 18
    assert len({case["id"] for case in cases}) == len(cases)
    assert {case["kind"] for case in cases} == {"exact", "semantic", "multihop", "unanswerable"}
    for case in cases:
        assert bool(case["expected"]) == (case["kind"] != "unanswerable")
        for relative in case["expected"]:
            assert policy.eligible(Path(relative))
            source = workspace / relative
            assert source.read_bytes() == (other / relative).read_bytes()
            if phrase := case.get("expected_phrase"):
                assert phrase.casefold() in " ".join(u.text for u in extract(source.read_bytes(), source.suffix)).casefold()
