import { BusinessError } from "../projects/errors"
import type { MaterialRegistration, MaterialSourceKind } from "./types"

const sourceKinds: readonly MaterialSourceKind[] = ["synthetic", "authorized"]
const controlCharacters = /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/
const allowedKeys = new Set(["projectId", "title", "fileName", "sourceKind", "sourceReference", "processingAuthorized", "purpose", "retentionUntil"])

const invalid = () => new BusinessError("INVALID_INPUT", "材料登记信息不完整或格式无效。")

export function parseRegistration(value: unknown, projectRetentionUntil: string, today: string): MaterialRegistration {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw invalid()
  const input = value as Record<string, unknown>
  if (Object.keys(input).some(key => !allowedKeys.has(key))) throw invalid()
  const sourceKind = input.sourceKind
  if (typeof sourceKind !== "string" || !sourceKinds.includes(sourceKind as MaterialSourceKind)) throw new BusinessError("INVALID_INPUT", "材料来源性质无效。")
  if (input.processingAuthorized !== true) throw new BusinessError("INVALID_SOURCE", "请确认材料处理授权。")
  const retentionUntil = dateOnly(input.retentionUntil, today)
  if (retentionUntil > projectRetentionUntil) throw new BusinessError("INVALID_INPUT", "材料保留期限不得晚于项目保留截止日期。")
  return {
    projectId: uuid(input.projectId, "项目标识无效。"),
    title: text(input.title, 1, 200),
    fileName: optionalFileName(input.fileName),
    sourceKind: sourceKind as MaterialSourceKind,
    sourceReference: text(input.sourceReference, 1, 500),
    processingAuthorized: true,
    purpose: text(input.purpose, 1, 500),
    retentionUntil,
  }
}

export function parseBytes(value: unknown, maximum: number): Uint8Array {
  if (!(value instanceof Uint8Array) || !value.byteLength) throw new BusinessError("INVALID_SOURCE", "材料内容为空。")
  if (value.byteLength > maximum) throw new BusinessError("LIMIT_EXCEEDED", "材料超过 20 MiB 限制，请缩减后重试。")
  return value
}

export function uuid(value: unknown, message: string): string {
  if (typeof value !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) throw new BusinessError("INVALID_INPUT", message)
  return value
}

export function today(now: Date): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).format(now)
}

function dateOnly(value: unknown, todayValue: string): string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new BusinessError("INVALID_INPUT", "保留截止日期无效。")
  const parsed = Date.parse(`${value}T00:00:00Z`)
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString().slice(0, 10) !== value) throw new BusinessError("INVALID_INPUT", "保留截止日期无效。")
  if (value < todayValue) throw new BusinessError("INVALID_INPUT", "保留截止日期不得早于今天。")
  return value
}

function text(value: unknown, minimum: number, maximum: number): string {
  if (typeof value !== "string") throw invalid()
  const trimmed = value.trim()
  if (trimmed.length < minimum || trimmed.length > maximum || controlCharacters.test(trimmed)) throw invalid()
  return trimmed
}

function optionalFileName(value: unknown): string | null {
  if (value === undefined || value === null) return null
  if (typeof value !== "string") throw invalid()
  const trimmed = value.trim()
  if (!trimmed) return null
  if (trimmed.length > 255 || controlCharacters.test(trimmed) || /[\\/]/.test(trimmed)) throw new BusinessError("INVALID_INPUT", "文件名无效。")
  return trimmed
}
