"use client"

import { useState } from "react"
import { Button } from "@/components/ui/button"
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select"
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet"
import { Textarea } from "@/components/ui/textarea"
import type { SourceAnchor } from "@/lib/facts/types"
import type { LedgerRow } from "@/lib/payments/types"
import { createProjectMaterialsClient, type MaterialSummary, type SnapshotFragment } from "@/lib/business/materials-client"
import { paymentFen, paymentYuan } from "./payment-form"
import { VerificationFragmentPicker } from "./verification-fragment-picker"

type FactOption = { factId: string; factVersionId: string; field: string; selectedValue?: string; confirmation: string; evidenceStatus: string }

/** Official Sheet + Field/Input/NativeSelect examples; fragment selection reuses the shared picker. */
export function PaymentRowEditor({ initial, projectId, materials, facts, isCurrent, onAccessInvalid, onChange, onSave, onClose }: {
  initial: LedgerRow; projectId: string; materials: MaterialSummary[]; facts: FactOption[]
  isCurrent(): boolean; onAccessInvalid(failure: unknown): void
  onChange(row: LedgerRow): void; onSave(row: LedgerRow): void; onClose(): void
}) {
  const [row, setRow] = useState(initial)
  const [amount, setAmount] = useState(paymentYuan(initial.amountFen))
  const [error, setError] = useState("")
  const [materialId, setMaterialId] = useState("")
  const [picker, setPicker] = useState<{ loading: boolean; fragments: SnapshotFragment[]; source: Omit<SourceAnchor, "fragmentId" | "quote"> | null } | null>(null)
  const [sourceError, setSourceError] = useState("")
  function update<K extends keyof LedgerRow>(key: K, value: LedgerRow[K]) {
    const next = { ...row, [key]: value }
    setRow(next); onChange(next)
  }
  async function chooseSource() {
    const material = materials.find(item => item.id === materialId)
    if (!material?.snapshotId) return
    setSourceError("")
    setPicker({ loading: true, fragments: [], source: null })
    try {
      const snapshot = await createProjectMaterialsClient({ projectId, isCurrent, onAccessInvalid }).snapshot(material.id, material.snapshotId)
      if (!isCurrent()) return
      setPicker({ loading: false, fragments: snapshot.fragments, source: { projectId, materialId: material.id, materialVersionId: snapshot.version.id, parseSnapshotId: snapshot.snapshot.id } })
    } catch (failure) { if (isCurrent()) { setSourceError(failure instanceof Error ? failure.message : "来源读取失败。"); setPicker(previous => previous ? { ...previous, loading: false } : null) } }
  }
  const optional = (key: keyof LedgerRow, label: string, type = "text") => <Field key={key}><FieldLabel htmlFor={`payment-row-${key}`}>{label}</FieldLabel><Input id={`payment-row-${key}`} type={type} value={String(row[key] ?? "")} onChange={event => update(key, event.target.value || undefined)} /></Field>
  const select = (key: "nature" | "basis" | "taxBasis" | "confirmation", label: string, options: readonly string[]) => <Field><FieldLabel htmlFor={`payment-row-${key}`}>{label}</FieldLabel><NativeSelect id={`payment-row-${key}`} value={row[key]} onChange={event => update(key, event.target.value as never)}>{options.map(value => <NativeSelectOption key={value} value={value}>{value}</NativeSelectOption>)}</NativeSelect></Field>
  return <Sheet open onOpenChange={open => { if (!open) onClose() }}><SheetContent className="overflow-y-auto">
    <SheetHeader><SheetTitle>款项行</SheetTitle></SheetHeader>
    <form className="space-y-4 px-4 pb-4" onSubmit={event => {
      event.preventDefault()
      const fen = paymentFen(amount)
      if (fen === null) { setError("金额须为最多两位小数的人民币数值。"); return }
      onSave({ ...row, amountFen: fen })
    }}><FieldGroup>
      {select("nature", "金额性质", ["计量", "计付基数", "净应付", "付款", "扣项", "未到期", "争议", "材料余额"])}
      <Field><FieldLabel htmlFor="payment-row-amount">金额（元）</FieldLabel><Input id="payment-row-amount" inputMode="decimal" value={amount} onChange={event => { setAmount(event.target.value); setError(""); update("amountFen", paymentFen(event.target.value) ?? `${event.target.value}元`) }} required /></Field>
      {select("basis", "本期 / 累计", ["不明", "本期", "累计"])}
      {select("taxBasis", "税口径", ["不明", "含税", "不含税"])}
      {optional("payer", "付款人")}{optional("payee", "收款人")}
      {optional("periodStart", "期间起始", "date")}{optional("periodEnd", "期间截止", "date")}
      {row.nature === "付款" && <>{optional("eventDate", "付款日期", "date")}{optional("transactionId", "流水 / 凭证标识")}</>}
      {["净应付", "计付基数"].includes(row.nature) && <>{optional("dueDate", "到期日", "date")}<Field><FieldLabel htmlFor="payment-condition">到期条件</FieldLabel><NativeSelect id="payment-condition" value={row.conditionMet === undefined ? "unknown" : String(row.conditionMet)} onChange={event => update("conditionMet", event.target.value === "unknown" ? undefined : event.target.value === "true")}><NativeSelectOption value="unknown">未确认</NativeSelectOption><NativeSelectOption value="true">已满足</NativeSelectOption><NativeSelectOption value="false">未满足</NativeSelectOption></NativeSelect></Field></>}
      {row.nature === "计付基数" && optional("ratio", "支付比例（0—1）")}
      {row.nature === "扣项" && <Field><FieldLabel htmlFor="payment-included">是否已计入净应付</FieldLabel><NativeSelect id="payment-included" value={row.includedInNet === undefined ? "unknown" : String(row.includedInNet)} onChange={event => update("includedInNet", event.target.value === "unknown" ? undefined : event.target.value === "true")}><NativeSelectOption value="unknown">未确认</NativeSelectOption><NativeSelectOption value="true">已计入</NativeSelectOption><NativeSelectOption value="false">未计入</NativeSelectOption></NativeSelect></Field>}
      {select("confirmation", "确认状态", ["未确认", "已确认", "待核实"])}
      <Field><FieldLabel htmlFor="payment-source-material">来源材料</FieldLabel><NativeSelect id="payment-source-material" value={materialId} onChange={event => setMaterialId(event.target.value)}><NativeSelectOption value="">选择材料</NativeSelectOption>{materials.filter(item => item.snapshotId).map(item => <NativeSelectOption key={item.id} value={item.id}>{item.title}</NativeSelectOption>)}</NativeSelect><Button type="button" variant="outline" disabled={!materialId} onClick={() => void chooseSource()}>选择原文片段</Button></Field>
      {row.source && <div className="space-y-2"><p className="whitespace-pre-wrap text-sm">{row.source.quote}</p><Button type="button" variant="ghost" onClick={() => update("source", undefined)}>移除来源</Button></div>}
      {facts.length > 0 && <Field><FieldLabel htmlFor="payment-fact">引用事实版本</FieldLabel><NativeSelect id="payment-fact" value="" onChange={event => { if (event.target.value) update("factVersionIds", [...new Set([...(row.factVersionIds ?? []), event.target.value])]) }}><NativeSelectOption value="">选择事实</NativeSelectOption>{facts.map(fact => <NativeSelectOption key={fact.factVersionId} value={fact.factVersionId}>{fact.field}：{fact.selectedValue ?? ""} · {fact.confirmation} · {fact.evidenceStatus}</NativeSelectOption>)}</NativeSelect>{(row.factVersionIds ?? []).map(id => <Button key={id} type="button" variant="ghost" onClick={() => update("factVersionIds", row.factVersionIds?.filter(item => item !== id))}>{facts.find(fact => fact.factVersionId === id)?.field ?? id} · 移除</Button>)}</Field>}
      <Field><FieldLabel htmlFor="payment-row-note">说明</FieldLabel><Textarea id="payment-row-note" value={row.note ?? ""} onChange={event => update("note", event.target.value || undefined)} /></Field>
    </FieldGroup>{error && <p role="alert" className="text-sm text-destructive">{error}</p>}<Button type="submit">确认款项行</Button></form>
    <VerificationFragmentPicker open={picker !== null} onOpenChange={open => { if (!open) setPicker(null) }} title="选择款项来源" fragments={picker?.fragments ?? []} loading={picker?.loading ?? false} error={sourceError} onSelect={fragment => {
      if (picker?.source) update("source", { ...picker.source, fragmentId: fragment.id, quote: fragment.text, locator: fragment.paragraph === null ? `片段 ${fragment.order + 1}` : `第 ${fragment.paragraph} 段` })
      setPicker(null)
    }} />
  </SheetContent></Sheet>
}
