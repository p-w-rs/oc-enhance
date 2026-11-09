"""Handcrafted public corpus; never populated from a developer's projects.

Gold paths describe relevant evidence, not promises that a particular ranker
will find it. Unanswerable cases deliberately have no relevant source.
"""

from io import BytesIO
from pathlib import Path
from xml.sax.saxutils import escape
from zipfile import ZIP_DEFLATED, ZipFile, ZipInfo


def pdf_bytes(pages: list[str]) -> bytes:
    """Produce a tiny native-text PDF without a PDF generation dependency."""
    objects = [b"", b"", b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"]
    page_ids = []
    for text in pages:
        page_id = len(objects) + 1
        stream_id = page_id + 1
        page_ids.append(page_id)
        objects.append((f"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] "
                        f"/Resources << /Font << /F1 3 0 R >> >> /Contents {stream_id} 0 R >>").encode())
        escaped = text.replace("\\", "\\\\").replace("(", "\\(").replace(")", "\\)")
        stream = f"BT /F1 12 Tf 72 720 Td ({escaped}) Tj ET".encode("ascii") if text else b""
        objects.append(f"<< /Length {len(stream)} >>\nstream\n".encode() + stream + b"\nendstream")
    objects[0] = b"<< /Type /Catalog /Pages 2 0 R >>"
    kids = " ".join(f"{i} 0 R" for i in page_ids)
    objects[1] = f"<< /Type /Pages /Kids [{kids}] /Count {len(page_ids)} >>".encode()
    output = bytearray(b"%PDF-1.4\n")
    offsets = [0]
    for index, body in enumerate(objects, 1):
        offsets.append(len(output))
        output.extend(f"{index} 0 obj\n".encode() + body + b"\nendobj\n")
    xref = len(output)
    output.extend(f"xref\n0 {len(offsets)}\n0000000000 65535 f \n".encode())
    for offset in offsets[1:]:
        output.extend(f"{offset:010d} 00000 n \n".encode())
    output.extend((f"trailer\n<< /Size {len(offsets)} /Root 1 0 R >>\n"
                   f"startxref\n{xref}\n%%EOF\n").encode())
    return bytes(output)


def docx_bytes(paragraphs: list[str]) -> bytes:
    """Minimal ZIP/XML input: extraction does not need python-docx or Office."""
    body = "".join(f"<w:p><w:r><w:t>{escape(text)}</w:t></w:r></w:p>" for text in paragraphs)
    document = ('<?xml version="1.0" encoding="UTF-8"?>'
                '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">'
                f"<w:body>{body}</w:body></w:document>")
    result = BytesIO()
    with ZipFile(result, "w", ZIP_DEFLATED) as archive:
        entry = ZipInfo("word/document.xml", date_time=(2020, 1, 1, 0, 0, 0))
        entry.compress_type = ZIP_DEFLATED
        archive.writestr(entry, document)
    return result.getvalue()


def create_corpus(root: Path) -> list[dict]:
    """Write an entirely synthetic service repository and return stable gold cases."""
    root.mkdir(parents=True, exist_ok=True)
    sources = {
        "src/leases.py": 'def renewLease(lease, now):\n    """Extend a worker reservation by 90 seconds after a heartbeat."""\n    return {**lease, "expires_at": now + 90}\n',
        "src/retry.py": 'def retry_delay(attempt):\n    """Exponential retry backoff capped at 32 seconds; jitter is applied by the caller."""\n    return min(2 ** attempt, 32)\n',
        "src/uploads.py": 'MAX_UPLOAD_BYTES = 8 * 1024 * 1024\n# Reject oversized attachments before reading them into memory.\n',
        "src/routes.py": 'ROUTES = {"POST /v2/export": "queue_export", "GET /health": "health_check"}\n',
        "docs/operations.md": '# Operations\nThe dispatcher parks failed jobs in a quarantine queue after five unsuccessful deliveries.\nAn operator must approve replay; automatic replay is disabled.\n',
        "docs/storage.md": '# Blob storage\nObjects are addressed by SHA-256 content digest.\nRepeated uploads of identical bytes reuse the existing object.\n',
        "docs/releases/v1.md": '# Version 1 (retired)\nExports are retained for 30 days.\nThe old worker used port 7100.\n',
        "docs/releases/v2.md": '# Version 2 (current)\nExports are retained for 7 days, replacing the version 1 policy.\nThe worker listens on port 7200.\n',
        "docs/deployment.md": '# Deployments\nDrain active jobs before stopping a worker.\nA readiness probe becomes false while draining; the liveness probe remains true.\n',
        "docs/ownership.md": '# Team ownership\nThe Meridian team owns the export pipeline.\nThe Harbor team owns billing reconciliation.\n',
        "docs/escalation.md": '# On-call escalation\nFor Meridian incidents, page the constellation rotation.\nFor Harbor incidents, page the lighthouse rotation.\n',
        "notes/accessibility.txt": 'The status board never conveys health by color alone. Each state has an icon and a written label.\nKeyboard focus follows the visible card order.\n',
        "data/regions.csv": 'region,currency,cutoff_utc\nnorth,EUR,16:00\nsouth,USD,20:30\n',
        "config/service.toml": '[worker]\nconcurrency = 6\nshutdown_grace_seconds = 45\n',
        "README.md": '# Lantern dispatch\nA fictional batch processing service for testing local retrieval.\nSee docs/releases/v2.md for current production policy.\n',
    }
    for relative, text in sources.items():
        path = root / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text, encoding="utf-8")
    (root / "docs/disaster-recovery.pdf").write_bytes(pdf_bytes([
        "Recovery manual. Backups are encrypted and copied to the secondary region every six hours.",
        "Restore rehearsal. Validate row counts before reopening the ingestion gateway.",
    ]))
    (root / "docs/support.docx").write_bytes(docx_bytes([
        "Support handover", "Escalate duplicate invoices to Harbor after checking the reconciliation ledger.",
    ]))
    # Queries deliberately vary vocabulary rather than repeating document sentences.
    definitions = [
        ("lease-symbol", "renewLease", ["src/leases.py"], "exact", "90"),
        ("upload-symbol", "MAX_UPLOAD_BYTES", ["src/uploads.py"], "exact", "8 * 1024"),
        ("route", "POST /v2/export", ["src/routes.py"], "exact", "queue_export"),
        ("backoff", "How long can a retry pause grow?", ["src/retry.py"], "semantic", "32 seconds"),
        ("heartbeat", "Where does a worker keep its reservation alive?", ["src/leases.py"], "semantic", "heartbeat"),
        ("dead-letter", "What happens when a task keeps failing delivery?", ["docs/operations.md"], "semantic", "quarantine"),
        ("replay", "Can quarantined work restart without human approval?", ["docs/operations.md"], "semantic", "operator"),
        ("dedup", "How do we avoid storing the same payload twice?", ["docs/storage.md"], "semantic", "identical bytes"),
        ("current-retention", "How long are exports kept in the current release?", ["docs/releases/v2.md"], "semantic", "7 days"),
        ("old-retention", "What was the export expiry period in version one?", ["docs/releases/v1.md"], "semantic", "30 days"),
        ("current-port", "Which port does the version 2 worker accept connections on?", ["docs/releases/v2.md"], "semantic", "7200"),
        ("drain", "How can a worker shut down without abandoning running work?", ["docs/deployment.md"], "semantic", "Drain active jobs"),
        ("readiness", "Does draining mark a process dead or merely unavailable?", ["docs/deployment.md"], "semantic", "liveness"),
        ("accessible", "How can someone who cannot distinguish colors read system health?", ["notes/accessibility.txt"], "semantic", "written label"),
        ("csv", "When is the south region cutoff in UTC?", ["data/regions.csv"], "semantic", "20:30"),
        ("concurrency", "How many jobs may a worker process at once?", ["config/service.toml"], "semantic", "concurrency = 6"),
        ("backup", "How often does a second region receive a recovery copy?", ["docs/disaster-recovery.pdf"], "semantic", "six hours"),
        ("restore", "What check precedes opening ingestion after disaster recovery?", ["docs/disaster-recovery.pdf"], "semantic", "row counts"),
        ("invoice", "Who handles a customer being billed twice?", ["docs/support.docx"], "semantic", "Harbor"),
        ("export-page", "Which on-call rotation should an export pipeline incident page?", ["docs/ownership.md", "docs/escalation.md"], "multihop", None),
        ("retention-change", "How did export retention change between versions one and two?", ["docs/releases/v1.md", "docs/releases/v2.md"], "multihop", None),
        ("unknown-sla", "What contractual uptime percentage is guaranteed?", [], "unanswerable", None),
        ("unknown-mobile", "Where is the Android application signing procedure?", [], "unanswerable", None),
    ]
    return [dict(id=identifier, query=query, expected=expected, kind=kind,
                 **({"expected_phrase": phrase} if phrase else {}))
            for identifier, query, expected, kind, phrase in definitions]
