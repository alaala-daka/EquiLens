"use client"

import { useEffect } from "react"
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog"
import type { RetentionConsent } from "@/lib/documents/session-types"

export type RetentionConfirmationRequest = { consent: RetentionConsent; signal: AbortSignal }

export function DocumentSessionDialog({ request, onDecision }: {
  request: RetentionConfirmationRequest | null
  onDecision: (accepted: boolean) => void
}) {
  useEffect(() => {
    if (!request) return
    const abort = () => onDecision(false)
    if (request.signal.aborted) abort()
    else request.signal.addEventListener("abort", abort, { once: true })
    return () => request.signal.removeEventListener("abort", abort)
  }, [request, onDecision])

  return <AlertDialog open={request !== null} onOpenChange={open => { if (!open) onDecision(false) }}>
    <AlertDialogContent onCloseAutoFocus={event => { event.preventDefault() }}>
      <AlertDialogHeader>
        <AlertDialogTitle>确认文档保留期限</AlertDialogTitle>
        <AlertDialogDescription>到期日：{request?.consent.expiresOn}。到期后将无法访问，请及时下载需要保留的文档。</AlertDialogDescription>
      </AlertDialogHeader>
      <AlertDialogFooter>
        <AlertDialogCancel onClick={() => onDecision(false)}>取消</AlertDialogCancel>
        <AlertDialogAction onClick={() => onDecision(true)}>确认并继续</AlertDialogAction>
      </AlertDialogFooter>
    </AlertDialogContent>
  </AlertDialog>
}
