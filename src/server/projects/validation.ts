import type { ProjectRole } from "../../lib/business/contracts"
import { BusinessError } from "./errors"
import type { ProjectCreateInput, ProjectMemberInput, ProjectSource, ProjectUpdateInput } from "./types"

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const usernamePattern = /^[a-z0-9][a-z0-9._-]{2,63}$/
const controlCharacters = /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/
const roles: readonly ProjectRole[] = ["admin", "editor", "viewer"]
const sources: readonly ProjectSource[] = ["synthetic", "authorized"]
const createKeys = new Set(["name", "source", "sourceReference", "purpose", "retentionUntil"])
const invalid = () => new BusinessError("INVALID_INPUT", "项目信息不完整或格式无效。")

export function isProjectId(value: unknown): value is string {
  return typeof value === "string" && uuid.test(value)
}

export function normalizeUsername(value: unknown): string {
  if (typeof value !== "string") throw new BusinessError("INVALID_INPUT", "账号标识无效。")
  const normalized = value.trim().toLowerCase()
  if (!usernamePattern.test(normalized)) throw new BusinessError("INVALID_INPUT", "账号标识无效。")
  return normalized
}

export function parseRole(value: unknown): ProjectRole {
  if (typeof value !== "string" || !roles.includes(value as ProjectRole)) throw new BusinessError("INVALID_INPUT", "成员角色无效。")
  return value as ProjectRole
}

/** Date-only (Asia/Shanghai calendar) deadline; never before the current server day. */
export function parseRetentionUntil(value: unknown, now: Date): string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new BusinessError("INVALID_INPUT", "保留截止日期无效。")
  const parsed = Date.parse(`${value}T00:00:00Z`)
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString().slice(0, 10) !== value) throw new BusinessError("INVALID_INPUT", "保留截止日期无效。")
  if (value < today(now)) throw new BusinessError("INVALID_INPUT", "保留截止日期不得早于今天。")
  return value
}

export function parseProjectCreate(body: unknown, now: Date): ProjectCreateInput {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw invalid()
  const input = body as Record<string, unknown>
  if (Object.keys(input).some(key => !createKeys.has(key))) throw invalid()
  return {
    name: text(input.name, 1, 120),
    source: source(input.source),
    sourceReference: text(input.sourceReference, 1, 500),
    purpose: text(input.purpose, 1, 500),
    retentionUntil: parseRetentionUntil(input.retentionUntil, now),
  }
}

export function parseProjectUpdate(body: unknown, now: Date): ProjectUpdateInput {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw invalid()
  const input = body as Record<string, unknown>
  const keys = Object.keys(input)
  if (!keys.length || keys.some(key => !createKeys.has(key))) throw invalid()
  const update: ProjectUpdateInput = {}
  if ("name" in input) update.name = text(input.name, 1, 120)
  if ("source" in input) update.source = source(input.source)
  if ("sourceReference" in input) update.sourceReference = text(input.sourceReference, 1, 500)
  if ("purpose" in input) update.purpose = text(input.purpose, 1, 500)
  if ("retentionUntil" in input) update.retentionUntil = parseRetentionUntil(input.retentionUntil, now)
  return update
}

export function parseProjectMember(body: unknown): ProjectMemberInput {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new BusinessError("INVALID_INPUT", "成员信息不完整或格式无效。")
  const input = body as Record<string, unknown>
  const keys = Object.keys(input).sort()
  if (keys.length !== 2 || keys[0] !== "role" || keys[1] !== "username") throw new BusinessError("INVALID_INPUT", "成员信息不完整或格式无效。")
  return { username: normalizeUsername(input.username), role: parseRole(input.role) }
}

export function parseProjectRole(body: unknown): ProjectRole {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new BusinessError("INVALID_INPUT", "成员角色无效。")
  const input = body as Record<string, unknown>
  if (Object.keys(input).length !== 1 || !("role" in input)) throw new BusinessError("INVALID_INPUT", "成员角色无效。")
  return parseRole(input.role)
}

function text(value: unknown, minimum: number, maximum: number): string {
  if (typeof value !== "string") throw invalid()
  const trimmed = value.trim()
  if (trimmed.length < minimum || trimmed.length > maximum || controlCharacters.test(trimmed)) throw invalid()
  return trimmed
}

function source(value: unknown): ProjectSource {
  if (typeof value !== "string" || !sources.includes(value as ProjectSource)) throw new BusinessError("INVALID_INPUT", "资料性质无效。")
  return value as ProjectSource
}

function today(now: Date): string {
  // Product dates use Asia/Shanghai; compare calendar dates rather than instants.
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).format(now)
}
