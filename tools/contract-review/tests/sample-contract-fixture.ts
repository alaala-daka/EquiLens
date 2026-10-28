import { strFromU8, strToU8, unzipSync, zipSync } from "fflate"
import { blankDocx } from "../../../src/lib/documents/docx"
import { paragraphsFromString } from "../src/document"

const xml = (text: string) => text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")

/** TXT 是唯一样本源；固定 ZIP 时间和关系 ID，使重复生成的 DOCX 字节一致。 */
export async function sampleContractDocx(text: string): Promise<Uint8Array> {
  const files = unzipSync(new Uint8Array(await blankDocx().arrayBuffer()))
  const body = paragraphsFromString(text).map(paragraph =>
    `<w:p><w:r><w:t xml:space="preserve">${xml(paragraph.text)}</w:t></w:r></w:p>`).join("")
  files["word/document.xml"] = strToU8(strFromU8(files["word/document.xml"]).replace("<w:p/>", body))
  files["word/_rels/document.xml.rels"] = strToU8(strFromU8(files["word/_rels/document.xml.rels"])
    .replace(/equilensStyles[0-9a-f]{32}/g, "equilensStylesFixture"))
  return zipSync(files, { mtime: new Date(2000, 0, 1) })
}
