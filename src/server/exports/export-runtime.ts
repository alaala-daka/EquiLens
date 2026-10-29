import "server-only"
import { BusinessError } from "../projects/errors"
import { exportHttpServices } from "./access"
import { privateObjectStoreRuntime } from "../storage/runtime"

/** Called only by the explicit Node lifecycle; no import-time work. */
export async function repairProductionExports(): Promise<void> {
  // Production OBS is unavailable: never report object reconciliation success.
  privateObjectStoreRuntime()
  if (process.env.NODE_ENV !== "development" || process.env.EQUILENS_SYNTHETIC_STORAGE !== "1") throw new BusinessError("SERVICE_UNAVAILABLE","私有对象存储尚未配置。")
  await (await exportHttpServices()).service.repairPending()
}
