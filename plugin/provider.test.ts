import test from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { createHash } from "node:crypto"
import { createRequire } from "node:module"
import * as api from "gitlab-ai-provider"

// These negative contracts are checked by the normal project TypeScript gate.
// A Zod-4 override against the original Zod-3 declarations accepts these values.
type Token = Awaited<ReturnType<api.GitLabDirectAccessClient["getDirectAccessToken"]>>
// @ts-expect-error token output must never degrade to any
const scalar: Token = 42
// @ts-expect-error token field is required
const missingToken: Token = { headers: {} }
// @ts-expect-error header values must remain strings
const badHeaders: Token = { token: "synthetic", headers: { x: 42 } }
// @ts-expect-error OAuth output must never degrade to any
const scalarOAuth: api.GitLabOAuthTokenResponse = 42
// @ts-expect-error expiry and creation fields are required
const missingOAuth: api.GitLabOAuthTokenResponse = { access_token: "synthetic" }
void [scalar, missingToken, badHeaders, scalarOAuth, missingOAuth]

test("maintained provider artifact and installed version match the reviewed migration", () => {
  const archive = readFileSync(new URL("../vendor/gitlab-ai-provider-6.23.1-open-enhance.1.tgz", import.meta.url))
  assert.equal(createHash("sha256").update(archive).digest("hex"), "e111b0b564c5d41e79ede5e5166b244891536db7657edf1c6ead2ba4fa611a3e")
  assert.equal(api.VERSION, "6.23.1-open-enhance.1")
  const commonjs = createRequire(import.meta.url)("gitlab-ai-provider")
  assert.deepEqual(Object.keys(commonjs).sort(), Object.keys(api).sort())
})

test("provider token and OAuth payloads validate, strip extras and reject malformed responses", async () => {
  const payload = { token: "synthetic", headers: { x: "synthetic" } }
  let calls = 0
  const config = { instanceUrl: "https://synthetic.invalid", aiGatewayUrl: "https://synthetic.invalid", directAccessCacheDir: "", getHeaders: () => ({}), fetch: async () => { calls++; return Response.json({ ...payload, extra: true }) } }
  const client = new api.GitLabDirectAccessClient(config)
  assert.deepEqual(await client.getDirectAccessToken(), payload)
  await client.getDirectAccessToken()
  assert.equal(calls, 1)
  for (const value of [{}, null, [], { token: 4, headers: {} }, { token: "synthetic" }, { token: "synthetic", headers: { x: 4 } }]) {
    await assert.rejects(() => new api.GitLabDirectAccessClient({ ...config, fetch: async () => Response.json(value) }).getDirectAccessToken(), api.GitLabError)
  }
  const oauth = { access_token: "synthetic", expires_in: 3600, created_at: 1700000000 }
  assert.deepEqual(api.gitlabOAuthTokenResponseSchema.parse({ ...oauth, extra: true }), oauth)
  for (const value of [{}, null, { ...oauth, access_token: 4 }, { ...oauth, refresh_token: 42 }]) assert.equal(api.gitlabOAuthTokenResponseSchema.safeParse(value).success, false)
})

test("provider resolves patched Zod with bounded oversized collection validation", () => {
  const require = createRequire(import.meta.resolve("gitlab-ai-provider"))
  const { z } = require("zod") as typeof import("zod")
  const cases = [
    [z.array(z.string()).max(2), Array(1000).fill(1)],
    [z.set(z.string()).max(2), new Set(Array.from({ length: 1000 }, (_, i) => i))],
    [z.map(z.string(), z.string()).max(2), new Map(Array.from({ length: 1000 }, (_, i) => [i, i]))],
  ] as const
  for (const [schema, value] of cases) {
    const parsed = schema.safeParse(value)
    assert.equal(parsed.success, false)
    assert.equal(parsed.error?.issues.length, 1)
    assert.equal(parsed.error?.issues[0].code, "too_big")
  }
})
