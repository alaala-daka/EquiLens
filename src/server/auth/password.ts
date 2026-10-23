import { randomBytes, scrypt, timingSafeEqual } from "node:crypto"
import { AuthError } from "./errors"

const prefix = "scrypt-v1"
let pending = 0
let tail: Promise<void> = Promise.resolve()
async function derive(password: string, salt: Buffer): Promise<Buffer> {
  if (pending >= 8) throw new AuthError("AUTH_BUSY", "认证服务繁忙，请稍后重试。")
  pending++
  const prior = tail
  let release!: () => void
  tail = new Promise<void>(resolve => { release = resolve })
  await prior
  try {
    return await new Promise<Buffer>((resolve, reject) => {
      scrypt(password, salt, 64, { N: 131072, r: 8, p: 1, maxmem: 256 * 1024 * 1024 }, (error, key) => error ? reject(error) : resolve(key))
    })
  } finally { pending--; release() }
}
export function validPassword(password: string) {
  const length = Array.from(password).length
  return length >= 12 && length <= 128 && Buffer.byteLength(password, "utf8") <= 512
}
export async function hashPassword(password: string) {
  if (!validPassword(password)) throw new Error("Invalid password length")
  const salt = randomBytes(16)
  return `${prefix}$${salt.toString("hex")}$${(await derive(password, salt)).toString("hex")}`
}
export async function verifyPassword(password: string, encoded: string | null) {
  const match = encoded?.match(/^scrypt-v1\$([a-f0-9]{32})\$([a-f0-9]{128})$/)
  // Missing/invalid stored credentials perform the same fixed-cost work.
  const actual = await derive(password, match ? Buffer.from(match[1], "hex") : Buffer.alloc(16))
  const expected = match ? Buffer.from(match[2], "hex") : Buffer.alloc(64)
  return timingSafeEqual(actual, expected) && !!match
}
