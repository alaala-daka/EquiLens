const messages: Record<string, string> = {
  REVIEW_INPUT_INVALID: "合同文字、段落编号或调用参数无效。",
  REVIEW_INPUT_TOO_LARGE: "合同或提示内容超过本次输入预算，请减少材料或调整已验证的配置。",
  REVIEW_RULES_UNAVAILABLE: "没有可用的已发布规则包；当前内置资料仅供显式开启调试模式联调。",
  REVIEW_CONTEXT_UNMATCHED: "已发布的规则与当前审查条件（立场、项目类型、地域）不一致，没有可执行的检查项；请核对所选条件。",
  REVIEW_RULES_UNMATCHED: "已发布的规则未命中本合同任何内容，没有可执行的检查项；请确认合同类型与规则包是否匹配。",
  REVIEW_RULE_PACK_INVALID: "规则包读取或格式校验失败，请由维护者检查规则文件。",
  REVIEW_BUDGET_EXHAUSTED: "本次审查已达到模型调用次数上限。",
  REVIEW_BUDGET_UNVERIFIED: "正式审查的提示预算尚未验证并配置；请使用调试模式联调。",
  REVIEW_TIMEOUT: "本次审查已达到执行时限。",
  REVIEW_CANCELLED: "本次审查已取消。",
  REVIEW_OUTPUT_INVALID: "模型回答格式不合格，本批结果未采用。",
  REVIEW_RESERVATION_FAILED: "发送前权限或预算预留检查未通过。",
  REVIEW_MODEL_FAILED: "模型调用失败，本批结果未完成。",
  REVIEW_SKILL_INVALID: "合同审查技能读取或格式无效。",
  REVIEW_SKILL_REQUIRED: "请先加载适用的合同审查技能。",
  REVIEW_SCENE_INVALID: "场景选择、原文证据或适用条件未通过校验，请重新核对。",
  REVIEW_SCENE_REQUIRED: "请先读取合同并完成场景识别。",
  REVIEW_SCENE_UNSUPPORTED: "当前没有适配该合同的审查场景，请核对合同类型。",
  REVIEW_SCENE_UNCERTAIN: "场景尚不能确定，请补充或核对材料后重新审查。",
  REVIEW_SCENE_UNRESOLVED: "本次未完成场景识别，尚未开始合同审查。",
  REVIEW_AUDIT_INCOMPLETE: "独立复核尚未完成；主审及已有复核意见已保留。",
  REVIEW_PRIMARY_INCOMPLETE: "主审尚未形成有效结论，独立复核未开始。",
  REVIEW_SOURCE_UNAVAILABLE: "请求的依据不属于本次可用来源。",
  REVIEW_PROGRESS_FAILED: "任务进度保存失败，本次审查已停止。",
  REVIEW_DOCUMENT_INVALID: "文件无效或包含暂不支持的结构；请改用基础 DOCX 或 UTF-8 TXT。",
  REVIEW_DOCUMENT_TIMEOUT: "文档解析超时，请缩减文档。",
  REVIEW_PARSER_UNAVAILABLE: "DOCX 解析器未生成，请先运行 pnpm prepare:contract。",
  AI_NOT_CONFIGURED: "未配置模型密钥，请在后端环境中设置 AI_API_KEY。",
  AI_CONFIG_INVALID: "模型服务配置无效，请检查 HTTPS 地址和模型名称。",
  AI_AUTH_ERROR: "模型鉴权失败，请检查密钥和模型访问权限。",
  AI_RATE_LIMITED: "模型服务请求受限，请稍后重试。",
  AI_NETWORK_ERROR: "无法连接模型服务。",
  AI_TIMEOUT: "模型请求超时。",
  AI_UPSTREAM_ERROR: "模型服务暂时不可用。",
  AI_REQUEST_REJECTED: "模型服务拒绝请求，请检查模型、参数或账户余额。",
  AI_RESPONSE_INVALID: "模型响应无效。",
  AI_OUTPUT_TRUNCATED: "模型输出达到长度上限，本批结果未采用；已提交结论保留，可在剩余预算内继续审查。",
  AI_OUTPUT_REFUSED: "模型服务拒绝生成或触发内容过滤，本批未完成；请核对材料与服务限制。",
  AI_OUTPUT_INCOMPLETE: "模型未按预期结束，本批结果未采用；请查看任务记录。",
}

export function incompleteOutput(finishReason: unknown, refusal?: unknown): ReviewError {
  if (refusal || finishReason === "content_filter") return new ReviewError("AI_OUTPUT_REFUSED")
  if (finishReason === "length") return new ReviewError("AI_OUTPUT_TRUNCATED")
  return new ReviewError("AI_OUTPUT_INCOMPLETE")
}

export class ReviewError extends Error {
  constructor(public readonly code: string, public readonly retryAfterMs?: number) {
    super(messages[code] ?? messages.REVIEW_MODEL_FAILED)
    this.name = "ReviewError"
  }
}

/** 不向日志、报告或前端传递底层异常及上游响应正文。 */
export function safeError(failure: unknown): { code: string; message: string } {
  const code = failure && typeof failure === "object" && "code" in failure ? String(failure.code) : ""
  const safeCode = Object.hasOwn(messages, code) ? code : "REVIEW_MODEL_FAILED"
  return { code: safeCode, message: messages[safeCode] }
}
