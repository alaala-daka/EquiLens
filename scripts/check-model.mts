import { askModel, ModelError, modelConfig } from "../src/server/ai/client"

// Explicit CLI test only. No document, account or database data is sent.
try {
  try { process.loadEnvFile(".env.local") }
  catch (failure) { if ((failure as NodeJS.ErrnoException).code !== "ENOENT") throw new ModelError("AI_ENV_ERROR", "无法读取本机环境文件。") }
  const config = modelConfig(process.env)
  const reply = await askModel("请只回复：连接成功", config)
  console.log(`模型：${reply.model}`)
  console.log(`回复：${reply.text.replaceAll(config.apiKey, "[已隐藏]")}`)
  if (reply.usage) console.log(`用量：输入 ${reply.usage.inputTokens}，输出 ${reply.usage.outputTokens}，合计 ${reply.usage.totalTokens} Token`)
} catch (failure) {
  console.error(failure instanceof ModelError ? `${failure.code}: ${failure.message}` : "AI_TEST_FAILED: 模型连接测试失败。")
  process.exitCode = 1
}
