import { open } from "node:fs/promises"
import { extname } from "node:path"
import { Worker } from "node:worker_threads"

export const DOCUMENT_KINDS: Readonly<Record<string, string>> = { ".docx": "docx", ".xlsx": "xlsx", ".pptx": "pptx", ".pdf": "pdf" }
export const MAX_DOCUMENT_BYTES = 50 * 1024 * 1024
const TIMEOUT_MS = 60_000
const WORKER = new URL("./doc-worker.mjs", import.meta.url)

export interface Section { readonly label: string; readonly text: string }
export interface Extracted { readonly sections: readonly Section[]; readonly summary: string }

export const documentKind = (path: string) => DOCUMENT_KINDS[extname(path).toLowerCase()]

/** Reads at most `limit` bytes of a regular file; refuses larger ones. */
export async function readBounded(path: string, limit = MAX_DOCUMENT_BYTES, signal?: AbortSignal): Promise<Uint8Array> {
  const handle = await open(path, "r")
  try {
    const info = await handle.stat()
    if (!info.isFile()) throw new Error(`${path} is not a file`)
    if (info.size > limit) throw new Error(`${path} is ${Math.round(info.size / 1048576)} MB; the limit is ${Math.round(limit / 1048576)} MB`)
    const buffer = new Uint8Array(info.size)
    let offset = 0
    while (offset < info.size) {
      signal?.throwIfAborted()
      const { bytesRead } = await handle.read(buffer, offset, info.size - offset, offset)
      if (!bytesRead) break
      offset += bytesRead
    }
    return buffer.subarray(0, offset)
  } finally { await handle.close() }
}

/** Extracts a document's text in a worker thread with a deadline and a memory cap. */
export function extractDocument(data: Uint8Array, kind: string, signal?: AbortSignal, timeoutMs = TIMEOUT_MS): Promise<Extracted> {
  return new Promise((resolve, reject) => {
    signal?.throwIfAborted()
    const worker = new Worker(WORKER, { workerData: { data, kind }, resourceLimits: { maxOldGenerationSizeMb: 1024 }, stdout: true, stderr: true })
    let settled = false
    const finish = (error?: Error, value?: Extracted) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener("abort", abort)
      void worker.terminate()
      if (error) reject(error); else resolve(value!)
    }
    const abort = () => finish(new Error("Cancelled"))
    const timer = setTimeout(() => finish(new Error(`Reading the document took longer than ${Math.round(timeoutMs / 1000)} s and was stopped`)), timeoutMs)
    signal?.addEventListener("abort", abort, { once: true })
    worker.on("message", (message: { ok: boolean; error?: string; sections?: Section[]; summary?: string }) => {
      if (message.ok) finish(undefined, { sections: message.sections ?? [], summary: message.summary ?? "" })
      else finish(new Error(message.error ?? "Could not read the document"))
    })
    worker.on("error", error => finish(new Error(`Could not read the document: ${error.message}`)))
    worker.on("exit", code => finish(new Error(`Could not read the document (reader stopped, code ${code})`)))
  })
}

/** Parses "3", "2-5", "1,4-6" or a section label ("Sales", "slide 3") into the selected section indexes. */
export function selectSections(sections: readonly Section[], part: string | undefined): number[] {
  const all = sections.map((_, index) => index)
  if (!part?.trim()) return all
  const wanted = part.trim()
  if (/^\d+(\s*-\s*\d+)?(\s*,\s*\d+(\s*-\s*\d+)?)*$/.test(wanted)) {
    const chosen = new Set<number>()
    for (const piece of wanted.split(",")) {
      const [a, b] = piece.split("-").map(value => Number.parseInt(value.trim(), 10))
      for (let n = a!; n <= (b ?? a!); n++) if (n >= 1 && n <= sections.length) chosen.add(n - 1)
    }
    if (!chosen.size) throw new Error(`No part ${wanted}; the document has ${sections.length} parts`)
    return [...chosen].sort((x, y) => x - y)
  }
  const lower = wanted.toLowerCase().replace(/^"|"$/g, "")
  const match = sections.findIndex(section => section.label.toLowerCase() === lower || section.label.toLowerCase().replace(/^\w+ "?|"$/g, "") === lower)
  if (match < 0) throw new Error(`No part named ${JSON.stringify(wanted)}. Parts: ${sections.map(section => section.label).slice(0, 30).join(", ")}`)
  return [match]
}

/** Markdown for the agent, cut at `maxChars` with a hint where to continue. */
export function render(name: string, extracted: Extracted, part: string | undefined, maxChars: number): string {
  const indexes = selectSections(extracted.sections, part)
  const header = `# ${name}\n\n${extracted.summary}. Parts: ${extracted.sections.length}${part ? `; showing ${part}` : ""}.\n`
  let output = header
  for (const [position, index] of indexes.entries()) {
    const section = extracted.sections[index]!
    const chunk = `\n## Part ${index + 1}: ${section.label}\n\n${section.text}\n`
    if (output.length + chunk.length > maxChars) {
      const room = maxChars - output.length
      if (room > 500) output += chunk.slice(0, room) + "\n…"
      const next = indexes[room > 500 ? position + 1 : position]
      output += `\n\n[Output limit reached. Continue with part="${next !== undefined ? next + 1 : index + 1}${indexes.length > 1 ? `-${indexes.at(-1)! + 1}` : ""}"]`
      break
    }
    output += chunk
  }
  return output
}
