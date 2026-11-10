// Extracts text from one document inside a worker thread, so a slow or hostile file cannot stall OpenCode.
// Plain JavaScript so it runs unchanged in OpenCode (Bun) and in Node tests.
// Input (workerData): { data: Uint8Array, kind: "docx" | "xlsx" | "pptx" | "pdf" }
// Output (message): { ok: true, sections: [{ label, text }], summary } | { ok: false, error }
import { parentPort, workerData } from "node:worker_threads"
import { strFromU8, unzipSync } from "fflate"

const MAX_ENTRY = 64 * 1024 * 1024
const MAX_TOTAL = 256 * 1024 * 1024
const MAX_PAGES = 2000
const MAX_ROWS = 20000

const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'" }
export const decode = text => text.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (match, name) => {
  if (name[0] === "#") {
    const code = name[1] === "x" || name[1] === "X" ? Number.parseInt(name.slice(2), 16) : Number.parseInt(name.slice(1), 10)
    return Number.isFinite(code) && code <= 0x10ffff ? String.fromCodePoint(code) : match
  }
  return ENTITIES[name.toLowerCase()] ?? match
})

/** Unzips only the entries `wanted` accepts, refusing zip bombs. */
export function unzip(data, wanted) {
  let total = 0
  const files = unzipSync(data, {
    filter: file => {
      if (!wanted(file.name)) return false
      if (file.originalSize > MAX_ENTRY || (total += file.originalSize) > MAX_TOTAL) throw new Error("The document is too large to read (uncompressed size over the limit)")
      return true
    },
  })
  const text = {}
  for (const [name, bytes] of Object.entries(files)) {
    const xml = strFromU8(bytes)
    if (/<!DOCTYPE|<!ENTITY/i.test(xml)) throw new Error("The document uses XML entities, which are not supported")
    text[name] = xml
  }
  return text
}

const byNumber = (a, b) => Number(/(\d+)\.xml$/.exec(a)?.[1] ?? 0) - Number(/(\d+)\.xml$/.exec(b)?.[1] ?? 0)

/** Paragraph texts of a WordprocessingML or DrawingML fragment. */
function paragraphs(xml, paragraphTag, textTag) {
  const result = []
  for (const block of xml.split(new RegExp(`</${paragraphTag}>`))) {
    let text = ""
    const token = new RegExp(`<${textTag}(?:\\s[^>]*)?>([^<]*)</${textTag}>|<(?:w:tab|a:tab)\\b[^>]*/>|<(?:w:br|a:br|w:cr)\\b[^>]*/?>`, "g")
    for (const match of block.matchAll(token)) {
      if (match[1] !== undefined) text += decode(match[1])
      else if (/tab/.test(match[0])) text += "\t"
      else text += "\n"
    }
    if (text.trim()) result.push(text)
  }
  return result
}

function docx(data) {
  const files = unzip(data, name => name === "word/document.xml" || /^word\/(footnotes|endnotes)\.xml$/.test(name))
  const body = files["word/document.xml"]
  if (!body) throw new Error("Not a Word document (word/document.xml is missing)")
  const all = paragraphs(body, "w:p", "w:t")
  const notes = ["word/footnotes.xml", "word/endnotes.xml"].flatMap(name => files[name] ? paragraphs(files[name], "w:p", "w:t") : [])
  const sections = []
  for (let start = 0; start < all.length; start += 50) {
    const end = Math.min(start + 50, all.length)
    sections.push({ label: `paragraphs ${start + 1}-${end}`, text: all.slice(start, end).join("\n\n") })
  }
  if (notes.length) sections.push({ label: "footnotes and endnotes", text: notes.join("\n\n") })
  return { sections, summary: `Word document, ${all.length} paragraphs` }
}

function pptx(data) {
  const files = unzip(data, name => /^ppt\/(slides\/slide|notesSlides\/notesSlide)\d+\.xml$/.test(name))
  const slides = Object.keys(files).filter(name => name.startsWith("ppt/slides/")).sort(byNumber)
  if (!slides.length) throw new Error("Not a PowerPoint presentation (no slides found)")
  const sections = slides.map(name => {
    const number = /(\d+)\.xml$/.exec(name)[1]
    const notes = files[`ppt/notesSlides/notesSlide${number}.xml`]
    const notesText = notes ? paragraphs(notes, "a:p", "a:t").filter(line => !/^\d+$/.test(line.trim())).join("\n") : ""
    return { label: `slide ${number}`, text: paragraphs(files[name], "a:p", "a:t").join("\n") + (notesText ? `\n\nSpeaker notes:\n${notesText}` : "") }
  })
  return { sections, summary: `PowerPoint presentation, ${slides.length} slides` }
}

const attribute = (tag, name) => { const match = new RegExp(`\\s${name}="([^"]*)"`).exec(tag); return match ? decode(match[1]) : undefined }
const columnIndex = reference => { let n = 0; for (const c of /^[A-Z]+/.exec(reference ?? "")?.[0] ?? "") n = n * 26 + c.charCodeAt(0) - 64; return n - 1 }

function xlsx(data) {
  const files = unzip(data, name => name === "xl/workbook.xml" || name === "xl/_rels/workbook.xml.rels" || name === "xl/sharedStrings.xml" || /^xl\/worksheets\/sheet\d+\.xml$/.test(name))
  const workbook = files["xl/workbook.xml"]
  if (!workbook) throw new Error("Not an Excel workbook (xl/workbook.xml is missing)")
  const shared = (files["xl/sharedStrings.xml"] ?? "").split("</si>").slice(0, -1).map(item => [...item.matchAll(/<t(?:\s[^>]*)?>([^<]*)<\/t>/g)].map(m => decode(m[1])).join(""))
  const targets = {}
  for (const rel of (files["xl/_rels/workbook.xml.rels"] ?? "").match(/<Relationship\b[^>]*>/g) ?? []) {
    const id = attribute(rel, "Id"), target = attribute(rel, "Target")
    if (id && target) targets[id] = target.replace(/^\/?(xl\/)?/, "xl/")
  }
  const sheets = (workbook.match(/<sheet\b[^>]*>/g) ?? []).map((tag, index) => ({
    name: attribute(tag, "name") ?? `Sheet${index + 1}`,
    file: targets[attribute(tag, "r:id") ?? ""] ?? `xl/worksheets/sheet${index + 1}.xml`,
  }))
  let rowsTotal = 0
  const sections = sheets.map(sheet => {
    const xml = files[sheet.file] ?? ""
    const lines = []
    for (const row of xml.split("</row>")) {
      if (rowsTotal >= MAX_ROWS) break
      const cells = []
      for (const match of row.matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
        const tag = match[1], inner = match[2] ?? ""
        const type = attribute(` ${tag}`, "t")
        let value = /<v>([^<]*)<\/v>/.exec(inner)?.[1]
        if (type === "s") value = shared[Number(value)]
        else if (type === "inlineStr") value = [...inner.matchAll(/<t(?:\s[^>]*)?>([^<]*)<\/t>/g)].map(m => m[1]).join("")
        else if (type === "b") value = value === "1" ? "TRUE" : value === "0" ? "FALSE" : value
        if (value === undefined) continue
        const column = columnIndex(attribute(` ${tag}`, "r"))
        cells[column >= 0 ? column : cells.length] = decode(String(value)).replace(/[\t\n]/g, " ")
      }
      if (!cells.length) continue
      const number = /<row\b[^>]*\sr="(\d+)"/.exec(row)?.[1]
      lines.push(`${number ? `${number}\t` : ""}${Array.from(cells, cell => cell ?? "").join("\t")}`)
      rowsTotal++
    }
    return { label: `sheet "${sheet.name}"`, text: lines.length ? `(row number, then cells from column A, tab-separated)\n${lines.join("\n")}` : "(empty)" }
  })
  return { sections, summary: `Excel workbook, ${sheets.length} sheets${rowsTotal >= MAX_ROWS ? ` (first ${MAX_ROWS} rows)` : ""}` }
}

async function pdf(data) {
  const { extractText, getDocumentProxy } = await import("unpdf")
  const document = await getDocumentProxy(data, { isEvalSupported: false })
  if (document.numPages > MAX_PAGES) throw new Error(`The PDF has ${document.numPages} pages; at most ${MAX_PAGES} can be read`)
  const { totalPages, text } = await extractText(document, { mergePages: false })
  const sections = text.map((page, index) => ({ label: `page ${index + 1}`, text: page.trim() || "(no text on this page; it may be a scanned image)" }))
  const empty = sections.every(section => section.text.startsWith("(no text"))
  return { sections, summary: `PDF, ${totalPages} pages${empty ? "; no text layer (scanned?), OCR is not available" : ""}` }
}

export async function extract(data, kind) {
  if (kind === "docx") return docx(data)
  if (kind === "pptx") return pptx(data)
  if (kind === "xlsx") return xlsx(data)
  if (kind === "pdf") return pdf(data)
  throw new Error(`Unsupported document type: ${kind}`)
}

if (parentPort && workerData) {
  extract(workerData.data, workerData.kind)
    .then(result => parentPort.postMessage({ ok: true, ...result }))
    .catch(error => parentPort.postMessage({ ok: false, error: error instanceof Error ? error.message : String(error) }))
}
