# Dependency remediation

The original full npm audit count represented affected packages and their dependent chains, not 28 independent vulnerabilities. It traced to three root advisories: glob cancellation, minimatch pattern amplification, and Zod collection-validation memory exhaustion.

## Applied scoped migration

`package.json` now intentionally overrides only these pinned consumers:

```json
{
  "@opencode/util@2.2.6": { "glob": "14.0.4", "minimatch": "11.0.5" },
  "rimraf@5.0.10": { "glob": "14.0.4" }
}
```

These are tested major-version migrations, not semver-compatible patches or a blind `npm audit fix --force`. Future consumer upgrades require a new assessment. Minimatch 11 changes lower-level APIs, so broad untested overrides are deliberately avoided.

An isolated investigation passed eleven runtime contract groups: actual OpenCode util glob behavior, ignore-walk, workspace discovery, TUF delegation, Arborist queries, npm packlist, cacache, rimraf, SDK/plugin imports, synthetic GitLab token parsing, and bounded validation observations. Type checking and isolated SDK smoke also passed. Committed regressions in `plugin/dependencies.test.ts` exercise the real util dependency resolution and both reported moderate defects.

After the scoped migration and provider source rebuild below, the full development and production npm dependency trees report **zero findings**. Audits remain visible and release-blocking; no exclusions are used.

## Why the Zod shortcut was rejected

GitLab provider 6.23.1 requires Zod 3.25.76; there is no published patched Zod 3 version. Forcing Zod 4.6.7 makes npm audit report zero and passes basic runtime smoke, but breaks two published Zod-3-style declarations. A negative type contract then accepts a number where a token-response object is required, even with `skipLibCheck` enabled.

That shortcut was rejected. The adopted fix is a proper source rebuild, `gitlab-ai-provider@6.23.1-open-enhance.1`, shipped under `vendor/` with all migrated public sources, MIT license, provenance, source patch, pinned build lock, and strict type contracts. It uses Zod 4.6.7 and regenerated declarations, not declaration text patches or a legacy `/v3` alias. A root development file dependency plus version-scoped `$gitlab-ai-provider` override gives npm a portable root-relative source; fresh extracted-package acceptance must verify this independently.

The candidate passed byte-identical rebuild comparisons, strict ESM/CJS declaration checks with ten negative contracts, 23 synthetic runtime contract groups and installed SDK smoke. Committed `plugin/provider.test.ts` adds archive-integrity, installed-version, token validation, type-safety and oversized-collection regressions. Intentional changes correct required OAuth/token fields, nullable cache annotations and OpenAI assistant-history serialization. Live GitLab inference/OAuth/WebSockets remain untested; the fork is used by the development SDK and does not replace an installed host's provider implementation.

## Host-artifact boundary

These changes remediate the project's installed JavaScript dependency tree. They do **not** rewrite the project-owned precompiled OpenCode executable or the installed Desktop application. Successful CLI integration demonstrates compatibility, not that those compiled host artifacts have independently been rebuilt or audited. Host security disposition remains separate from plugin dependency remediation.

The Python distribution audit is currently clear after upgrading the parser/test runner. It is not a comprehensive native/Conda library audit.

Root advisory references: [glob](https://github.com/advisories/GHSA-3g3m-2fjr-6pw4), [minimatch](https://github.com/advisories/GHSA-g3hv-75wg-m249), [Zod](https://github.com/advisories/GHSA-mrhx-c7xc-m3w5).
