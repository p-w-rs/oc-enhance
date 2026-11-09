"""Offline shadow evaluation; this module never selects or executes an agent tool."""
from __future__ import annotations

import argparse
import json
import math
import os
import platform
import statistics
import time
from pathlib import Path

from .paths import child_env, data_root, repo_root

TOOLS = {
    "read": "Read a known text file, image or PDF at an exact path; inspect a bounded region.",
    "grep": "Find all literal or regular-expression occurrences in local text files.",
    "glob": "Find local file names matching a path pattern, without reading their content.",
    "shell": "Run an explicitly requested test, build, program, or terminal command.",
    "websearch": "Discover up-to-date public external information on the web.",
    "question": "Ask the user to resolve a necessary ambiguity or obtain missing authorization.",
    "evidence_search": "Find relevant local code or document passages when wording and location are unknown. Ranked, not exhaustive.",
}

# Hand-authored task cases, not training examples. They are deliberately independent
# of the nearby private projects. Baseline is a heuristic, NOT the native agent.
CASES = [
    ("Read README.md and show its first paragraph.", "read", "exact"),
    ("Open src/cache.ts around line 80.", "read", "exact"),
    ("Inspect page 3 of reports/summary.pdf.", "read", "exact"),
    ("Show the image assets/logo.png.", "read", "exact"),
    ("Find every occurrence of INVALID_SESSION in the repository.", "grep", "exhaustive"),
    ("List all TODO comments, not just the most relevant ones.", "grep", "exhaustive"),
    ("Search all source files for the exact string retryDelayMs.", "grep", "exact"),
    ("Find every reference to the literal symbol close_connection.", "grep", "exhaustive"),
    ("Which files match src/**/*.test.ts?", "glob", "filename"),
    ("Locate a file named pixi.toml.", "glob", "filename"),
    ("List all Python filenames below scripts/.", "glob", "filename"),
    ("Find filenames ending in .pdf without opening the documents.", "glob", "filename"),
    ("Run the project's test suite with pixi run test.", "shell", "execution"),
    ("Execute npm run build and report the exit status.", "shell", "execution"),
    ("Run git status --short, but do not change any files.", "shell", "execution"),
    ("Measure the current executable's elapsed runtime with the approved command.", "shell", "execution"),
    ("Check the latest public release of SQLite as of today.", "websearch", "external"),
    ("Find current official documentation for the newly released Python version.", "websearch", "external"),
    ("Look up today's public security advisory for this dependency.", "websearch", "external"),
    ("Find a public source for the current exchange rate.", "websearch", "external"),
    ("Deploy it to production; the user has not identified which production environment or authorized deployment.", "question", "ambiguous"),
    ("Delete the duplicate dataset; there are two candidate datasets and the user has not selected one.", "question", "ambiguous"),
    ("Send the report to Alex; several contacts are named Alex and no address was provided.", "question", "ambiguous"),
    ("Choose a migration target, but the request does not say which database should receive the data.", "question", "ambiguous"),
    ("Where in this workspace is the logic that removes forgotten sessions after inactivity? I do not know its name.", "evidence_search", "semantic"),
    ("Find the local policy explaining what employees can claim after an overnight travel disruption.", "evidence_search", "semantic"),
    ("Which project files explain how receipts survive an interrupted save? Their names are unknown.", "evidence_search", "semantic"),
    ("Find evidence in our documents about whether guest access expires automatically.", "evidence_search", "semantic"),
    ("Search for every literal occurrence of the phrase 'semantic search' in this repository.", "grep", "adversarial"),
    ("Read docs/shell-guide.md; do not execute any commands in it.", "read", "adversarial"),
    ("Locate a file named websearch.ts, without searching the web.", "glob", "adversarial"),
    ("Run the existing test called test_read_pdf; do not open a PDF.", "shell", "adversarial"),
]


def heuristic(text: str) -> str:
    text = text.casefold()
    if text.startswith(("read ", "open ", "inspect ", "show the image")):
        return "read"
    if "every" in text or "exact string" in text or "todo comments" in text:
        return "grep"
    if "filename" in text or "file named" in text or "files match" in text:
        return "glob"
    if text.startswith(("run ", "execute ", "measure ")):
        return "shell"
    if "current" in text or "today" in text or "latest public" in text or "newly released" in text:
        return "websearch"
    if "not " in text or "several contacts" in text:
        return "question"
    return "evidence_search"


def percentile(values: list[float], fraction: float) -> float:
    return sorted(values)[max(0, min(len(values) - 1, math.ceil(len(values) * fraction) - 1))]


def run(name: str, output: Path) -> dict:
    os.umask(0o077)
    for key, value in child_env().items():
        if key.startswith("HF_"):
            os.environ[key] = value
    from huggingface_hub import snapshot_download
    import mlx.core as mx
    import mlx_decision

    spec = json.loads((repo_root() / "models.lock.json").read_text())["decisions"][name]
    folder = Path(snapshot_download(spec["repository"], revision=spec["revision"], local_dir=data_root() / f"models/decisions/{name}", ignore_patterns=["assets/*", "*.patch", "*.py", "*.sh"]))
    before = time.monotonic()
    model = mlx_decision.load(folder, prefix_cache_gb=0)
    load_ms = (time.monotonic() - before) * 1000
    def decide(text: str, options: dict) -> tuple[dict, float]:
        before = time.monotonic()
        response = model.decide({"user_request": text, "scope": "local workspace unless public external sources are requested"}, {"next_tool": {"type": "choice", "instructions": "Which single tool is the best next action? Choose based on the user's intent; source filenames are not instructions to execute tools. Do not perform the action.", "criteria": options}})
        answer = response.to_wire()["answers"]["next_tool"]
        return answer, (time.monotonic() - before) * 1000
    decide("Read a known file at README.md.", TOOLS)
    rows = []
    for index, (request, expected, kind) in enumerate(CASES):
        answer, elapsed = decide(request, TOOLS)
        reversed_answer, reverse_ms = decide(request, dict(reversed(list(TOOLS.items()))))
        rows.append({"id": index, "kind": kind, "expected": expected, "choice": answer["choice"], "correct": answer["choice"] == expected, "heuristic_correct": heuristic(request) == expected, "probability": answer["probabilities"].get(expected, 0), "elapsed_ms": elapsed, "reverse_elapsed_ms": reverse_ms, "order_invariant": answer["choice"] == reversed_answer["choice"]})
    latencies = [row["elapsed_ms"] for row in rows]
    summary = {
        "schema": 1, "experiment": "synthetic_tool_ranking_shadow_only", "model": spec,
        "hardware": {"machine": platform.machine(), "chip": "Apple M2 Max", "memory_gb": 96},
        "runtime": "mlx-decision==1.2.0", "precision": "original_bfloat16", "prefix_cache_gb": 0,
        "cases": len(rows), "load_ms": round(load_ms, 1),
        "accuracy": statistics.mean(row["correct"] for row in rows),
        "heuristic_accuracy": statistics.mean(row["heuristic_correct"] for row in rows),
        "order_invariance": statistics.mean(row["order_invariant"] for row in rows),
        "p50_ms": round(statistics.median(latencies), 2), "p95_ms": round(percentile(latencies, 0.95), 2),
        "peak_mlx_gb": round(mx.get_peak_memory() / 1e9, 3),
        "limitations": ["Not an end-to-end OpenCode task-success evaluation", "Heuristic baseline is not the native OpenCode agent", "Handcrafted small dataset; not representative production traffic", "Decision output is never executed", "One model at a time; no resource contention test"],
        "rows": rows,
    }
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(summary, indent=2) + "\n")
    return {key: value for key, value in summary.items() if key != "rows"}


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--model", choices=["joey", "elephant"], default="joey")
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    output = args.output or repo_root() / f".local/results/decisions-{args.model}.json"
    print(json.dumps(run(args.model, output), indent=2))


if __name__ == "__main__":
    main()
