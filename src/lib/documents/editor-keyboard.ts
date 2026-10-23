type FocusKey = Pick<KeyboardEvent, "key" | "ctrlKey" | "metaKey" | "altKey" | "shiftKey" | "isComposing" | "keyCode" | "repeat">

// Word owns Tab, Escape and its editing shortcuts. Only this explicit region
// switch may leave the body, and never while a menu or composition owns input.
export function editorFocusShortcut(event: FocusKey, context: {
  inBody: boolean
  busy: boolean
  popupOpen: boolean
}): "agent" | "actions" | null {
  if (event.key !== "F6" || event.ctrlKey || event.metaKey || event.altKey
    || event.isComposing || event.keyCode === 229 || event.repeat
    || !context.inBody || context.busy || context.popupOpen) return null
  return event.shiftKey ? "actions" : "agent"
}
