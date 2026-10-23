"use client"

import type { ReactNode } from "react"
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog"

type EditorLeaveDialogProps = {
  open: boolean
  busy: boolean
  canSave: boolean
  onCancel: () => void
  onDiscard: () => void
  onSave: () => void
  children?: ReactNode
  onCloseAutoFocus?: (event: Event) => void
}

export function EditorLeaveDialog({ open, busy, canSave, onCancel, onDiscard, onSave, children, onCloseAutoFocus }: EditorLeaveDialogProps) {
  return (
    <AlertDialog open={open} onOpenChange={next => { if (!next && !busy) onCancel() }}>
      <AlertDialogContent onCloseAutoFocus={onCloseAutoFocus} onEscapeKeyDown={event => { if (busy) event.preventDefault() }} aria-busy={busy}>
        <AlertDialogHeader>
          <AlertDialogTitle>保存文档更改？</AlertDialogTitle>
          <AlertDialogDescription>离开或重新加载前，请选择如何处理未保存的更改。</AlertDialogDescription>
        </AlertDialogHeader>
        {children}
        <AlertDialogFooter>
          <AlertDialogCancel disabled={busy}>取消</AlertDialogCancel>
          <AlertDialogAction variant="outline" disabled={busy} onClick={event => { event.preventDefault(); onDiscard() }}>放弃更改</AlertDialogAction>
          <AlertDialogAction disabled={busy || !canSave} onClick={event => { event.preventDefault(); onSave() }}>{busy ? "正在处理" : "保存并离开"}</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
