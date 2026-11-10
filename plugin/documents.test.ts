import { test } from "node:test"
import assert from "node:assert/strict"
import { extractDocument, render, selectSections } from "./documents.js"
import { docx, pdf, pptx, xlsx, zipBomb } from "./testdocs.js"

test("Word: paragraphs in order, entities decoded, footnotes kept", async () => {
  const result = await extractDocument(docx(["Travel policy", "Hotels & meals are covered when a flight is cancelled <overnight>.", "Ünïcode ✓"], "See section 4."), "docx")
  assert.match(result.summary, /Word document, 3 paragraphs/)
  const all = result.sections.map(s => s.text).join("\n")
  assert.match(all, /Hotels & meals are covered when a flight is cancelled <overnight>\./)
  assert.match(all, /Ünïcode ✓/)
  assert.equal(result.sections.at(-1)!.label, "footnotes and endnotes")
})

test("PowerPoint: one part per slide, in slide order, with speaker notes", async () => {
  const result = await extractDocument(pptx([{ text: ["Q3 review"] }, { text: ["Revenue up 12%", "Churn down"], notes: "Mention the EMEA deal" }]), "pptx")
  assert.deepEqual(result.sections.map(s => s.label), ["slide 1", "slide 2"])
  assert.match(result.sections[1]!.text, /Revenue up 12%\nChurn down\n\nSpeaker notes:\nMention the EMEA deal/)
  assert.doesNotMatch(result.sections[1]!.text, /\n2$/, "slide-number placeholder in notes is dropped")
})

test("Excel: sheets by name, shared strings and numbers, row numbers", async () => {
  const result = await extractDocument(xlsx({ Budget: [["Item", "Cost"], ["Laptop", 1499], ["Desk", 300]], Notes: [["Approved by Pat"]] }), "xlsx")
  assert.deepEqual(result.sections.map(s => s.label), ['sheet "Budget"', 'sheet "Notes"'])
  assert.match(result.sections[0]!.text, /^2\tLaptop\t1499$/m)
  assert.match(result.sections[1]!.text, /Approved by Pat/)
})

test("PDF: text per page", async () => {
  const result = await extractDocument(pdf(["First page about invoices", "Second page about refunds"]), "pdf")
  assert.match(result.summary, /PDF, 2 pages/)
  assert.match(result.sections[0]!.text, /invoices/)
  assert.match(result.sections[1]!.text, /refunds/)
})

test("refuses broken and oversized documents with a clear message", async () => {
  await assert.rejects(extractDocument(new Uint8Array([1, 2, 3]), "docx"), /Could not read|zip|invalid/i)
  await assert.rejects(extractDocument(zipBomb(), "docx"), /too large/)
  const tampered = (await import("fflate")).zipSync({ "word/document.xml": new TextEncoder().encode('<!DOCTYPE x [<!ENTITY a "b">]><w:document/>') })
  await assert.rejects(extractDocument(tampered, "docx"), /XML entities/)
  await assert.rejects(extractDocument(pdf(["x"]), "pdf", undefined, 1), /longer than/)
})

test("parts: numbers, ranges, names; output limit says where to continue", async () => {
  const sections = [{ label: "slide 1", text: "a" }, { label: "slide 2", text: "b" }, { label: 'sheet "Sales"', text: "c" }]
  assert.deepEqual(selectSections(sections, "2-3"), [1, 2])
  assert.deepEqual(selectSections(sections, "1,3"), [0, 2])
  assert.deepEqual(selectSections(sections, "Sales"), [2])
  assert.deepEqual(selectSections(sections, "slide 2"), [1])
  assert.throws(() => selectSections(sections, "Revenue"), /No part named "Revenue". Parts: slide 1, slide 2, sheet "Sales"/)
  const long = { summary: "x", sections: Array.from({ length: 10 }, (_, i) => ({ label: `page ${i + 1}`, text: "word ".repeat(400) })) }
  const output = render("big.pdf", long, undefined, 6000)
  assert.ok(output.length < 6300)
  assert.match(output, /Continue with part="\d+-10"/)
})
