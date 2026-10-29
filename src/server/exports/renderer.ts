import { strToU8, zipSync, type Zippable } from "fflate"

export const renderVersion = "paragraphs-v1"
export const docxContentType = "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
export type RenderInput = { paragraphs: string[]; metadata: string[] }
const escapeXml = (text: string) => text.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;")

/** Fixed text paragraphs only; ZIP timestamps are fixed so identical snapshots yield identical bytes. */
export function renderDocx(input: RenderInput): Uint8Array {
  const paragraphs = [...input.metadata, ...input.paragraphs].flatMap(text => text.split(/\r?\n/)).map(text => `<w:p><w:r><w:t xml:space="preserve">${escapeXml(text)}</w:t></w:r></w:p>`).join("")
  const files: Record<string,string> = {
    "[Content_Types].xml": '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
    "_rels/.rels": '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
    "word/document.xml": `<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${paragraphs}<w:sectPr/></w:body></w:document>`,
  }
  const zipped: Zippable = {}
  for (const [name,text] of Object.entries(files)) zipped[name] = [strToU8(text), { mtime: new Date(1980,0,1), level: 6 }]
  return zipSync(zipped)
}
