# Maintained provider migration

`gitlab-ai-provider-6.23.1-open-enhance.1.tgz` is an unpublished MIT-licensed
source rebuild of `gitlab-ai-provider@6.23.1`, migrated to Zod 4.6.7.

SHA-256: `e111b0b564c5d41e79ede5e5166b244891536db7657edf1c6ead2ba4fa611a3e`.

The archive includes the upstream license, verified provenance, all 24 migrated
TypeScript sources, source patch, regenerated runtime/declarations/maps, strict
type contracts, pinned build lock (`BUILD-LOCK.json`), and `REBUILD.md` instructions.
It contains public upstream source and synthetic contracts only.

The version-scoped root npm override is deliberately a shipped relative file,
not a dependency on private evaluation artifacts. Overrides apply only at the
installation root; this does not promise remediation of an arbitrary enclosing
consumer or of OpenCode's precompiled CLI/Desktop binaries.

Intentional source fixes include correctly required token/OAuth fields, nullable
workflow-cache annotations, and SDK-supported OpenAI assistant-history input.
Live GitLab inference, OAuth and WebSocket endpoints were not tested. See the
archive's `MIGRATION.md` for preserved upstream quirks and compatibility limits.

To rebuild, extract into `.local/`, follow `REBUILD.md` through `pixi run --locked`,
and compare all runtime/declaration/map outputs before replacing the archive.
Never replace it solely to make an audit count disappear.
