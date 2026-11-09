from __future__ import annotations

import hashlib
import re
import zipfile
from dataclasses import dataclass
from io import BytesIO
from pathlib import Path
from xml.etree import ElementTree


@dataclass(frozen=True)
class Unit:
    text: str
    locator: dict


def digest(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def extract(data: bytes, suffix: str) -> list[Unit]:
    if suffix in {".pdf", ".docx"}:
        from .document_worker import extract_isolated
        return extract_isolated(data, suffix)
    return extract_raw(data, suffix)


def extract_raw(data: bytes, suffix: str) -> list[Unit]:
    """Native extraction only. No OCR hallucinations or execution of embedded content."""
    if suffix == ".pdf":
        from pypdf import PdfReader

        reader = PdfReader(BytesIO(data), strict=True)
        if reader.is_encrypted:
            raise ValueError("Encrypted PDFs are not indexed")
        if len(reader.pages) > 200:
            raise ValueError("PDF exceeds 200-page extraction budget")
        units = []
        for number, page in enumerate(reader.pages, start=1):
            text = page.extract_text() or ""
            if text.strip():
                units.append(Unit(text, {"kind": "pdf_page", "page": number, "extraction": "native_pdf_text"}))
        return units
    if suffix == ".docx":
        with zipfile.ZipFile(BytesIO(data)) as archive:
            info = archive.getinfo("word/document.xml")
            if info.file_size > 8 * 1024 * 1024:
                raise ValueError("DOCX XML exceeds extraction budget")
            xml = archive.read(info)
            if b"<!DOCTYPE" in xml.upper() or b"<!ENTITY" in xml.upper():
                raise ValueError("XML entities are not supported")
            tree = ElementTree.fromstring(xml)
        ns = {"w": "http://schemas.openxmlformats.org/wordprocessingml/2006/main"}
        paragraphs = ["".join(p.itertext()) for p in tree.findall(".//w:p", ns)]
        return [Unit(text, {"kind": "docx_paragraph", "paragraph": i, "extraction": "native_docx_text"}) for i, text in enumerate(paragraphs, 1) if text.strip()]
    if b"\0" in data:
        raise ValueError("Binary text source is not indexed")
    text = data.decode("utf-8-sig", errors="strict")
    lines = text.splitlines()
    units: list[Unit] = []
    # Overlapping bounded windows preserve original line coordinates, including blank lines.
    for start in range(0, len(lines), 48):
        end = min(start + 64, len(lines))
        content = "\n".join(lines[start:end])
        if content.strip():
            units.append(Unit(content, {"kind": "lines", "line_start": start + 1, "line_end": end, "extraction": "utf8_source"}))
        if end == len(lines):
            break
    return units


def terms(text: str) -> list[str]:
    split = re.sub(r"([a-z0-9])([A-Z])", r"\1 \2", text)
    return re.findall(r"[^\W_]+", split.casefold(), re.UNICODE)
