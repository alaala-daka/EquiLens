import { mkdirSync, writeFileSync } from "node:fs"
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate"
import { blankDocx, validateDocxBytes } from "../src/lib/documents/docx"

const directory = ".superpowers/previews/word-fixtures"
mkdirSync(directory, { recursive: true })
const files = unzipSync(new Uint8Array(await blankDocx().arrayBuffer()))
const body = `<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>专业分包合同</w:t></w:r></w:p>
<w:p><w:r><w:rPr><w:b/></w:rPr><w:t>第一条 工程范围</w:t></w:r></w:p>
<w:p><w:r><w:t>机电安装工程，付款期限为三十日。</w:t></w:r></w:p>
<w:tbl><w:tblPr><w:tblW w:w="9000" w:type="dxa"/><w:tblBorders><w:top w:val="single" w:sz="4"/><w:left w:val="single" w:sz="4"/><w:bottom w:val="single" w:sz="4"/><w:right w:val="single" w:sz="4"/><w:insideH w:val="single" w:sz="4"/><w:insideV w:val="single" w:sz="4"/></w:tblBorders></w:tblPr><w:tblGrid><w:gridCol w:w="4500"/><w:gridCol w:w="4500"/></w:tblGrid>${[["项目", "约定"], ["付款期限", "三十日"]].map(row => `<w:tr>${row.map(text => `<w:tc><w:tcPr><w:tcW w:w="4500" w:type="dxa"/></w:tcPr><w:p><w:r><w:t>${text}</w:t></w:r></w:p></w:tc>`).join("")}</w:tr>`).join("")}</w:tbl>
<w:p><w:r><w:br w:type="page"/></w:r></w:p><w:p><w:r><w:rPr><w:i/><w:u w:val="single"/></w:rPr><w:t>第二页：履约资料</w:t></w:r></w:p>`
files["word/document.xml"] = strToU8(strFromU8(files["word/document.xml"]).replace("<w:p/>", body))
const bytes = zipSync(files)
validateDocxBytes(bytes)
writeFileSync(`${directory}/contract-table.docx`, bytes)
files["word/_rels/document.xml.rels"] = strToU8('<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="remote" Type="image" TargetMode="External" Target="https://example.com/image.png"/></Relationships>')
writeFileSync(`${directory}/external-resource.docx`, zipSync(files))
console.log(`Synthetic Word fixtures: ${directory}`)
