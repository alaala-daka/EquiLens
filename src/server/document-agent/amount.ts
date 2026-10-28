/** All public money values are strings. Never pass through Number or parseFloat. */
const decimalYuan = /^(-?)(0|[1-9]\d{0,21})(?:\.(\d{1,2}))?$/
const integerFen = /^-?(?:0|[1-9]\d{0,23})$/

export function yuanToFen(value: unknown): string {
  if (typeof value !== "string") throw new Error("金额须为人民币十进制字符串。")
  const match = value.match(decimalYuan)
  if (!match) throw new Error("金额格式无效，只接受最多两位小数。")
  const amount = BigInt(match[2]) * BigInt(100) + BigInt((match[3] ?? "").padEnd(2, "0"))
  return (match[1] ? -amount : amount).toString()
}

export function parseFen(value: unknown): bigint {
  if (typeof value !== "string" || !integerFen.test(value)) throw new Error("分金额格式无效。")
  return BigInt(value)
}

export function fenToYuan(value: string): string {
  const amount = parseFen(value), absolute = amount < BigInt(0) ? -amount : amount
  return `${amount < BigInt(0) ? "-" : ""}${absolute / BigInt(100)}.${(absolute % BigInt(100)).toString().padStart(2, "0")}`
}

/** ratio=0.8 means 80%; half-up rounding is explicit and applied once, at fen precision. */
export function applyRatio(amountFen: string, ratio: string): string {
  if (!/^(?:0(?:\.\d{1,6})?|1(?:\.0{1,6})?)$/.test(ratio)) throw new Error("支付比例须为0至1、最多六位小数。")
  const numerator = BigInt(ratio.replace(".", "")), denominator = BigInt(10) ** BigInt(ratio.split(".")[1]?.length ?? 0)
  const amount = parseFen(amountFen), absolute = amount < BigInt(0) ? -amount : amount
  const scaled = absolute * numerator
  const rounded = scaled / denominator + ((scaled % denominator) * BigInt(2) >= denominator ? BigInt(1) : BigInt(0))
  return (amount < BigInt(0) ? -rounded : rounded).toString()
}
