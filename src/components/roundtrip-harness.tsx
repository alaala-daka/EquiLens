"use client"

import { useEffect, useId, useRef, useState } from "react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { WordCanvas, type WordCanvasHandle } from "@/components/word-canvas"
import type { EngineState } from "@/lib/documents/editor-session"

export type RoundtripCapture = { json: unknown; base64?: string; error?: string }
export type RoundtripApi = {
  ready: () => boolean
  capture: () => Promise<RoundtripCapture>
}
declare global {
  interface Window {
    __roundtrip?: RoundtripApi
  }
}

async function blobToBase64(blob: Blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer())
  let binary = ""
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000))
  }
  return btoa(binary)
}

function download(name: string, blob: Blob) {
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement("a")
  anchor.href = url
  anchor.download = name
  anchor.click()
  URL.revokeObjectURL(url)
}

export function RoundtripHarness() {
  const keyboardHelpId = useId()
  const canvas = useRef<WordCanvasHandle | null>(null)
  const ready = useRef(false)
  const [blob, setBlob] = useState<Blob | null>(null)
  const [engine, setEngine] = useState<EngineState | null>(null)

  useEffect(() => {
    const api: RoundtripApi = {
      ready: () => ready.current && !!canvas.current,
      capture: async () => {
        const handle = canvas.current
        if (!handle || !ready.current) throw new Error("文档尚未就绪。")
        const json = handle.snapshot()
        try {
          return { json, base64: await blobToBase64(await handle.serialize()) }
        } catch (failure) {
          return { json, error: failure instanceof Error ? failure.message : String(failure) }
        }
      },
    }
    window.__roundtrip = api
    return () => {
      if (window.__roundtrip === api) delete window.__roundtrip
    }
  }, [])

  return <div className="flex h-dvh min-h-0 flex-col">
    <div className="flex shrink-0 flex-wrap items-center gap-2 border-b p-3">
      <Input type="file" accept=".docx" aria-label="Word 文档" onChange={event => {
        ready.current = false
        setEngine(null)
        setBlob(event.target.files?.[0] ?? null)
      }} />
      <p aria-live="polite" className="text-sm text-muted-foreground">{engine === "ready" ? "就绪" : engine === "failed" ? "加载失败" : "未就绪"}</p>
      <Button type="button" size="sm" disabled={engine !== "ready"} onClick={() => {
        const handle = canvas.current
        if (!handle) return
        handle.serialize().then(blob => download("roundtrip.export.docx", blob)).catch(() => {})
      }}>导出</Button>
      <Button type="button" size="sm" variant="outline" disabled={engine !== "ready"} onClick={() => {
        const handle = canvas.current
        if (!handle) return
        try {
          download("roundtrip.snapshot.json", new Blob([JSON.stringify(handle.snapshot(), null, 2)], { type: "application/json" }))
        } catch {}
      }}>快照</Button>
    </div>
    <p id={keyboardHelpId} className="sr-only">正文中按 F6 切换焦点，Shift+F6 返回。</p>
    {blob ? <WordCanvas ref={canvas} initialBlob={blob} onStateChange={state => {
      ready.current = state === "ready"
      setEngine(state)
    }} onChange={() => {}} keyboardHelpId={keyboardHelpId} keyboardBlocked={false} controlsDisabled={engine !== "ready"} onFocusShortcut={() => false} /> : null}
  </div>
}
