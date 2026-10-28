const assert = require('node:assert/strict')
const { spawn } = require('node:child_process')
const { createWriteStream } = require('node:fs')
const { mkdtemp } = require('node:fs/promises')
const { tmpdir } = require('node:os')
const path = require('node:path')

const root = process.cwd()
const base = 'http://127.0.0.1:3187'
const origin = 'https://synthetic.example'
const password = 'Synthetic bootstrap password 123!'
const replacement = 'Synthetic replacement password 456!'
const changed = 'Synthetic ignored password 789!'
let server
let output
let database
const env = {
  ...Object.fromEntries(Object.entries(process.env).filter(([key]) => /^(PATH|SYSTEMROOT|WINDIR|TEMP|TMP|COMSPEC|PATHEXT)$/i.test(key))),
  NODE_ENV: 'production', DATABASE_PROVIDER: 'sqlite', APP_ORIGIN: origin,
  PORT: '3187', HOSTNAME: '127.0.0.1', ANONYMOUS_DATA_RETENTION_DAYS: '2',
  AI_BASE_URL: 'https://unused.invalid/v1', AI_API_KEY: '', AI_MODEL: 'synthetic-unused',
  AI_REVIEW_RETENTION_DAYS: '2', AI_REVIEW_MODE: 'debug',
}
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
async function stop() {
  if (!server || server.exitCode !== null) return
  const exited = new Promise(resolve => server.once('exit', resolve))
  server.kill()
  await exited
  output?.end()
}
async function start(name, secret, label) {
  output = createWriteStream(path.join(__dirname, `${label}-server.txt`))
  server = spawn(process.execPath, [path.join(root, '.next/standalone/server.js')], {
    cwd: root, env: { ...env, SQLITE_PATH: database, BOOTSTRAP_ADMIN_USERNAME: name, BOOTSTRAP_ADMIN_PASSWORD: secret },
    stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
  })
  server.stdout.pipe(output, { end: false }); server.stderr.pipe(output, { end: false })
  for (let n = 0; n < 80; n++) {
    if (server.exitCode !== null) throw new Error('Synthetic production server exited')
    try {
      const r = await fetch(`${base}/api/auth/session`, { signal: AbortSignal.timeout(1000) })
      if (r.status === 401) return
    } catch {}
    await delay(500)
  }
  throw new Error('Synthetic auth did not become ready')
}
async function login(username, secret) {
  const response = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password: secret }) })
  const body = await response.json()
  const cookie = response.headers.get('set-cookie')?.split(';')[0]
  return { response, body, cookie }
}
async function session(cookie) {
  return fetch(`${base}/api/auth/session`, { headers: { cookie, 'X-Role': 'superadmin' } })
}
async function maintain(action, username, secret) {
  const child = spawn(process.execPath, [path.join(root, 'node_modules/tsx/dist/cli.mjs'), path.join(root, 'scripts/manage-account.mts'), action, '--username', username, '--actor', 'synthetic-production-check'], {
    cwd: path.dirname(database), env: { ...env, SQLITE_PATH: database }, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
  })
  let safeOutput = ''
  child.stdout.on('data', b => safeOutput += b)
  child.stderr.on('data', b => safeOutput += b)
  child.stdin.on('error', () => {})
  child.stdin.end(secret ? `${secret}\n` : '')
  const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve) })
  assert.equal(code, 0, `synthetic maintenance ${action} failed`)
  for (const value of [password, replacement, changed]) assert.equal(safeOutput.includes(value), false)
}
async function main() {
  database = path.join(await mkdtemp(path.join(tmpdir(), 'equilens-admin-production-')), 'synthetic.sqlite')
  await start('synthetic-admin', password, 'first')
  const admin = await login('synthetic-admin', password)
  assert.equal(admin.response.status, 200)
  assert.equal(admin.body.user.role, 'superadmin')
  assert.equal(admin.response.headers.get('cache-control'), 'private, no-store')
  assert.ok(/HttpOnly.*Secure/.test(admin.response.headers.get('set-cookie') ?? ''), 'private secure cookie attributes required')
  assert.equal((await (await session(admin.cookie)).json()).user.role, 'superadmin')
  await maintain('create', 'synthetic-member', password)
  const member = await login('synthetic-member', password)
  assert.equal(member.body.user.role, 'member')
  assert.equal((await (await session(member.cookie)).json()).user.role, 'member')
  await maintain('grant-admin', 'synthetic-member')
  assert.equal((await session(member.cookie)).status, 401)
  const promoted = await login('synthetic-member', password)
  assert.equal(promoted.body.user.role, 'superadmin')
  await maintain('revoke-admin', 'synthetic-member')
  assert.equal((await session(promoted.cookie)).status, 401)
  await maintain('disable', 'synthetic-admin')
  assert.equal((await session(admin.cookie)).status, 401)
  await stop()
  await start('another-synthetic-admin', changed, 'second')
  assert.equal((await login('synthetic-admin', password)).response.status, 401)
  assert.equal((await login('another-synthetic-admin', changed)).response.status, 401)
  await maintain('enable', 'synthetic-admin')
  const enabled = await login('synthetic-admin', password)
  assert.equal(enabled.body.user.role, 'superadmin')
  assert.equal((await session(admin.cookie)).status, 401)
  await maintain('reset', 'synthetic-admin', replacement)
  assert.equal((await session(enabled.cookie)).status, 401)
  await stop()
  await start('synthetic-admin', changed, 'third')
  const reset = await login('synthetic-admin', replacement)
  assert.equal(reset.response.status, 200)
  assert.equal(reset.body.user.role, 'superadmin')
  const smoke = spawn(process.execPath, [path.join(root, 'scripts/smoke.mjs'), base], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
  smoke.stdout.pipe(process.stdout); smoke.stderr.pipe(process.stderr)
  assert.equal(await new Promise((resolve, reject) => { smoke.once('error', reject); smoke.once('close', resolve) }), 0)
  console.log('PASS: production bootstrap/login/session roles, forged role ignored, CLI grant/revoke/disable/enable/reset, old sessions revoked, persisted marker across two restarts, changed configuration ignored, production page/static smoke.')
  console.log('Scope: local HTTP API transport with explicit synthetic HTTPS Origin; not public HTTPS or browser-cookie acceptance.')
}
main().catch(error => { console.error(error.message); process.exitCode = 1 }).finally(stop)
