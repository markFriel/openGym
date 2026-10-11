/* opengym-mcp client: the write path. Talks to the running openGym api with a bearer token
   (obtained once with `npm run pair`) and commits a change the way the app does: read the
   document and its revision, apply the change to a copy, stamp it with the app's own stamping
   (frontend/src/lib/sync-merge.js), and push it conditional on the revision it read. When the
   app wrote in between, the server answers 409 with its current document; that is merged with
   ours exactly as the app merges on a 409 (useStore.js mergeInto/doPush) and pushed again.

   The token comes from OPENGYM_TOKEN (the raw token), OPENGYM_TOKEN_FILE (a path), or the file
   `npm run pair` writes: ~/.config/opengym-mcp/<host_port>.json. It is read lazily and cached
   for the life of the process. No network happens until the first fetchState, commit or whoami. */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { stampChange, mergeStates } from '../../frontend/src/lib/sync-merge.js'

// Device-local or server-only fields the app never pushes: the running workout stays on the
// device, and the server's notes about an older app's push are read back only by the server.
const LOCAL_ONLY = ['active', '_unstamped', '_prior']

function fail(code, message) {
  const e = new Error(message)
  e.code = code
  return e
}

export function baseUrl() {
  return (process.env.OPENGYM_URL || 'http://localhost:8080').trim().replace(/\/+$/, '')
}

// One token file per instance, so pairing with a second server does not clobber the first.
// The key is the URL's host and port with anything unusual in a filename turned into `_`.
export function defaultTokenPath(url = baseUrl()) {
  let key
  try {
    const u = new URL(url)
    key = u.host || u.hostname
    if (!u.port) key += '_' + (u.protocol === 'https:' ? '443' : '80')
  } catch {
    key = String(url)
  }
  key = key.replace(/[^A-Za-z0-9.-]/g, '_')
  return path.join(os.homedir(), '.config', 'opengym-mcp', key + '.json')
}

// Writes the token record readable by its owner only, creating the directory as needed.
export function saveToken(file, record) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  fs.writeFileSync(file, JSON.stringify(record, null, 2) + '\n', { mode: 0o600 })
  // writeFileSync only applies the mode when it creates the file; a re-pair tightens it too.
  fs.chmodSync(file, 0o600)
}

function readTokenFile(file) {
  let raw
  try { raw = fs.readFileSync(file, 'utf8') } catch { return null }
  try {
    const rec = JSON.parse(raw)
    return rec && typeof rec.token === 'string' && rec.token ? rec : null
  } catch {
    return null
  }
}

// undefined = not looked up yet; null = looked up, nothing there.
let _auth = undefined

function loadAuth() {
  if (_auth !== undefined) return _auth
  const envToken = (process.env.OPENGYM_TOKEN || '').trim()
  if (envToken) return (_auth = { token: envToken, file: null, label: 'OPENGYM_TOKEN env' })
  const envFile = (process.env.OPENGYM_TOKEN_FILE || '').trim()
  const file = envFile || defaultTokenPath()
  const rec = readTokenFile(file)
  if (!rec) return (_auth = null)
  const home = os.homedir()
  const label = !envFile && file.startsWith(home + path.sep) ? '~' + file.slice(home.length) : file
  return (_auth = { token: rec.token, file, record: rec, label })
}

export function hasToken() { return !!loadAuth() }

export function tokenSource() { return loadAuth()?.label || null }

function needToken() {
  const a = loadAuth()
  if (!a) throw fail('ENOTOKEN', 'No openGym token. In the app open Settings → Pair the mobile app, then run: cd mcp && npm run pair -- <CODE>')
  return a
}

// One request to the api. Resolves { status, body } for any HTTP answer (body is the parsed
// JSON, or {} when there is none); rejects with ECONN only when the server cannot be reached.
// `token` and `url` default to this process's own; pair.mjs passes them explicitly.
export async function apiFetch(p, { method = 'GET', body, token, url = baseUrl() } = {}) {
  const headers = { Accept: 'application/json' }
  if (token) headers.Authorization = 'Bearer ' + token
  if (body !== undefined) headers['Content-Type'] = 'application/json'
  let res
  try {
    res = await fetch(url + p, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) })
  } catch (e) {
    throw fail('ECONN', `cannot reach ${url}; is the instance running? (${e.cause?.code || e.message})`)
  }
  const raw = await res.text()
  let parsed = {}
  if (raw) {
    try { parsed = JSON.parse(raw) } catch { parsed = { error: raw.slice(0, 200) } }
  }
  return { status: res.status, body: parsed }
}

// An authenticated request; 401 and 403 become EAUTH, any other status is returned as is.
async function authed(p, init = {}) {
  const a = needToken()
  const r = await apiFetch(p, { ...init, token: a.token })
  if (r.status === 401 || r.status === 403) throw fail('EAUTH', 'Token expired or revoked; pair again.')
  return r
}

function httpError(what, r) {
  const msg = r.body && typeof r.body.error === 'string' ? r.body.error : 'no detail'
  const e = fail('EHTTP', `${what} failed: HTTP ${r.status} (${msg})`)
  e.status = r.status
  return e
}

// The first request of the process asks who the token belongs to. The api hands back a fresh
// token once the current one is past half its life; when ours came from a file, the file is
// rewritten so the pairing never quietly runs out. An env token cannot be updated in place, so
// the fresh one is used for this process only.
let _session = null

function ensureSession() {
  if (!_session) {
    _session = (async () => {
      const r = await authed('/api/me')
      if (r.status !== 200) throw httpError('GET /api/me', r)
      const user = r.body.user || {}
      const fresh = typeof r.body.token === 'string' && r.body.token ? r.body.token : null
      if (fresh && _auth) {
        _auth.token = fresh
        if (_auth.file) {
          const record = { ...(_auth.record || {}), token: fresh }
          saveToken(_auth.file, record)
          _auth.record = record
        }
      }
      return { id: user.id, name: user.name }
    })()
    // A failure is not remembered: the next call asks again (the instance may be back up).
    _session.catch(() => { _session = null })
  }
  return _session
}

export async function whoami() { return ensureSession() }

export async function fetchState() {
  await ensureSession()
  const r = await authed('/api/data')
  if (r.status !== 200) throw httpError('GET /api/data', r)
  const state = r.body.state ?? null
  return { state, rev: r.body.rev ?? state?._rev ?? 0, wid: state?._wid ?? null }
}

// The revision alone, cheap on the server: remote mode asks this before every tool call and
// fetches the document only when it moved.
export async function fetchRev() {
  await ensureSession()
  const r = await authed('/api/data/rev')
  if (r.status !== 200) throw httpError('GET /api/data/rev', r)
  return { rev: r.body.rev ?? 0, wid: r.body.wid ?? null }
}

async function put(state, baseRev, baseWid) {
  const body = { state, baseRev, stamped: true }
  if (typeof baseWid === 'string' && baseWid) body.baseWid = baseWid
  return authed('/api/data', { method: 'PUT', body })
}

/**
 * Applies `apply` to a copy of the current document and saves it. `apply(next)` mutates `next`
 * and returns `{ state?, result }`; an error it throws (with its own `.code`) propagates as is.
 * Resolves `{ rev, result }`. Retries a conflict up to `opts.retries` (default 3) pushes in all.
 */
export async function commit(apply, opts = {}) {
  const retries = Math.max(1, opts.retries ?? 3)
  const { state, rev, wid } = await fetchState()
  // A brand-new account has no document yet; the change starts from an empty one.
  const prev = state && typeof state === 'object' ? state : {}
  for (const k of LOCAL_ONLY) delete prev[k]
  let next = structuredClone(prev)
  const out = apply(next) || {}
  if (out.state && typeof out.state === 'object') next = out.state
  for (const k of LOCAL_ONLY) delete next[k]
  next._ts = stampChange(prev, next)

  let baseRev = rev, baseWid = wid
  for (let attempt = 1; ; attempt++) {
    const r = await put(next, baseRev, baseWid)
    if (r.status === 200) return { rev: r.body.rev, result: out.result }
    if (r.status !== 409) throw httpError('PUT /api/data', r)
    if (attempt >= retries) {
      throw fail('ECONFLICT', `the app kept saving while the coach wrote; try again (${attempt} attempts, server at revision ${r.body.rev})`)
    }
    // As the app does on a 409: our copy first, the server's second. Our change is stamped, so
    // the merge keeps it next to whatever the app saved meanwhile; nothing is re-applied.
    const remote = r.body.state || null
    const merged = mergeStates(next, remote)
    merged._ts = Math.max(Number(merged._ts) || 0, next._ts)
    for (const k of LOCAL_ONLY) delete merged[k]
    next = merged
    baseRev = r.body.rev ?? remote?._rev ?? 0
    baseWid = remote?._wid ?? null
  }
}
