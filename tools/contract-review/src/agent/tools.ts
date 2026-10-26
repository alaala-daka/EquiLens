import { tool } from "ai"
import { z } from "zod"
import { findingsBatchSchema, sceneSelectionSchema } from "./schema"
import type { ReviewSession } from "./session"

const page = { cursor: z.number().int().min(0).default(0), limit: z.number().int().min(1).max(30).default(15) }

export function createReviewTools(session: ReviewSession, beforeTool: () => Promise<void>, afterTool: () => Promise<void>) {
  const execute = async <T>(action: () => T): Promise<T> => {
    await beforeTool()
    const result = action()
    await afterTool()
    return result
  }
  return {
    selectScene: tool({
      description: "根据已读全文匹配登记场景，并引用支持判断的已读原文。只有一个候选也不能默认适用。不支持或不确定时明确提交对应状态并停止。审查立场由用户确认，不能从合同推测。",
      inputSchema: session.result.sceneCandidates?.length ? sceneSelectionSchema.extend({
        sceneId: z.enum(session.result.sceneCandidates.map(item => item.id)).nullable(),
      }) : sceneSelectionSchema,
      execute: selection => execute(() => session.selectScene(selection)),
    }),
    loadSkill: tool({
      description: "按技能 ID 加载操作说明和本次必检规则。先加载技能，再读正文和提交结果。",
      inputSchema: z.object({ skillId: z.literal(session.skill.id) }).strict(),
      execute: ({ skillId }) => execute(() => session.loadSkill(skillId)),
    }),
    parseDocument: tool({
      description: "查看已完成解析的固定快照元数据和分页目录。不接受文件路径，不执行第二次解析，不计为已读正文。",
      inputSchema: z.object(page).strict(),
      execute: ({ cursor, limit }) => execute(() => session.parseDocument(cursor, limit)),
    }),
    searchDocument: tool({
      description: "在本任务全文中查找关键词线索。预览不计为已读；请继续用 readParagraphs 获取完整正文。",
      inputSchema: z.object({ query: z.string().min(1).max(100), ...page }).strict(),
      execute: ({ query, cursor, limit }) => execute(() => session.searchDocument(query, cursor, limit)),
    }),
    readParagraphs: tool({
      description: "读取指定零起始段落编号的完整原文，可读取关联条款和前后文。超限时减少本次段落数，原文不截断。",
      inputSchema: z.object({ indexes: z.array(z.number().int().min(0)).min(1).max(100) }).strict(),
      execute: ({ indexes }) => execute(() => session.readParagraphs(indexes)),
    }),
    readSources: tool({
      description: "读取本次规则允许的依据正文和来源元数据。提交结论前读取需要引用的 sourceId。",
      inputSchema: z.object({ sourceIds: z.array(z.string().min(1).max(100)).min(1).max(20) }).strict(),
      execute: ({ sourceIds }) => execute(() => session.readSources(sourceIds)),
    }),
    submitFindings: tool({
      description: "每批提交1–3条规则结论，每回合只调用一次，不要累积全部结果。后端检查字段、已读引文及依据、适用条件与完整性，返回接受/拒绝记录。",
      inputSchema: z.object({ findings: findingsBatchSchema }).strict(),
      execute: ({ findings }) => execute(() => session.submit(findings)),
    }),
    checkCoverage: tool({
      description: "查看六类覆盖、未答规则和已读范围。没有有效答案的必检项最终保留待核实。",
      inputSchema: z.object({}).strict(),
      execute: () => execute(() => session.checkCoverage()),
    }),
  }
}
