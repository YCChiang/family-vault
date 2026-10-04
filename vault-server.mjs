#!/usr/bin/env node
/**
 * family-vault - a tiny, dependency-free, self-hosted encrypted family information store.
 *
 * What it is
 *   A local HTTP service that stores family identity data (ID numbers, phone numbers,
 *   licence plates, ...) in a single AES-256-GCM encrypted file, plus a small web UI to
 *   edit it and a token API that other local programs (e.g. a chat agent) can query.
 *
 * Security model (read SECURITY.md before deploying)
 *   - The vault file is encrypted with a random 256-bit DEK.
 *   - The DEK is NOT stored in the vault file. It is kept in a separate key file:
 *       keyMode "dpapi" (Windows): wrapped by Windows DPAPI (LocalMachine), so the key
 *                                    file is useless if copied to another machine.
 *       keyMode "file"            : raw key, protected only by filesystem permissions.
 *   - There is no password and no login session. The ONLY gate for the web UI is a
 *     network policy (access.allowCidrs / access.denyIps) evaluated on the real peer
 *     address supplied by the reverse proxy. Run it on loopback behind
 *     `tailscale serve`, WireGuard, an SSH tunnel, or any proxy that overwrites
 *     X-Forwarded-For - never expose it directly to the internet.
 *   - Nothing is ever logged except error kinds; values are only returned to callers
 *     that pass the network policy or the API token.
 *
 * Endpoints
 *   GET  /                     web UI
 *   GET  /api/health           { ok, initialized, ip }
 *   GET  /api/state            full vault (network policy only)
 *   POST /api/save             { people: [...] } (network policy only)
 *   GET  /api/index            names/appellations/field labels - never values (token)
 *   GET  /api/lookup?name=&field=   resolve a person by name OR appellation (token)
 *
 * Zero npm dependencies (node:http/crypto; PowerShell is used only for DPAPI on Windows).
 */
import http from 'node:http'
import net from 'node:net'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const cfgPath = path.resolve(process.env.VAULT_CONFIG || path.join(__dirname, 'config.json'))
// tolerate a UTF-8 BOM (Windows PowerShell's Set-Content -Encoding UTF8 adds one)
const readJsonFile = (p) => JSON.parse(fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, ''))
const cfg = readJsonFile(cfgPath)

// relative paths in the config are resolved against the config file's own directory
const cfgDir = path.dirname(cfgPath)
const abs = (p, fallback) => path.resolve(cfgDir, p || fallback)

const BIND = cfg.bind || '127.0.0.1'
const PORT = Number(cfg.port || 8791)
const DATA_FILE = abs(cfg.dataFile, './data/vault.dat')
const KEY_FILE = abs(cfg.keyFile || cfg.dpapiFile, './data/vault.key')
const TOKEN_FILE = abs(cfg.tokenFile, './data/api-token.txt')
const UI_FILE = abs(cfg.uiFile, './ui.html')
const TMP_DIR = path.join(path.dirname(DATA_FILE), 'tmp')
const TRUST_PROXY = cfg.trustProxy === true
// auto -> DPAPI on Windows, plain key file elsewhere
const KEY_MODE = ['dpapi', 'file', 'auto'].includes(cfg.keyMode)
  ? cfg.keyMode
  : (cfg.keyMode ? 'auto' : (cfg.keyFile || cfg.dpapiFile ? 'auto' : 'auto'))
const USE_DPAPI = KEY_MODE === 'dpapi' || (KEY_MODE === 'auto' && process.platform === 'win32')
if (KEY_MODE === 'file' || (KEY_MODE === 'auto' && process.platform !== 'win32')) {
  console.warn('[vault] WARNING: keyMode=file - the key file is NOT machine-bound. Protect it with filesystem permissions and never commit it.')
}

// ---------- access control (the only gate for the web UI) ----------
const ACCESS = cfg.access || {}
const ALLOW_CIDRS = Array.isArray(ACCESS.allowCidrs) ? ACCESS.allowCidrs : []
const DENY_IPS = Array.isArray(ACCESS.denyIps) ? ACCESS.denyIps : []
const AUTO_INIT = ACCESS.autoInit !== false
function addSpec(bl, spec) {
  const s = String(spec || '').trim()
  if (!s) return
  const fam = s.includes(':') ? 'ipv6' : 'ipv4'
  try {
    if (s.includes('/')) { const [a, bits] = s.split('/'); bl.addSubnet(a.trim(), Number(bits), fam) }
    else bl.addAddress(s, fam)
  } catch (err) {
    console.error('[vault] bad cidr ignored:', s, err && err.message)
  }
}
const BL_LOOPBACK = new net.BlockList()
BL_LOOPBACK.addSubnet('127.0.0.0', 8, 'ipv4')
BL_LOOPBACK.addAddress('::1', 'ipv6')
const BL_ALLOW = new net.BlockList()
const BL_DENY = new net.BlockList()
for (const c of ALLOW_CIDRS) addSpec(BL_ALLOW, c)
for (const c of DENY_IPS) addSpec(BL_DENY, c)
function ipAllowed(ipRaw) {
  let ip = String(ipRaw || '').trim()
  if (!ip) return false
  if (ip.startsWith('::ffff:')) ip = ip.slice(7)
  const fam = ip.includes(':') ? 'ipv6' : 'ipv4'
  try {
    if (BL_LOOPBACK.check(ip, fam)) return true          // local scripts / local browser
    if (BL_DENY.check(ip, fam)) return false             // deny wins
    if (ALLOW_CIDRS.length === 0) return true            // no allow list = do not filter by IP
    return BL_ALLOW.check(ip, fam)
  } catch { return false }
}

const b64 = (b) => Buffer.from(b).toString('base64')
const gcm = (key, iv, buf) => {
  const c = crypto.createCipheriv('aes-256-gcm', key, iv)
  const ct = Buffer.concat([c.update(buf), c.final()])
  return { iv: b64(iv), tag: b64(c.getAuthTag()), ct: b64(ct) }
}
const ungcm = (key, box) => {
  const d = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(box.iv, 'base64'))
  d.setAuthTag(Buffer.from(box.tag, 'base64'))
  return Buffer.concat([d.update(Buffer.from(box.ct, 'base64')), d.final()])
}

// ---------- key storage ----------
// dpapi  : Windows DPAPI (LocalMachine) - non-portable off this machine
// file   : raw base64 key with mode 0600 - portable, weaker (see SECURITY.md)
let keyCache = null
const DPAPI_PROLOGUE = "try{Add-Type -AssemblyName System.Security -ErrorAction Stop}catch{};try{Add-Type -AssemblyName System.Security.Cryptography.ProtectedData -ErrorAction Stop}catch{};"
function psQuote(s) { return "'" + String(s).replace(/'/g, "''") + "'" }
function dpapiUnprotect(buf) {
  const code = `$b=[Convert]::FromBase64String(${psQuote(buf.toString('base64'))});$p=[System.Security.Cryptography.ProtectedData]::Unprotect($b,$null,'LocalMachine');[Convert]::ToBase64String($p)`
  const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', DPAPI_PROLOGUE + code], { encoding: 'utf8', windowsHide: true })
  return Buffer.from(out.trim(), 'base64')
}
function dpapiProtect(buf) {
  const code = `$b=[Convert]::FromBase64String(${psQuote(buf.toString('base64'))});$p=[System.Security.Cryptography.ProtectedData]::Protect($b,$null,'LocalMachine');[Convert]::ToBase64String($p)`
  const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', DPAPI_PROLOGUE + code], { encoding: 'utf8', windowsHide: true })
  return Buffer.from(out.trim(), 'base64')
}
function writeKeyFile(dek) {
  fs.mkdirSync(path.dirname(KEY_FILE), { recursive: true })
  const payload = USE_DPAPI ? dpapiProtect(dek) : Buffer.from(dek.toString('base64'), 'utf8')
  fs.writeFileSync(KEY_FILE, payload, { mode: 0o600 })
}
function readKeyFile() {
  if (keyCache) return keyCache
  if (!fs.existsSync(KEY_FILE)) return null
  const raw = fs.readFileSync(KEY_FILE)
  keyCache = USE_DPAPI ? dpapiUnprotect(raw) : Buffer.from(raw.toString('utf8').trim(), 'base64')
  return keyCache
}

// ---------- vault file ----------
// envelope: { v:2, createdAt, updatedAt, data:{iv,tag,ct} }  - no password, no wrapped key
const EMPTY_VAULT = () => ({ version: 2, createdAt: new Date().toISOString(), people: [] })
const vaultExists = () => fs.existsSync(DATA_FILE)
function readEnvelope() { return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')) }
function writeEnvelope(env) {
  fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true })
  const tmp = DATA_FILE + '.tmp-' + crypto.randomBytes(4).toString('hex')
  fs.writeFileSync(tmp, JSON.stringify(env), { encoding: 'utf8', mode: 0o600 })
  fs.renameSync(tmp, DATA_FILE)
}
function readVaultWithKey(key) {
  return normalizeVault(JSON.parse(ungcm(key, readEnvelope().data).toString('utf8')))
}
function writeVaultWithKey(key, vault) {
  const env = readEnvelope()
  env.data = gcm(key, crypto.randomBytes(12), Buffer.from(JSON.stringify(vault), 'utf8'))
  env.v = 2
  env.updatedAt = new Date().toISOString()
  writeEnvelope(env)
}
function readApiToken() { try { return fs.readFileSync(TOKEN_FILE, 'utf8').trim() } catch { return '' } }
function ensureApiToken() {
  let t = readApiToken()
  if (!t) {
    t = crypto.randomBytes(32).toString('base64url')
    fs.mkdirSync(path.dirname(TOKEN_FILE), { recursive: true })
    fs.writeFileSync(TOKEN_FILE, t, { encoding: 'utf8', mode: 0o600 })
  }
  return t
}
function createVault() {
  const dek = crypto.randomBytes(32)
  const env = {
    v: 2,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    data: gcm(dek, crypto.randomBytes(12), Buffer.from(JSON.stringify(EMPTY_VAULT()), 'utf8'))
  }
  writeEnvelope(env)
  writeKeyFile(dek)
  keyCache = dek
  return { dek, token: ensureApiToken() }
}
// migrate an old password-wrapped envelope (v1) to v2: the data blob is kept as is
function migrateEnvelope() {
  if (!vaultExists()) return
  let env
  try { env = readEnvelope() } catch (err) { console.error('[vault] read envelope failed:', err && err.message); return }
  if (!env.kdf && !env.wrappedDek) return
  delete env.kdf
  delete env.wrappedDek
  env.v = 2
  env.updatedAt = new Date().toISOString()
  writeEnvelope(env)
  console.log('[vault] envelope migrated to password-free v2 (data untouched)')
}
// purge plaintext temp files left behind by a killed client (see clients/openclaw)
function purgeStaleTemp() {
  try {
    const cutoff = Date.now() - 2 * 60 * 1000
    for (const f of fs.readdirSync(TMP_DIR)) {
      if (!/^vault-send-.*\.txt$/.test(f)) continue
      const fp = path.join(TMP_DIR, f)
      if (fs.statSync(fp).mtimeMs < cutoff) { fs.unlinkSync(fp); console.log('[vault] purged stale temp file', f) }
    }
  } catch { /* no tmp dir yet */ }
}

// ---------- people ----------
// { name, appellation, fields, notes }; appellation = how you actually call them
// (爸爸 / 妈妈 / 小姨 / ...). Legacy rows that only have "relation" are converted.
const LEGACY_RELATION_APPELLATION = { '父亲': '爸爸,父亲', '母亲': '妈妈,母亲', '丈夫': '老公,丈夫', '妻子': '老婆,妻子' }
function normalizeVault(v) {
  return {
    version: 2,
    updatedAt: v.updatedAt || '',
    people: (Array.isArray(v.people) ? v.people : []).map((p) => ({
      name: String(p.name || ''),
      appellation: String(
        p.appellation != null
          ? p.appellation
          : (LEGACY_RELATION_APPELLATION[String(p.relation || '').trim()] || p.relation || '')
      ),
      fields: (p.fields && typeof p.fields === 'object') ? p.fields : {},
      notes: String(p.notes || ''),
      updatedAt: p.updatedAt || ''
    }))
  }
}
function buildIndex(vault) {
  return {
    ok: true,
    people: (vault.people || []).map((p) => ({
      name: p.name,
      appellation: p.appellation || '',
      fields: Object.keys(p.fields || {}).filter((k) => String((p.fields || {})[k] || '').length > 0),
      hasNotes: Boolean(p.notes),
      updatedAt: p.updatedAt || ''
    }))
  }
}
function appTokens(p) {
  return String(p.appellation || '').split(/[,，、/;；\s]+/).map((s) => s.trim()).filter(Boolean)
}
function ambiguous(hits) {
  return { error: 'ambiguous', candidates: hits.map((p) => `${p.name}${p.appellation ? '（' + p.appellation + '）' : ''}`) }
}
// resolve by name first, then by appellation; never guess when several people match
function resolvePerson(vault, query) {
  const q = String(query || '').trim()
  if (!q) return { error: 'empty_query' }
  const people = vault.people || []
  const byName = people.filter((p) => p.name === q)
  if (byName.length === 1) return { person: byName[0], matchedBy: 'name' }
  if (byName.length > 1) return ambiguous(byName)
  const nameLike = people.filter((p) => p.name.includes(q))
  if (nameLike.length === 1) return { person: nameLike[0], matchedBy: 'name' }
  if (nameLike.length > 1) return ambiguous(nameLike)
  const appExact = people.filter((p) => appTokens(p).includes(q))
  if (appExact.length === 1) return { person: appExact[0], matchedBy: 'appellation' }
  if (appExact.length > 1) return ambiguous(appExact)
  const appLike = people.filter((p) => String(p.appellation || '').includes(q))
  if (appLike.length === 1) return { person: appLike[0], matchedBy: 'appellation' }
  if (appLike.length > 1) return ambiguous(appLike)
  return { error: 'person_not_found' }
}
function loadVault() {
  const key = readKeyFile()
  if (!key) return { error: 'key_unavailable' }
  if (!vaultExists()) {
    if (!AUTO_INIT) return { error: 'not_initialized' }
    createVault()
  }
  return { vault: readVaultWithKey(key), key }
}

// ---------- http ----------
const timingEqual = (a, b) => {
  const x = Buffer.from(String(a)); const y = Buffer.from(String(b))
  if (x.length !== y.length || x.length === 0) return false
  return crypto.timingSafeEqual(x, y)
}
function clientIp(req) {
  if (TRUST_PROXY) { const xf = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim(); if (xf) return xf }
  return req.socket.remoteAddress || 'local'
}
function readBody(req, limit = 2_000_000) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = []
    req.on('data', (c) => { size += c.length; if (size > limit) { reject(new Error('too_large')); req.destroy(); return } chunks.push(c) })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}
const send = (res, status, body, headers = {}) => {
  const isStr = typeof body === 'string'
  res.writeHead(status, {
    'Content-Type': isStr ? 'text/html; charset=utf-8' : 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    ...headers
  })
  res.end(isStr ? body : JSON.stringify(body))
}
const json = (res, status, obj, headers = {}) => send(res, status, JSON.stringify(obj), headers)

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost')
  const p = url.pathname
  const method = req.method || 'GET'
  const tokenHeader = String(req.headers['x-vault-token'] || '')
  const tokenOk = tokenHeader && timingEqual(tokenHeader, readApiToken())
  const reqIp = clientIp(req)

  try {
    // ---- the only gate: network policy (deny wins; loopback is always allowed for scripts) ----
    if (!ipAllowed(reqIp)) {
      console.error('[vault] denied by ip policy:', reqIp, method, p)
      if (p.startsWith('/api/')) return json(res, 403, { ok: false, error: 'ip_not_allowed' })
      return send(res, 403, '<!doctype html><meta charset="utf-8"><h1>403</h1><p>Not allowed from this device.</p>')
    }
    // no cookies are used, but an allowed-network page must not be able to write cross-site
    if (method === 'POST' && String(req.headers['sec-fetch-site'] || '') === 'cross-site') {
      return json(res, 403, { ok: false, error: 'cross_site_blocked' })
    }

    if (p === '/favicon.ico') return send(res, 204, '')
    if ((p === '/' || p === '/index.html') && method === 'GET') {
      let html = '<h1>family-vault</h1><p>ui.html missing</p>'
      try { html = fs.readFileSync(UI_FILE, 'utf8') } catch { /* keep */ }
      return send(res, 200, html)
    }
    if (p === '/api/health' && method === 'GET') {
      return json(res, 200, { ok: true, service: 'family-vault', initialized: vaultExists(), ip: reqIp })
    }

    // ---- web channel (network policy only: no password, no session) ----
    if (p === '/api/state' && method === 'GET') {
      const r = loadVault()
      if (r.error) return json(res, r.error === 'not_initialized' ? 409 : 500, { ok: false, error: r.error })
      return json(res, 200, { ok: true, vault: r.vault })
    }
    if (p === '/api/save' && method === 'POST') {
      const r = loadVault()
      if (r.error) return json(res, r.error === 'not_initialized' ? 409 : 500, { ok: false, error: r.error })
      const body = JSON.parse((await readBody(req)) || '{}')
      const people = (Array.isArray(body.people) ? body.people : []).map((x) => ({
        name: String(x.name || '').slice(0, 60),
        appellation: String((x.appellation != null ? x.appellation : (x.relation || ''))).slice(0, 60),
        fields: Object.fromEntries(Object.entries(x.fields || {})
          .filter(([k]) => String(k).trim())
          .map(([k, v]) => [String(k).slice(0, 40), String(v == null ? '' : v).slice(0, 500)])),
        notes: String(x.notes || '').slice(0, 2000),
        updatedAt: new Date().toISOString()
      }))
      writeVaultWithKey(r.key, { version: 2, updatedAt: new Date().toISOString(), people })
      return json(res, 200, { ok: true, saved: people.length })
    }

    // ---- token API (for local programs; never returns anything without the token) ----
    if (p === '/api/index' && method === 'GET') {
      if (!tokenOk) return json(res, 401, { ok: false, error: 'unauthorized' })
      const r = loadVault()
      if (r.error) return json(res, r.error === 'not_initialized' ? 409 : 503, { ok: false, error: r.error })
      return json(res, 200, buildIndex(r.vault))
    }
    if (p === '/api/lookup' && method === 'GET') {
      if (!tokenOk) return json(res, 401, { ok: false, error: 'unauthorized' })
      const r = loadVault()
      if (r.error) return json(res, r.error === 'not_initialized' ? 409 : 503, { ok: false, error: r.error })
      const name = url.searchParams.get('name') || ''
      const field = url.searchParams.get('field') || ''
      const hit = resolvePerson(r.vault, name)
      if (hit.error === 'ambiguous') return json(res, 409, { ok: false, error: 'ambiguous', name, candidates: hit.candidates })
      if (hit.error) return json(res, 404, { ok: false, error: hit.error, name })
      const person = hit.person
      const fields = person.fields || {}
      const nonEmpty = Object.keys(fields).filter((k) => String(fields[k] || '').length > 0)
      if (!field) {
        return json(res, 200, { ok: true, name: person.name, appellation: person.appellation || '', fields: nonEmpty, matchedBy: hit.matchedBy })
      }
      const key = Object.keys(fields).find((k) => k === field)
        || nonEmpty.find((k) => k.includes(field))
        || Object.keys(fields).find((k) => k.includes(field))
      if (!key) return json(res, 404, { ok: false, error: 'field_not_found', name: person.name, field })
      return json(res, 200, { ok: true, name: person.name, appellation: person.appellation || '', field: key, value: String(fields[key] || ''), matchedBy: hit.matchedBy })
    }
    return json(res, 404, { ok: false, error: 'not_found' })
  } catch (err) {
    // never echo values; log the failure kind only
    console.error('[vault] request failed:', method, p, (err && err.message) ? err.message : 'error')
    return json(res, 500, { ok: false, error: 'internal_error' })
  }
})

// ---------- startup ----------
migrateEnvelope()
purgeStaleTemp()
if (!vaultExists()) {
  if (AUTO_INIT) {
    const { token } = createVault()
    console.log('[vault] initialized empty vault, api token ready len=%d', token.length)
  } else {
    console.log('[vault] no vault file and autoInit=false; waiting for manual setup')
  }
}
server.listen(PORT, BIND, () => {
  console.log(`[vault] listening on http://${BIND}:${PORT}  data=${DATA_FILE}  keyMode=${USE_DPAPI ? 'dpapi' : 'file'}  initialized=${vaultExists()}`)
})
