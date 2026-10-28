import type { SessionView } from "@/server/auth/service"

/**
 * Presentation state for the optional anonymous-workbench account entry.
 * It only reflects the server session; it is not an authorization decision.
 */
export type AccountEntryState =
  | { kind: "loading" }
  | { kind: "anonymous" }
  | { kind: "signed-in"; username: string }
  | { kind: "unavailable" }

export type AccountEntryProbe = { ok: true; session: SessionView } | { ok: false; status: number }

/** 401 means no usable session; any other failure stays visibly unavailable, not "signed out". */
export function accountEntryState(probe: AccountEntryProbe): AccountEntryState {
  if (probe.ok) return { kind: "signed-in", username: probe.session.user.username }
  return probe.status === 401 ? { kind: "anonymous" } : { kind: "unavailable" }
}
