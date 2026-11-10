# Pixi runtime, not global shell policing

The `pixiGuard` feature has been **removed**, including its shell hooks, partial
shell lexer, Python-tool denylist, source-validation handoff and injected strict
agent instructions. A stale `pixiGuard: true` option is ignored; the installer
removes it from the managed plugin entry. The old `--pixi-guard` flag is rejected
with an explanation instead of pretending to enable anything.

open-enhance does not authorize/reject native commands based on their grammar,
language, wrappers, environment assignments, substitutions, redirections, loops
or Python interpreter names. Native permissions and explicit project conventions
remain in charge. It does not rewrite shell commands or broaden permissions.

**Plugin-owned** Python workers and document parsers still run through the
package's locked Pixi environment. That is reproducible dependency/runtime
management for the implementation, not a restriction on the user's other tools.
Missing Pixi can make evidence retrieval unavailable; it does not disable native
shell, web tools or independent checkpoint controls. There is no direct-Python
fallback for those plugin-owned processes.

See the [restriction review](restriction-review.md) for the rationale and
[security boundaries](security.md) for source/worker protections that remain.
