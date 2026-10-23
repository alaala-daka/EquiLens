import { mkdirSync, writeFileSync } from "node:fs"
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate"
import { blankDocx } from "../../../src/lib/documents/docx"

// 生成合同审查模块用的 DOCX 样例，验证段落与表格提取。
const directory = "tools/contract-review/fixtures"
mkdirSync(directory, { recursive: true })
const files = unzipSync(new Uint8Array(await blankDocx().arrayBuffer()))
const paragraph = (text: string) => `<w:p><w:r><w:t>${text}</w:t></w:r></w:p>`
const body = [
  paragraph("建设工程施工合同"),
  paragraph("第一条 合同主体"),
  paragraph("发包人：某建设集团有限公司"),
  paragraph("第三条 付款方式"),
  paragraph("工程竣工验收合格后发包人按合同约定支付工程款。"),
  paragraph("第五条 工程变更"),
  paragraph("承包人提出的变更建议应说明变更的必要性，经发包人同意后实施。"),
  `<w:tbl><w:tblPr><w:tblW w:w="9000" w:type="dxa"/><w:tblBorders><w:top w:val="single" w:sz="4"/><w:left w:val="single" w:sz="4"/><w:bottom w:val="single" w:sz="4"/><w:right w:val="single" w:sz="4"/><w:insideH w:val="single" w:sz="4"/><w:insideV w:val="single" w:sz="4"/></w:tblBorders></w:tblPr><w:tblGrid><w:gridCol w:w="4500"/><w:gridCol w:w="4500"/></w:tblGrid>${[
    ["项目", "约定"],
    ["付款期限", "三十日"],
  ]
    .map(
      row =>
        `<w:tr>${row.map(text => `<w:tc><w:tcPr><w:tcW w:w="4500" w:type="dxa"/></w:tcPr><w:p><w:r><w:t>${text}</w:t></w:r></w:p></w:tc>`).join("")}</w:tr>`,
    )
    .join("")}</w:tbl>`,
].join("")
files["word/document.xml"] = strToU8(strFromU8(files["word/document.xml"]).replace("<w:p/>", body))
writeFileSync(`${directory}/sample-contract.docx`, zipSync(files))
console.log(`DOCX 样例：${directory}/sample-contract.docx`)
