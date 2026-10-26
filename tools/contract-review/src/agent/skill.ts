import { createHash } from "node:crypto"
import { readFile } from "node:fs/promises"
import { resolve } from "node:path"
import { z } from "zod"
import { ReviewError } from "../errors"
import { skillIds } from "../scenes"

const metadata = z.object({
  id: z.enum(skillIds), name: z.string().min(1).max(100),
  version: z.string().min(1).max(100), description: z.string().min(1).max(1000),
}).strict()
export type ReviewSkill = z.infer<typeof metadata> & { instructions: string; sha256: string }

/** 仅允许部署者指定技能根目录。模型只传固定 ID，不参与文件路径解析。 */
export async function loadReviewSkill(root = resolve(process.cwd(), "tools/contract-review/skills"), id: string = "contract-review"): Promise<ReviewSkill> {
  try {
    if (!(skillIds as readonly string[]).includes(id)) throw new Error()
    const directory = resolve(root, id)
    const info = metadata.parse(JSON.parse(await readFile(resolve(directory, "skill.json"), "utf8")))
    if (info.id !== id) throw new Error()
    const instructions = await readFile(resolve(directory, "SKILL.md"), "utf8")
    if (!instructions.trim() || instructions.length > 16000) throw new Error()
    return { ...info, instructions, sha256: createHash("sha256").update(JSON.stringify(info) + "\n" + instructions).digest("hex") }
  } catch { throw new ReviewError("REVIEW_SKILL_INVALID") }
}
