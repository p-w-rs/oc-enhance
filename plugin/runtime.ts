import { accessSync, constants } from "node:fs"
import path from "node:path"

/** Pixi is the sole externally provisioned runtime. Never fall back to Python. */
export function resolvePixi(configured?: unknown, env: NodeJS.ProcessEnv = process.env): string {
  if (configured !== undefined && (typeof configured !== "string" || !path.isAbsolute(configured))) {
    throw new Error("open-enhance: pixiExecutable must be an absolute executable path")
  }
  const candidates = typeof configured === "string" ? [configured] : (env.PATH ?? "").split(path.delimiter).filter(Boolean).map(dir => path.resolve(dir, "pixi"))
  for (const candidate of candidates) {
    try { accessSync(candidate, constants.X_OK); return candidate } catch { /* next candidate */ }
  }
  throw new Error("open-enhance: Pixi is required; set options.pixiExecutable to its absolute path if Desktop PATH does not include it. No direct-Python fallback is allowed.")
}
