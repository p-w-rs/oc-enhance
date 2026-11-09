# open-enhance

- Target macOS Apple Silicon and OpenCode V2. Pixi is the only separately installed project tool.
- Use `pixi run --locked setup`, `pixi run --locked test`, and the documented evaluation tasks.
- Preserve native OpenCode tools and permissions. Enhancements are opt-in, read-only, and independently measured.
- Do not edit, index in place, execute commands from, or copy secrets from evaluation projects.
- All models, indexes, extraction artifacts and evaluation inputs containing local project information belong under `.local/` or the configured plugin data directory, never committed fixtures/reports.
- Published fixtures are synthetic. Reports contain aggregate metrics, not private snippets, prompts, or paths.
- Model recommendations require task-specific evaluation. Never turn a timing-only result into an accuracy claim.
- Never automatically rewrite shell commands or let model output override security decisions.
