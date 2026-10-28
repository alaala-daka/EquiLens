import { readFile, writeFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import { sampleContractDocx } from "./sample-contract-fixture"

// 从完整 TXT 重建网页导入样本；不要单独编辑生成的 DOCX。
const source = new URL("../fixtures/sample-contract.txt", import.meta.url)
const target = new URL("../fixtures/sample-contract.docx", import.meta.url)
await writeFile(target, await sampleContractDocx(await readFile(source, "utf8")))
console.log(`DOCX 样例：${fileURLToPath(target)}`)
