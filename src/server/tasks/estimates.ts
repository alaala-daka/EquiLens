import { maxCallsFor, maxCostFenFor, type TaskKind } from "./catalog"
import { TaskError } from "./errors"
export function estimateTaskCall(kind: TaskKind, callNumber: number) {
  if (!Number.isInteger(callNumber) || callNumber < 1 || callNumber > maxCallsFor(kind)) {
    throw new TaskError(422, "INVALID_SUBMISSION", "任务调用次数无效。")
  }
  return { costFen: Math.ceil(maxCostFenFor(kind) / maxCallsFor(kind)), timeMs: 90000 }
}
