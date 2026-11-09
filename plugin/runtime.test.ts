import test from "node:test"
import assert from "node:assert/strict"
import { resolvePixi } from "./runtime.js"

test("runtime never falls back to a direct Python executable", () => {
  assert.throws(() => resolvePixi(undefined, { PATH: "/nonexistent" }), /Pixi is required/)
  assert.throws(() => resolvePixi("pixi"), /absolute executable path/)
  assert.ok(resolvePixi().endsWith("/pixi"))
})
