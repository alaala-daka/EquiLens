import { mkdirSync, writeFileSync } from "node:fs"
import { structureFixtures } from "../src/lib/documents/structure-fixtures"

const directory = ".superpowers/previews/word-structures"
mkdirSync(`${directory}/engine`, { recursive: true })
const manifest = structureFixtures.map(item => {
  const bytes = item.build()
  writeFileSync(`${directory}/${item.id}.docx`, bytes)
  return { id: item.id, title: item.title, file: `${item.id}.docx`, expect: item.expected.word, expectedStructures: item.expected.structures, expectedText: item.expected.text }
})
writeFileSync(`${directory}/manifest.json`, `${JSON.stringify(manifest, null, 2)}\n`)
console.log(`Structure fixtures: ${directory} (${manifest.length} files)`)
