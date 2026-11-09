"""Repeatable retrieval experiments. No private source text enters aggregate reports."""
from __future__ import annotations

import argparse
import importlib.util
import json
import re
import statistics
import subprocess
import time
from pathlib import Path

from .decisions import percentile
from .extract import digest
from .paths import repo_root
from .policy import read_source
from .search import search


def rg_baseline(root: Path, query: str, limit: int) -> tuple[list[str], float]:
    """A reproducible term-OR grep probe, not a stand-in for a capable agent's query planning."""
    stop = {"a", "an", "and", "are", "as", "at", "be", "by", "can", "do", "does", "for", "from", "how", "i", "in", "is", "it", "of", "on", "or", "that", "the", "their", "this", "to", "what", "when", "where", "which", "with", "without"}
    words = [word for word in re.findall(r"[\w]+", query) if word.casefold() not in stop]
    pattern = "|".join(re.escape(word) for word in words) or re.escape(query)
    started = time.monotonic()
    result = subprocess.run(["rg", "--no-config", "--files-with-matches", "--ignore-case", "--no-require-git", "--", pattern, "."], cwd=root, capture_output=True, text=True, timeout=10)
    if result.returncode not in (0, 1):
        raise RuntimeError("ripgrep baseline failed")
    # Rank by term hits to give grep a meaningful, explicit ranking rather than filesystem order.
    scores = []
    for raw in result.stdout.splitlines():
        path = str(Path(raw))
        try:
            data = read_source(root, path).decode("utf-8").casefold()
        except (OSError, ValueError, UnicodeError):
            continue
        score = sum(bool(re.search(re.escape(word.casefold()), data)) for word in words)
        scores.append((path, score))
    ranked = [path for path, _ in sorted(scores, key=lambda item: (-item[1], item[0]))[:limit]]
    return ranked, (time.monotonic() - started) * 1000


def run(root: Path, cases: list[dict], output: Path, repeats: int = 1) -> dict:
    rows = []
    source_fingerprint = digest(json.dumps(cases, sort_keys=True).encode())
    for case in cases:
        for method in ("rg_terms", "lexical", "semantic", "auto"):
            for repeat in range(repeats):
                if method == "rg_terms":
                    paths, elapsed = rg_baseline(root, case["query"], 5)
                    route = "rg_terms"
                    verified = None
                else:
                    result = search(root, case["query"], method, 5)
                    paths = list(dict.fromkeys(hit["evidence"]["path"] for hit in result["results"]))
                    elapsed = result["elapsed_ms"]
                    route = result["route"]
                    verified = all(hit["status"] == "verified" for hit in result["results"])
                expected = set(case["expected"])
                found = set(paths)
                first = next((index + 1 for index, path in enumerate(paths) if path in expected), 0)
                rows.append({
                    "case_id": case["id"], "kind": case["kind"], "method": method, "repeat": repeat,
                    "expected_count": len(expected), "recall_at_5": len(expected & found) / len(expected) if expected else None,
                    "all_sources_found": expected <= found if expected else None,
                    "mrr": 1 / first if first else 0,
                    "returned_files": len(found), "empty": not paths,
                    "elapsed_ms": elapsed, "actual_route": route, "verified": verified,
                })
    aggregates = {}
    for method in ("rg_terms", "lexical", "semantic", "auto"):
        selected = [row for row in rows if row["method"] == method]
        answerable = [row for row in selected if row["expected_count"]]
        latencies = [row["elapsed_ms"] for row in selected]
        aggregates[method] = {
            "answerable_cases": len(answerable),
            "recall_at_5": round(statistics.mean(row["recall_at_5"] for row in answerable), 4),
            "all_sources_found_rate": round(statistics.mean(row["all_sources_found"] for row in answerable), 4),
            "mrr": round(statistics.mean(row["mrr"] for row in answerable), 4),
            "p50_ms": round(statistics.median(latencies), 2), "p95_ms": round(percentile(latencies, 0.95), 2),
            "fallbacks": sum(row["actual_route"] == "lexical_fallback" for row in selected),
            "unanswerable_nonempty": sum(not row["empty"] for row in selected if not row["expected_count"]),
        }
    summary = {
        "schema": 1, "experiment": "retrieval_not_end_to_end_agent_success", "cases": len(cases), "repeats": repeats,
        "case_fingerprint": source_fingerprint, "methods": aggregates,
        "limitations": ["Small handcrafted set, not representative production traffic", "rg_terms is a scripted native ripgrep probe, not native OpenCode agent performance", "Different extractors have different file coverage; PDF/DOCX are a capability difference", "First semantic query includes cold indexing and runtime initialization", "Nonempty unanswerable results must not be interpreted as a supported answer", "No model accuracy or cloud token savings inferred from retrieval metrics"],
        "rows": rows,
    }
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(summary, indent=2) + "\n")
    return {key: value for key, value in summary.items() if key != "rows"}


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", type=Path)
    parser.add_argument("--cases", type=Path)
    parser.add_argument("--output", type=Path)
    parser.add_argument("--repeats", type=int, default=1)
    args = parser.parse_args()
    if args.repeats < 1 or args.repeats > 5:
        parser.error("repeats must be between one and five")
    if args.cases:
        if not args.root:
            parser.error("--cases requires --root")
        cases = json.loads(args.cases.read_text())
        root = args.root.resolve(strict=True)
    else:
        root = repo_root() / ".local/evaluation/synthetic"
        root.mkdir(parents=True, exist_ok=True)
        spec = importlib.util.spec_from_file_location("evaluation_fixtures", repo_root() / "tests/fixtures.py")
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        cases = module.create_corpus(root)
    output = args.output or repo_root() / ".local/results/retrieval.json"
    print(json.dumps(run(root, cases, output, args.repeats), indent=2))


if __name__ == "__main__":
    main()
