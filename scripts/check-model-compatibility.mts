import { checkEndpointCompatibility } from "./model-compatibility"
import { ModelError } from "../src/server/ai/client"

// Explicit invocation sends two fixed synthetic requests; it does not access documents or task databases.
try {
  try { process.loadEnvFile(".env.local") }
  catch (failure) { if ((failure as NodeJS.ErrnoException).code !== "ENOENT") throw new ModelError("AI_ENV_ERROR", "无法读取本机环境文件。") }
  const report = await checkEndpointCompatibility(process.env)
  console.log(JSON.stringify(report, null, 2))
  if (!report.passed) process.exitCode = 1
} catch (failure) {
  console.error(JSON.stringify({ passed: false, code: failure instanceof ModelError ? failure.code : "AI_TEST_FAILED" }))
  process.exitCode = 1
}
