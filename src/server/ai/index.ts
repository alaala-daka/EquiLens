import "server-only"
import { askModel as requestModel, modelConfig } from "./client"

export { ModelError } from "./client"
export type { ModelReply } from "./client"

export function askModel(prompt: string) {
  return requestModel(prompt, modelConfig(process.env))
}
