// Builds small real Office files and a PDF for tests (no binary fixtures in the repository).
import { strToU8, zipSync } from "fflate"

const x = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")

export function docx(paragraphs: string[], footnote?: string): Uint8Array {
  const body = paragraphs.map(text => `<w:p><w:r><w:t xml:space="preserve">${x(text)}</w:t></w:r></w:p>`).join("")
  return zipSync({
    "[Content_Types].xml": strToU8(`<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>`),
    "word/document.xml": strToU8(`<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}</w:body></w:document>`),
    ...(footnote && { "word/footnotes.xml": strToU8(`<w:footnotes xmlns:w="w"><w:footnote><w:p><w:r><w:t>${x(footnote)}</w:t></w:r></w:p></w:footnote></w:footnotes>`) }),
  })
}

export function pptx(slides: { text: string[]; notes?: string }[]): Uint8Array {
  const files: Record<string, Uint8Array> = {}
  slides.forEach((slide, index) => {
    files[`ppt/slides/slide${index + 1}.xml`] = strToU8(`<p:sld xmlns:p="p" xmlns:a="a"><p:cSld><p:spTree>${slide.text.map(t => `<p:sp><p:txBody><a:p><a:r><a:t>${x(t)}</a:t></a:r></a:p></p:txBody></p:sp>`).join("")}</p:spTree></p:cSld></p:sld>`)
    if (slide.notes) files[`ppt/notesSlides/notesSlide${index + 1}.xml`] = strToU8(`<p:notes xmlns:p="p" xmlns:a="a"><a:p><a:r><a:t>${x(slide.notes)}</a:t></a:r></a:p><a:p><a:r><a:t>${index + 1}</a:t></a:r></a:p></p:notes>`)
  })
  return zipSync(files)
}

/** sheets: name → rows of cells (strings become shared strings, numbers stay numbers). */
export function xlsx(sheets: Record<string, (string | number)[][]>): Uint8Array {
  const shared: string[] = []
  const files: Record<string, Uint8Array> = {}
  const names = Object.keys(sheets)
  names.forEach((name, sheet) => {
    const rows = sheets[name]!.map((row, r) => `<row r="${r + 1}">${row.map((cell, c) => {
      const ref = `${String.fromCharCode(65 + c)}${r + 1}`
      if (typeof cell === "number") return `<c r="${ref}"><v>${cell}</v></c>`
      shared.push(cell)
      return `<c r="${ref}" t="s"><v>${shared.length - 1}</v></c>`
    }).join("")}</row>`).join("")
    files[`xl/worksheets/sheet${sheet + 1}.xml`] = strToU8(`<worksheet xmlns="m"><sheetData>${rows}</sheetData></worksheet>`)
  })
  files["xl/workbook.xml"] = strToU8(`<workbook xmlns="m" xmlns:r="r"><sheets>${names.map((name, i) => `<sheet name="${x(name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join("")}</sheets></workbook>`)
  files["xl/_rels/workbook.xml.rels"] = strToU8(`<Relationships>${names.map((_, i) => `<Relationship Id="rId${i + 1}" Type="worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join("")}</Relationships>`)
  files["xl/sharedStrings.xml"] = strToU8(`<sst>${shared.map(s => `<si><t>${x(s)}</t></si>`).join("")}</sst>`)
  return zipSync(files)
}

/** A minimal valid PDF with one line of Helvetica text per page. */
export function pdf(pages: string[]): Uint8Array {
  const objects: string[] = []
  const add = (body: string) => { objects.push(body); return objects.length }
  const font = add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>")
  const pagesId = objects.length + pages.length * 2 + 1
  const kids: number[] = []
  for (const text of pages) {
    const stream = `BT /F1 12 Tf 72 720 Td (${text.replace(/[()\\]/g, m => `\\${m}`)}) Tj ET`
    const content = add(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`)
    kids.push(add(`<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 612 792] /Contents ${content} 0 R /Resources << /Font << /F1 ${font} 0 R >> >> >>`))
  }
  add(`<< /Type /Pages /Kids [${kids.map(k => `${k} 0 R`).join(" ")}] /Count ${kids.length} >>`)
  const catalog = add(`<< /Type /Catalog /Pages ${pagesId} 0 R >>`)
  let out = "%PDF-1.4\n"
  const offsets: number[] = []
  objects.forEach((body, i) => { offsets.push(out.length); out += `${i + 1} 0 obj\n${body}\nendobj\n` })
  const xref = out.length
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map(o => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}`
  out += `trailer\n<< /Size ${objects.length + 1} /Root ${catalog} 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  return strToU8(out)
}

/** A zip that claims a huge uncompressed entry: must be refused, not inflated. */
export function zipBomb(): Uint8Array {
  return zipSync({ "word/document.xml": new Uint8Array(80 * 1024 * 1024) }, { level: 9 })
}
