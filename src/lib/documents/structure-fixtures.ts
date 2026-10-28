import { strFromU8, strToU8, zipSync } from "fflate"
import { blankDocxFiles, prepareDocxBytes } from "./docx"
import { emptyStructures, type DocumentStructures } from "./structures"

export type WordExpectation = {
  bodyContains: string[]
  headerContains: string[]
  revisions?: number
  inlineShapesMin?: number
  shapesMin?: number
  fieldsMin?: number
  tables?: number
  footnotesMin?: number
}

export type StructureFixture = {
  id: string
  title: string
  build: () => Uint8Array
  expected: { text: string; structures: DocumentStructures; word: WordExpectation }
}

const XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
const W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"
const R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
const WP = "http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"
const A = "http://schemas.openxmlformats.org/drawingml/2006/main"
const PIC = "http://schemas.openxmlformats.org/drawingml/2006/picture"
const MC = "http://schemas.openxmlformats.org/markup-compatibility/2006"
const WPS = "http://schemas.microsoft.com/office/word/2010/wordprocessingShape"
const V = "urn:schemas-microsoft-com:vml"
const O = "urn:schemas-microsoft-com:office:office"
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="
const pngBytes = Uint8Array.from(atob(PNG), character => character.charCodeAt(0))
const author = "陆评审"

function assemble(change: (files: Record<string, Uint8Array>) => void): Uint8Array {
  const files = blankDocxFiles()
  change(files)
  return prepareDocxBytes(zipSync(files))
}

function document(body: string, namespaces = ""): Uint8Array {
  return strToU8(`${XML}<w:document xmlns:w="${W}" xmlns:r="${R}"${namespaces}><w:body>${body}</w:body></w:document>`)
}

function sect(references = ""): string {
  return `<w:sectPr>${references}<w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="708" w:footer="708" w:gutter="0"/></w:sectPr>`
}

function addType(files: Record<string, Uint8Array>, entry: string) {
  const name = "[Content_Types].xml"
  const types = strFromU8(files[name])
  // CT_Types 要求 Default 全部排在 Override 之前
  files[name] = strToU8(entry.startsWith("<Default") && types.includes("<Override")
    ? types.replace("<Override", `${entry}<Override`)
    : types.replace("</Types>", `${entry}</Types>`))
}

function addRel(files: Record<string, Uint8Array>, id: string, type: string, target: string) {
  const name = "word/_rels/document.xml.rels"
  const rels = strFromU8(files[name])
  const relation = `<Relationship Id="${id}" Type="${R}/${type}" Target="${target}"/>`
  files[name] = strToU8(/<\/Relationships\s*>/.test(rels)
    ? rels.replace("</Relationships>", `${relation}</Relationships>`)
    : rels.replace(/<Relationships\b([^>]*?)\/>/, (_match, attributes) => `<Relationships${attributes}>${relation}</Relationships>`))
}

function image(files: Record<string, Uint8Array>, relId = "rIdImg1") {
  addType(files, '<Default Extension="png" ContentType="image/png"/>')
  addRel(files, relId, "image", "media/image1.png")
  files["word/media/image1.png"] = pngBytes
}

function headerFooter(files: Record<string, Uint8Array>, header: string, footer: string) {
  addType(files, `<Override PartName="/word/header1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.header+xml"/><Override PartName="/word/footer1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.footer+xml"/>`)
  addRel(files, "rIdHdr1", "header", "header1.xml")
  addRel(files, "rIdFtr1", "footer", "footer1.xml")
  files["word/header1.xml"] = strToU8(`${XML}<w:hdr xmlns:w="${W}"><w:p><w:r><w:t>${header}</w:t></w:r></w:p></w:hdr>`)
  files["word/footer1.xml"] = strToU8(`${XML}<w:ftr xmlns:w="${W}">${footer}</w:ftr>`)
}

const headerFooterRefs = '<w:headerReference w:type="default" r:id="rIdHdr1"/><w:footerReference w:type="default" r:id="rIdFtr1"/>'

function picture(relId: string, id: number, cx: number, cy: number) {
  return `<a:graphic><a:graphicData uri="${PIC}"><pic:pic><pic:nvPicPr><pic:cNvPr id="${id}" name="图片${id}"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip r:embed="${relId}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic>`
}

function inlineImage(id: number) {
  return `<w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0"><wp:extent cx="190500" cy="190500"/><wp:effectExtent l="0" t="0" r="0" b="0"/><wp:docPr id="${id}" name="图片${id}"/><wp:cNvGraphicFramePr/>${picture("rIdImg1", id, 190500, 190500)}</wp:inline></w:drawing>`
}

function floatingImage(id: number) {
  return `<w:drawing><wp:anchor distT="0" distB="0" distL="114300" distR="114300" simplePos="0" relativeHeight="251658240" behindDoc="0" locked="0" layoutInCell="1" allowOverlap="1"><wp:simplePos x="0" y="0"/><wp:positionH relativeFrom="column"><wp:posOffset>0</wp:posOffset></wp:positionH><wp:positionV relativeFrom="paragraph"><wp:posOffset>0</wp:posOffset></wp:positionV><wp:extent cx="190500" cy="190500"/><wp:effectExtent l="0" t="0" r="0" b="0"/><wp:wrapSquare wrapText="bothSides"/><wp:docPr id="${id}" name="图片${id}"/><wp:cNvGraphicFramePr/>${picture("rIdImg1", id, 190500, 190500)}</wp:anchor></w:drawing>`
}

const textboxContent = (text: string) => `<w:txbxContent><w:p><w:r><w:t>${text}</w:t></w:r></w:p></w:txbxContent>`

const vmlShapetype = `<v:shapetype id="_x0000_t202" coordsize="21600,21600" o:spt="202" path="m,l,21600r21600,l21600,xe"><v:stroke joinstyle="miter"/><v:path gradientshapeok="t" o:connecttype="rect"/></v:shapetype>`

const imageInline: StructureFixture = {
  id: "image-inline",
  title: "行内图片",
  build: () => assemble(files => {
    image(files)
    files["word/document.xml"] = document(`<w:p>${inlineImage(1)}</w:p>${sect()}`, ` xmlns:wp="${WP}" xmlns:a="${A}" xmlns:pic="${PIC}"`)
  }),
  expected: {
    text: "",
    structures: { ...emptyStructures(), images: 1 },
    word: { bodyContains: [], headerContains: [], inlineShapesMin: 1 },
  },
}

const imageFloating: StructureFixture = {
  id: "image-floating",
  title: "浮动图片与环绕",
  build: () => assemble(files => {
    image(files)
    files["word/document.xml"] = document(`<w:p>${floatingImage(1)}</w:p><w:p><w:r><w:t>浮动图片环绕示意</w:t></w:r></w:p>${sect()}`, ` xmlns:wp="${WP}" xmlns:a="${A}" xmlns:pic="${PIC}"`)
  }),
  expected: {
    text: "浮动图片环绕示意",
    structures: { ...emptyStructures(), images: 1 },
    word: { bodyContains: ["浮动图片环绕示意"], headerContains: [], shapesMin: 1 },
  },
}

const headerFooterFixture: StructureFixture = {
  id: "header-footer",
  title: "页眉与页脚",
  build: () => assemble(files => {
    headerFooter(files, "某某建设集团有限公司", "<w:p><w:r><w:t>内部文件</w:t></w:r></w:p>")
    files["word/document.xml"] = document(`<w:p><w:r><w:t>正文第一页。</w:t></w:r></w:p>${sect(headerFooterRefs)}`)
  }),
  expected: {
    text: "正文第一页。",
    structures: { ...emptyStructures(), headerFooterRefs: 2 },
    word: { bodyContains: ["正文第一页"], headerContains: ["某某建设集团有限公司", "内部文件"] },
  },
}

const fieldPage: StructureFixture = {
  id: "field-page",
  title: "页码简单域",
  build: () => assemble(files => {
    files["word/document.xml"] = document(
      '<w:p><w:r><w:t xml:space="preserve">页码示例：第 </w:t></w:r><w:fldSimple w:instr=" PAGE "><w:r><w:t>1</w:t></w:r></w:fldSimple><w:r><w:t xml:space="preserve"> 页，共 </w:t></w:r><w:fldSimple w:instr=" NUMPAGES "><w:r><w:t>1</w:t></w:r></w:fldSimple><w:r><w:t> 页。</w:t></w:r></w:p>' + sect())
  }),
  expected: {
    text: "页码示例：第 1 页，共 1 页。",
    structures: { ...emptyStructures(), fields: { simple: 2, complex: 0 } },
    word: { bodyContains: ["页码示例", "页，共"], headerContains: [], fieldsMin: 2 },
  },
}

const fieldToc: StructureFixture = {
  id: "field-toc",
  title: "目录复杂域",
  build: () => assemble(files => {
    files["word/document.xml"] = document(
      '<w:p><w:r><w:t>目录</w:t></w:r></w:p>' +
      '<w:p><w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText xml:space="preserve"> TOC \\o "1-3" \\h \\z \\u </w:instrText></w:r><w:r><w:fldChar w:fldCharType="separate"/></w:r><w:r><w:t>第一章 合同概述</w:t></w:r><w:r><w:tab/></w:r><w:r><w:t>1</w:t></w:r><w:r><w:fldChar w:fldCharType="end"/></w:r></w:p>' +
      sect())
  }),
  expected: {
    text: "目录第一章 合同概述1",
    structures: { ...emptyStructures(), fields: { simple: 0, complex: 1 } },
    word: { bodyContains: ["目录"], headerContains: [], fieldsMin: 1 },
  },
}

const textboxDrawingml: StructureFixture = {
  id: "textbox-drawingml",
  title: "DrawingML 文本框（Choice/Fallback 双份存储）",
  build: () => assemble(files => {
    const box = textboxContent("框内文字")
    const choice = `<w:drawing><wp:anchor distT="0" distB="0" distL="114300" distR="114300" simplePos="0" relativeHeight="251658240" behindDoc="0" locked="0" layoutInCell="1" allowOverlap="1"><wp:simplePos x="0" y="0"/><wp:positionH relativeFrom="column"><wp:posOffset>182880</wp:posOffset></wp:positionH><wp:positionV relativeFrom="paragraph"><wp:posOffset>0</wp:posOffset></wp:positionV><wp:extent cx="2160000" cy="720000"/><wp:effectExtent l="0" t="0" r="0" b="0"/><wp:wrapSquare wrapText="bothSides"/><wp:docPr id="1" name="文本框 1"/><wp:cNvGraphicFramePr><a:graphicFrameLocks noChangeAspect="1"/></wp:cNvGraphicFramePr><a:graphic><a:graphicData uri="${WPS}"><wps:wsp><wps:cNvSpPr txBox="1"/><wps:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="2160000" cy="720000"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:noFill/><a:ln><a:noFill/></a:ln></wps:spPr><wps:txbx>${box}</wps:txbx><wps:bodyPr/></wps:wsp></a:graphicData></a:graphic></wp:anchor></w:drawing>`
    const fallback = `<w:pict>${vmlShapetype}<v:shape id="文本框 1" type="#_x0000_t202" style="width:170.1pt;height:56.7pt" filled="f" stroked="f"><v:textbox>${box}</v:textbox></v:shape></w:pict>`
    files["word/document.xml"] = document(
      `<w:p><mc:AlternateContent><mc:Choice Requires="wps"><w:r>${choice}</w:r></mc:Choice><mc:Fallback><w:r>${fallback}</w:r></mc:Fallback></mc:AlternateContent></w:p>${sect()}`,
      ` xmlns:mc="${MC}" xmlns:wps="${WPS}" xmlns:wp="${WP}" xmlns:a="${A}" xmlns:v="${V}" xmlns:o="${O}"`)
  }),
  expected: {
    text: "框内文字",
    structures: { ...emptyStructures(), images: 1, textboxes: 1 },
    word: { bodyContains: [], headerContains: [], shapesMin: 1 },
  },
}

const textboxVml: StructureFixture = {
  id: "textbox-vml",
  title: "VML 文本框",
  build: () => assemble(files => {
    const box = textboxContent("框内文字（VML）")
    files["word/document.xml"] = document(
      `<w:p><w:r><w:pict>${vmlShapetype}<v:shape id="文本框 1" type="#_x0000_t202" style="width:144pt;height:36pt" filled="f" stroked="f"><v:textbox>${box}</v:textbox></v:shape></w:pict></w:r></w:p>${sect()}`,
      ` xmlns:v="${V}" xmlns:o="${O}"`)
  }),
  expected: {
    text: "框内文字（VML）",
    structures: { ...emptyStructures(), images: 1, textboxes: 1 },
    word: { bodyContains: [], headerContains: [], shapesMin: 1 },
  },
}

const comments: StructureFixture = {
  id: "comments",
  title: "批注",
  build: () => assemble(files => {
    addType(files, '<Override PartName="/word/comments.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.comments+xml"/>')
    addRel(files, "rIdCmt1", "comments", "comments.xml")
    files["word/comments.xml"] = strToU8(`${XML}<w:comments xmlns:w="${W}"><w:comment w:id="0" w:author="${author}" w:date="2026-01-15T09:00:00Z" w:initials="陆"><w:p><w:r><w:t>请核对付款期限与合同条款是否一致。</w:t></w:r></w:p></w:comment></w:comments>`)
    files["word/document.xml"] = document(
      '<w:p><w:r><w:t>第一条付款期限为</w:t></w:r><w:commentRangeStart w:id="0"/><w:r><w:t>三十日</w:t></w:r><w:commentRangeEnd w:id="0"/><w:r><w:commentReference w:id="0"/></w:r><w:r><w:t>。</w:t></w:r></w:p>' + sect())
  }),
  expected: {
    text: "第一条付款期限为三十日。",
    structures: { ...emptyStructures(), comments: 1 },
    word: { bodyContains: ["第一条付款期限为三十日"], headerContains: [] },
  },
}

const footnotes: StructureFixture = {
  id: "footnotes",
  title: "脚注",
  build: () => assemble(files => {
    addType(files, '<Override PartName="/word/footnotes.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.footnotes+xml"/>')
    addRel(files, "rIdFtn1", "footnotes", "footnotes.xml")
    files["word/footnotes.xml"] = strToU8(`${XML}<w:footnotes xmlns:w="${W}"><w:footnote w:type="separator" w:id="-1"><w:p><w:r><w:separator/></w:r></w:p></w:footnote><w:footnote w:type="continuationSeparator" w:id="0"><w:p><w:r><w:continuationSeparator/></w:r></w:p></w:footnote><w:footnote w:id="1"><w:p><w:r><w:footnoteRef/></w:r><w:r><w:t>结算单须双方盖章确认。</w:t></w:r></w:p></w:footnote></w:footnotes>`)
    files["word/document.xml"] = document(
      '<w:p><w:r><w:t>工程价款以结算单为准</w:t></w:r><w:r><w:footnoteReference w:id="1"/></w:r><w:r><w:t>。</w:t></w:r></w:p>' + sect())
  }),
  expected: {
    text: "工程价款以结算单为准。",
    structures: { ...emptyStructures(), notes: 1 },
    word: { bodyContains: ["工程价款以结算单为准"], headerContains: [], footnotesMin: 1 },
  },
}

const contentControl: StructureFixture = {
  id: "content-control",
  title: "内容控件",
  build: () => assemble(files => {
    files["word/document.xml"] = document(
      '<w:sdt><w:sdtPr><w:alias w:val="工程概况"/><w:tag w:val="block1"/><w:id w:val="101"/><w:text/></w:sdtPr><w:sdtContent><w:p><w:r><w:t>第一条工程概况。</w:t></w:r></w:p></w:sdtContent></w:sdt>' +
      '<w:p><w:r><w:t>第二条工期自</w:t></w:r><w:sdt><w:sdtPr><w:alias w:val="开工日期"/><w:tag w:val="inline1"/><w:id w:val="102"/><w:text/></w:sdtPr><w:sdtContent><w:r><w:t>二〇二六年一月十五日</w:t></w:r></w:sdtContent></w:sdt><w:r><w:t>起算。</w:t></w:r></w:p>' +
      sect())
  }),
  expected: {
    text: "第一条工程概况。第二条工期自二〇二六年一月十五日起算。",
    structures: { ...emptyStructures(), contentControls: 2 },
    word: { bodyContains: ["第一条工程概况", "二〇二六年一月十五日"], headerContains: [] },
  },
}

const tableMerge: StructureFixture = {
  id: "table-merge",
  title: "合并单元格表格",
  build: () => assemble(files => {
    files["word/document.xml"] = document(
      '<w:tbl><w:tblPr><w:tblW w:w="0" w:type="auto"/></w:tblPr><w:tblGrid><w:gridCol w:w="3000"/><w:gridCol w:w="3000"/><w:gridCol w:w="3000"/></w:tblGrid>' +
      '<w:tr><w:tc><w:tcPr><w:tcW w:w="3000" w:type="dxa"/></w:tcPr><w:p><w:r><w:t>分包范围</w:t></w:r></w:p></w:tc><w:tc><w:tcPr><w:tcW w:w="6000" w:type="dxa"/><w:gridSpan w:val="2"/></w:tcPr><w:p><w:r><w:t>机电安装工程</w:t></w:r></w:p></w:tc></w:tr>' +
      '<w:tr><w:tc><w:tcPr><w:tcW w:w="3000" w:type="dxa"/></w:tcPr><w:p><w:r><w:t>合同价款</w:t></w:r></w:p></w:tc><w:tc><w:tcPr><w:tcW w:w="3000" w:type="dxa"/><w:vMerge w:val="restart"/></w:tcPr><w:p><w:r><w:t>暂定伍佰万元</w:t></w:r></w:p></w:tc><w:tc><w:tcPr><w:tcW w:w="3000" w:type="dxa"/></w:tcPr><w:p><w:r><w:t>工期一百八十日</w:t></w:r></w:p></w:tc></w:tr>' +
      '</w:tbl>' + sect())
  }),
  expected: {
    text: "分包范围机电安装工程合同价款暂定伍佰万元工期一百八十日",
    structures: { ...emptyStructures(), mergedCells: 2 },
    word: { bodyContains: ["分包范围", "机电安装工程"], headerContains: [], tables: 1 },
  },
}

const revisionsAll: StructureFixture = {
  id: "revisions-all",
  title: "全部修订标记",
  build: () => assemble(files => {
    files["word/document.xml"] = document(
      `<w:p><w:r><w:t>一、合同工期：</w:t></w:r><w:ins w:id="10" w:author="${author}" w:date="2026-01-15T09:00:00Z"><w:r><w:t>暂定一百八十日历天。</w:t></w:r></w:ins></w:p>` +
      `<w:p><w:r><w:t>二、质量标准：</w:t></w:r><w:del w:id="11" w:author="${author}" w:date="2026-01-15T09:05:00Z"><w:r><w:delText>合格即可。</w:delText></w:r></w:del></w:p>` +
      `<w:p><w:r><w:rPr><w:b/><w:rPrChange w:id="12" w:author="${author}" w:date="2026-01-15T09:10:00Z"><w:rPr><w:b w:val="0"/></w:rPr></w:rPrChange></w:rPr><w:t>三、价款结算方式见附件。</w:t></w:r></w:p>` +
      `<w:p><w:r><w:t>四、</w:t></w:r><w:moveFromRangeStart w:id="40" w:name="move1" w:author="${author}" w:date="2026-01-15T09:15:00Z"/><w:moveFrom w:id="13" w:author="${author}" w:date="2026-01-15T09:15:00Z"><w:r><w:t>工程范围以附件清单为准。</w:t></w:r></w:moveFrom><w:moveFromRangeEnd w:id="40"/><w:moveToRangeStart w:id="41" w:name="move1" w:author="${author}" w:date="2026-01-15T09:15:00Z"/><w:moveTo w:id="14" w:author="${author}" w:date="2026-01-15T09:15:00Z"><w:r><w:t>工程范围以附件清单为准。</w:t></w:r></w:moveTo><w:moveToRangeEnd w:id="41"/></w:p>` +
      sect())
  }),
  expected: {
    text: "一、合同工期：暂定一百八十日历天。二、质量标准：三、价款结算方式见附件。四、工程范围以附件清单为准。",
    structures: { ...emptyStructures(), revisions: { insertions: 1, deletions: 1, moves: 2, formatChanges: 1 } },
    word: { bodyContains: ["一、合同工期", "三、价款结算方式见附件"], headerContains: [], revisions: 5 },
  },
}

const contractFull: StructureFixture = {
  id: "contract-full",
  title: "综合合同样本（房建机电安装专业分包）",
  build: () => assemble(files => {
    image(files)
    headerFooter(files, "某某建设集团有限公司", '<w:p><w:r><w:t xml:space="preserve">第 </w:t></w:r><w:fldSimple w:instr=" PAGE "><w:r><w:t>1</w:t></w:r></w:fldSimple><w:r><w:t> 页</w:t></w:r></w:p>')
    files["word/document.xml"] = document(
      '<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>房建机电安装专业分包合同</w:t></w:r></w:p>' +
      '<w:p><w:r><w:t>发包人：某某建设集团有限公司</w:t></w:r></w:p>' +
      '<w:p><w:r><w:t>承包人：某某机电安装工程有限公司</w:t></w:r></w:p>' +
      '<w:p><w:r><w:t>第一条工程概况：承包人负责房建机电安装工程的施工与调试。</w:t></w:r></w:p>' +
      '<w:tbl><w:tblPr><w:tblW w:w="0" w:type="auto"/></w:tblPr><w:tblGrid><w:gridCol w:w="4500"/><w:gridCol w:w="4500"/></w:tblGrid>' +
      '<w:tr><w:tc><w:tcPr><w:tcW w:w="4500" w:type="dxa"/></w:tcPr><w:p><w:r><w:t>分包范围</w:t></w:r></w:p></w:tc><w:tc><w:tcPr><w:tcW w:w="4500" w:type="dxa"/></w:tcPr><w:p><w:r><w:t>机电安装</w:t></w:r></w:p></w:tc></w:tr>' +
      '<w:tr><w:tc><w:tcPr><w:tcW w:w="4500" w:type="dxa"/></w:tcPr><w:p><w:r><w:t>合同价款</w:t></w:r></w:p></w:tc><w:tc><w:tcPr><w:tcW w:w="4500" w:type="dxa"/></w:tcPr><w:p><w:r><w:t>暂定人民币伍佰万元</w:t></w:r></w:p></w:tc></w:tr>' +
      '</w:tbl>' +
      `<w:p><w:r>${inlineImage(1)}</w:r></w:p>` +
      `<w:p><w:r><w:t>第二条合同价款：</w:t></w:r><w:ins w:id="20" w:author="${author}" w:date="2026-01-16T10:00:00Z"><w:r><w:t>暂定人民币伍佰万元，最终以结算为准。</w:t></w:r></w:ins></w:p>` +
      sect(headerFooterRefs),
      ` xmlns:wp="${WP}" xmlns:a="${A}" xmlns:pic="${PIC}"`)
  }),
  expected: {
    text: "房建机电安装专业分包合同发包人：某某建设集团有限公司承包人：某某机电安装工程有限公司第一条工程概况：承包人负责房建机电安装工程的施工与调试。分包范围机电安装合同价款暂定人民币伍佰万元第二条合同价款：暂定人民币伍佰万元，最终以结算为准。",
    structures: {
      ...emptyStructures(),
      images: 1, headerFooterRefs: 2, fields: { simple: 1, complex: 0 },
      revisions: { insertions: 1, deletions: 0, moves: 0, formatChanges: 0 },
    },
    word: {
      bodyContains: ["房建机电安装专业分包合同", "第一条工程概况"],
      headerContains: ["某某建设集团有限公司"],
      revisions: 1, inlineShapesMin: 1, tables: 1,
    },
  },
}

export const structureFixtures: StructureFixture[] = [
  imageInline, imageFloating, headerFooterFixture, fieldPage, fieldToc,
  textboxDrawingml, textboxVml, comments, footnotes, contentControl,
  tableMerge, revisionsAll, contractFull,
]
