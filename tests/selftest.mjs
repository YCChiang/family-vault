#!/usr/bin/env node
/**
 * Self-contained self-test: starts the server on a throwaway config (keyMode "file",
 * random port, temp directory), exercises the API and asserts the security-relevant
 * behaviour. No dependencies, no network access, safe to run anywhere.
 *
 *   node tests/selftest.mjs
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'family-vault-test-'))
const port = 18800 + Math.floor(Math.random() * 500)
const cfgPath = path.join(tmp, 'config.json')
const ALLOWED = '100.90.175.23'
const DENIED = '100.87.156.108'

fs.writeFileSync(cfgPath, JSON.stringify({
  bind: '127.0.0.1',
  port,
  dataFile: './vault.dat',
  keyFile: './vault.key',
  tokenFile: './api-token.txt',
  uiFile: path.join(root, 'ui.html'),
  keyMode: 'file',
  trustProxy: true,
  access: { autoInit: true, allowCidrs: ['100.64.0.0/10'], denyIps: [DENIED] }
}, null, 2))

const child = spawn(process.execPath, [path.join(root, 'vault-server.mjs')], {
  env: { ...process.env, VAULT_CONFIG: cfgPath },
  stdio: ['ignore', 'pipe', 'pipe']
})
let serverLog = ''
child.stdout.on('data', (d) => { serverLog += d })
child.stderr.on('data', (d) => { serverLog += d })

const base = `http://127.0.0.1:${port}`
const results = []
const check = (name, ok, detail = '') => { results.push({ name, ok, detail }); console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? '  ' + detail : ''}`) }

async function req(method, url, { ip, token, body } = {}) {
  const headers = {}
  if (ip) headers['X-Forwarded-For'] = ip
  if (token) headers['X-Vault-Token'] = token
  if (body !== undefined) headers['Content-Type'] = 'application/json; charset=utf-8'
  const r = await fetch(base + url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) })
  let data = null
  try { data = await r.json() } catch { /* no body */ }
  return { status: r.status, data }
}

async function waitReady() {
  for (let i = 0; i < 100; i++) {
    try { const h = await req('GET', '/api/health'); if (h.status === 200) return true } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 100))
  }
  return false
}

try {
  if (!await waitReady()) throw new Error('server did not become ready\n' + serverLog)

  const h = await req('GET', '/api/health', { ip: ALLOWED })
  check('health from an allowed peer', h.status === 200 && h.data.initialized === true)

  const hDeny = await req('GET', '/api/health', { ip: DENIED })
  check('health from a denied peer is refused', hDeny.status === 403, `status=${hDeny.status}`)

  const hLo = await req('GET', '/api/health')
  check('health from loopback', hLo.status === 200)

  const empty = await req('GET', '/api/state')
  check('state (no auth beyond the network policy)', empty.status === 200 && empty.data.vault.people.length === 0)

  const save = await req('POST', '/api/save', {
    ip: ALLOWED,
    body: { people: [
      { name: 'Alice', appellation: 'mom,mother', fields: { 'ID card': '110101199001011234', phone: '13800000000' }, notes: 'secret note' },
      { name: 'Bob', appellation: 'dad', fields: { phone: '13900000000' } }
    ] }
  })
  check('save', save.status === 200 && save.data.saved === 2)

  const saveDeny = await req('POST', '/api/save', { ip: DENIED, body: { people: [] } })
  check('save from a denied peer is refused', saveDeny.status === 403, `status=${saveDeny.status}`)

  const noToken = await req('GET', '/api/index')
  check('token API without a token is 401', noToken.status === 401, `status=${noToken.status}`)

  const token = fs.readFileSync(path.join(tmp, 'api-token.txt'), 'utf8').trim()
  const idx = await req('GET', '/api/index', { token })
  const idxPerson = idx.data.people.find((p) => p.name === 'Alice')
  check('index returns field labels', idx.status === 200 && idxPerson.fields.includes('ID card'))
  check('index never contains values', !JSON.stringify(idx.data).includes('110101199001011234'))

  const byName = await req('GET', '/api/lookup?name=Alice&field=' + encodeURIComponent('ID card'), { token })
  check('lookup by name', byName.status === 200 && byName.data.value === '110101199001011234', `matchedBy=${byName.data.matchedBy}`)

  const byApp = await req('GET', '/api/lookup?name=' + encodeURIComponent('妈妈') + '&field=phone', { token })
  const byApp2 = await req('GET', '/api/lookup?name=mother&field=phone', { token })
  check('lookup by appellation (alias token)', byApp2.status === 200 && byApp2.data.name === 'Alice' && byApp2.data.matchedBy === 'appellation')
  check('unknown query -> 404', byApp.status === 404, `status=${byApp.status}`)

  await req('POST', '/api/save', { ip: ALLOWED, body: { people: [
    { name: 'C1', appellation: 'dad', fields: {} },
    { name: 'C2', appellation: 'dad', fields: {} }
  ] } })
  const amb = await req('GET', '/api/lookup?name=dad', { token })
  check('ambiguous appellation -> 409 with candidates', amb.status === 409 && Array.isArray(amb.data.candidates) && amb.data.candidates.length === 2)

  check('no password surfaces exist', (await req('POST', '/api/login', { ip: ALLOWED })).status === 404)
  check('no session endpoint exists', (await req('POST', '/api/device-login', { ip: ALLOWED })).status === 404)

  const env = JSON.parse(fs.readFileSync(path.join(tmp, 'vault.dat'), 'utf8'))
  check('envelope has no password wrapping', !env.kdf && !env.wrappedDek && env.v === 2)
  check('data file does not contain plaintext', !fs.readFileSync(path.join(tmp, 'vault.dat'), 'utf8').includes('110101199001011234'))
  check('server log never contains a value', !serverLog.includes('110101199001011234') && !serverLog.includes('13800000000'))
} catch (err) {
  check('unexpected failure', false, err.message)
} finally {
  child.kill()
  await new Promise((r) => setTimeout(r, 200))
  fs.rmSync(tmp, { recursive: true, force: true })
}

const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
process.exit(failed.length === 0 ? 0 : 1)
