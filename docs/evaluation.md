# Evaluation protocol and acceptance gates

The question is whether an optional enhancement helps, not whether it can be made to return a plausible answer.

## Suites

1. **Python safety/behavior:** source exclusions, symlinks, traversal, authorized inventory, stale hashes, extraction limits, UTF-8, PDF/DOCX, deletion/refresh, concurrent index updates, explicit fallbacks.
2. **TypeScript adapter/worker:** default disabled, missing host capability, source permissions before indexing, session location, cancellation, deadlines, stdout/stderr floods, process cleanup, native tools untouched.
3. **Isolated SDK integration:** repo-owned SDK, temporary HOME/XDG, disabled network/model fetching, synthetic sources, no model prompts. Direct executor calls test integration but not full model dispatch.
4. **Synthetic retrieval:** 23 handcrafted source-grounded cases across code, prose, CSV, PDF, DOCX, version conflicts, multi-source questions and unanswerable requests. Corpus creation is deterministic.
5. **Local read-only retrieval:** independently located gold files from a nearby project. Raw source/cases stay local; reports publish aggregate metrics only. No commands are executed from source projects.
6. **System 1 shadow routing:** 32 handcrafted requests over seven tool descriptions; reordered options expose position sensitivity. Exact expected choice, latency and memory are recorded. No chosen tool is executed.
7. **Agent workflow simulations:** separate native-tool and enhanced-search agents answer a small synthetic task set without gold access. These are exploratory, not blinded or statistically powered.

## Baselines and interpretation

- `rg_terms` is an explicit scripted ripgrep term-OR search with a simple hit-count ranker. It is **not** the behavior of an intelligent OpenCode agent choosing queries and reading documents.
- BM25, semantic ranking and rank fusion are compared at a fixed five evidence units. The first policy allowed adjacent units from one file to consume that budget. The revised policy retrieves a wider pool and returns at most one unit per source; deeper within-file coverage requires follow-up reads.
- PDF/DOCX extraction adds a capability to this search pipeline; it does not prove OpenCode cannot read those formats natively.
- First semantic search includes cold indexing/runtime initialization. Repeats are reported; do not hide startup cost by quoting warm latency alone.
- A source hash verifies observed bytes. It does not establish entailment, completeness, current business validity, or absence of contradictions.
- Unanswerable queries may return ranked passages. None of these rankers is an abstention model. Agents must distinguish retrieved relevance from supported claims.
- Decision heuristics are a baseline for narrow routing, not the native selected model's intelligence.

## Decision gates

- Evidence stays opt-in unless representative end-to-end evaluations show acceptable accuracy/latency and permission behavior.
- A System 1 model does not enter the hot path merely by scoring well. It must beat the no-model alternative on realistic tool outcomes at acceptable tail latency.
- No shell enhancement without a demonstrated native failure and a bounded, testable improvement.
- No aggregate quality claim across agents, model families, or project types from a single small suite.

Current measurements and decisions are recorded in `docs/results.md`; raw reports are in `.local/results/`.
