/** Revoke editing without replacing the engine or its unsaved document. */
export function revokeEngineEditing(engine: { setDocumentMode: (mode: "viewing") => void; activeEditor?: { setEditable: (editable: boolean, emitUpdate: boolean) => void } | null }) {
  engine.setDocumentMode("viewing")
  engine.activeEditor?.setEditable(false, false)
}
