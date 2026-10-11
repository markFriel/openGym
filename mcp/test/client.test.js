// Tests for mcp/src/client.js and scripts/pair.mjs against a fake api on an ephemeral port.
// client.js caches the token and the session per process, so each case stubs the env and
// imports a fresh copy. Temp dirs only; nothing here touches a real profile or ~/.config.
import { describe, test, expect, afterEach, afterAll, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { execFile } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const MCP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

const servers = []
const dirs = []

// A fake api. `routes` maps 'METHOD /path' to (req, body) => [status, json]. Every request is
// recorded with its auth header and parsed body.
async function fakeApi(routes) {
  const calls = []
  const srv = http.createServer((req, res) => {
    let raw = ''
    req.on('data', c => { raw += c })
    req.on('end', () => {
      const body = raw ? JSON.parse(raw) : undefined
      const key = req.method + ' ' + req.url
      calls.push({ key, auth: req.headers.authorization, body })
      const h = routes[key] || (key === 'GET /api/me' ? () => [200, { user: { id: 'u', name: 'Mark' } }] : null)
      const [status, out] = h ? h(req, body, calls) : [404, { error: 'not found' }]
      res.writeHead(status, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(out))
    })
  })
  await new Promise(r => srv.listen(0, '127.0.0.1', r))
  servers.push(srv)
  return { url: `http://127.0.0.1:${srv.address().port}`, calls }
}

function tmpDir() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-client-'))
  dirs.push(d)
  return d
}

async function load(env) {
  vi.resetModules()
  // Keep a stray real token out of every case: HOME points at a temp dir.
  vi.stubEnv('HOME', tmpDir())
  vi.stubEnv('OPENGYM_TOKEN', '')
  vi.stubEnv('OPENGYM_TOKEN_FILE', '')
  for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v)
  return import('../src/client.js')
}

async function codeOf(p) {
  try { await p } catch (e) { return e.code }
  return 'resolved'
}

const puts = calls => calls.filter(c => c.key === 'PUT /api/data')

afterEach(async () => {
  vi.unstubAllEnvs()
  await Promise.all(servers.splice(0).map(s => new Promise(r => { s.closeAllConnections?.(); s.close(r) })))
})
afterAll(() => { dirs.forEach(d => fs.rmSync(d, { recursive: true, force: true })) })

const addRoutine = (id, name) => s => { s.routines.push({ id, name, items: [] }); return { result: { id } } }

describe('commit', () => {
  test('stamps the change and pushes it over the revision it read', async () => {
    const api = await fakeApi({
      'GET /api/data': () => [200, { state: { _rev: 3, _wid: 'abc', routines: [], workouts: [], active: { x: 1 } }, rev: 3 }],
      'PUT /api/data': () => [200, { ok: true, ts: 1, rev: 4, wid: 'w4' }]
    })
    const c = await load({ OPENGYM_URL: api.url + '/', OPENGYM_TOKEN: 't1' })
    const out = await c.commit(addRoutine('r1', 'Push'))
    expect(out).toEqual({ rev: 4, result: { id: 'r1' } })
    const [put] = puts(api.calls)
    expect(put.auth).toBe('Bearer t1')
    expect(put.body.baseRev).toBe(3)
    expect(put.body.baseWid).toBe('abc')
    expect(put.body.stamped).toBe(true)
    expect(put.body.state.active).toBeUndefined()
    expect(typeof put.body.state._ts).toBe('number')
    const r = put.body.state.routines.find(x => x.id === 'r1')
    expect(r.name).toBe('Push')
    expect(typeof r._ts).toBe('number')
  })

  test('a 409 merges the server copy and pushes again over its revision', async () => {
    let n = 0
    const remote = { _rev: 4, _wid: 'def', _ts: 1, routines: [{ id: 'app', name: 'From app', items: [], _ts: 1 }], workouts: [] }
    const api = await fakeApi({
      'GET /api/data': () => [200, { state: { _rev: 3, _wid: 'abc', routines: [], workouts: [] }, rev: 3 }],
      'PUT /api/data': () => (++n === 1 ? [409, { error: 'conflict', rev: 4, state: remote }] : [200, { ok: true, rev: 5, wid: 'w5' }])
    })
    const c = await load({ OPENGYM_URL: api.url, OPENGYM_TOKEN: 't1' })
    const out = await c.commit(addRoutine('coach', 'From coach'))
    expect(out.rev).toBe(5)
    const [, second] = puts(api.calls)
    expect(second.body.baseRev).toBe(4)
    expect(second.body.baseWid).toBe('def')
    expect(second.body.state.routines.map(r => r.id).sort()).toEqual(['app', 'coach'])
    expect(second.body.state.active).toBeUndefined()
  })

  test('conflicts every time give up with ECONFLICT', async () => {
    const api = await fakeApi({
      'GET /api/data': () => [200, { state: { _rev: 3, _wid: 'abc', routines: [], workouts: [] }, rev: 3 }],
      'PUT /api/data': () => [409, { error: 'conflict', rev: 9, state: { _rev: 9, _wid: 'z', routines: [], workouts: [] } }]
    })
    const c = await load({ OPENGYM_URL: api.url, OPENGYM_TOKEN: 't1' })
    let err
    try { await c.commit(addRoutine('r1', 'Push')) } catch (e) { err = e }
    expect(err.code).toBe('ECONFLICT')
    expect(err.message).toMatch(/kept saving/)
    expect(puts(api.calls)).toHaveLength(3)
  })

  test('an error apply throws propagates unchanged and nothing is pushed', async () => {
    const api = await fakeApi({
      'GET /api/data': () => [200, { state: { _rev: 3, routines: [], workouts: [] }, rev: 3 }]
    })
    const c = await load({ OPENGYM_URL: api.url, OPENGYM_TOKEN: 't1' })
    const boom = Object.assign(new Error('no such routine'), { code: 'ENOENT' })
    await expect(c.commit(() => { throw boom })).rejects.toBe(boom)
    expect(puts(api.calls)).toHaveLength(0)
  })
})

describe('errors', () => {
  test('401 is EAUTH', async () => {
    const api = await fakeApi({ 'GET /api/me': () => [401, { error: 'not signed in' }] })
    const c = await load({ OPENGYM_URL: api.url, OPENGYM_TOKEN: 't1' })
    expect(await codeOf(c.fetchState())).toBe('EAUTH')
  })

  test('no token anywhere is ENOTOKEN, with the way to pair', async () => {
    const c = await load({ OPENGYM_URL: 'http://127.0.0.1:1' })
    expect(c.hasToken()).toBe(false)
    expect(c.tokenSource()).toBeNull()
    let err
    try { await c.fetchState() } catch (e) { err = e }
    expect(err.code).toBe('ENOTOKEN')
    expect(err.message).toMatch(/npm run pair/)
  })

  test('a closed port is ECONN naming the url', async () => {
    const api = await fakeApi({})
    await new Promise(r => servers.pop().close(r))
    const c = await load({ OPENGYM_URL: api.url, OPENGYM_TOKEN: 't1' })
    let err
    try { await c.fetchState() } catch (e) { err = e }
    expect(err.code).toBe('ECONN')
    expect(err.message).toContain(api.url)
  })

  test('a 500 is EHTTP with the status and the api error', async () => {
    const api = await fakeApi({ 'GET /api/data': () => [500, { error: 'boom' }] })
    const c = await load({ OPENGYM_URL: api.url, OPENGYM_TOKEN: 't1' })
    let err
    try { await c.fetchState() } catch (e) { err = e }
    expect(err.code).toBe('EHTTP')
    expect(err.message).toMatch(/500/)
    expect(err.message).toMatch(/boom/)
  })
})

describe('token source and renewal', () => {
  test('default path is per host and port', async () => {
    const c = await load({})
    expect(path.basename(c.defaultTokenPath('http://localhost:8080/'))).toBe('localhost_8080.json')
    expect(c.defaultTokenPath('http://localhost:8080')).toBe(path.join(os.homedir(), '.config', 'opengym-mcp', 'localhost_8080.json'))
  })

  test('a renewed token is written back to the token file and used from then on', async () => {
    const api = await fakeApi({
      'GET /api/me': () => [200, { user: { id: 'u', name: 'Mark' }, token: 't2' }],
      'GET /api/data': () => [200, { state: { _rev: 1, routines: [], workouts: [] }, rev: 1 }]
    })
    const file = path.join(tmpDir(), 'tok.json')
    fs.writeFileSync(file, JSON.stringify({ url: api.url, token: 't1', uid: 'u', name: 'Mark', pairedAt: 'x' }))
    const c = await load({ OPENGYM_URL: api.url, OPENGYM_TOKEN_FILE: file })
    expect(c.hasToken()).toBe(true)
    expect(c.tokenSource()).toBe(file)
    await c.fetchState()
    await c.fetchState()
    expect(api.calls.filter(x => x.key === 'GET /api/me')).toHaveLength(1)
    expect(api.calls[0].auth).toBe('Bearer t1')
    expect(api.calls.slice(1).every(x => x.auth === 'Bearer t2')).toBe(true)
    const rec = JSON.parse(fs.readFileSync(file, 'utf8'))
    expect(rec.token).toBe('t2')
    expect(rec.name).toBe('Mark')
    expect(fs.statSync(file).mode & 0o777).toBe(0o600)
    expect(await c.whoami()).toEqual({ id: 'u', name: 'Mark' })
  })

  test('with OPENGYM_TOKEN the renewed token is used but no file is written', async () => {
    const api = await fakeApi({
      'GET /api/me': () => [200, { user: { id: 'u', name: 'Mark' }, token: 't2' }],
      'GET /api/data': () => [200, { state: null, rev: 0 }]
    })
    const c = await load({ OPENGYM_URL: api.url, OPENGYM_TOKEN: 't1' })
    expect(c.tokenSource()).toBe('OPENGYM_TOKEN env')
    await c.fetchState()
    expect(api.calls[1].auth).toBe('Bearer t2')
    expect(fs.existsSync(path.dirname(c.defaultTokenPath(api.url)))).toBe(false)
  })
})

describe('pair.mjs', () => {
  const run = (args, env = {}) => new Promise(resolve => {
    execFile(process.execPath, ['scripts/pair.mjs', ...args], { cwd: MCP_DIR, env: { ...process.env, OPENGYM_URL: '', OPENGYM_TOKEN_FILE: '', HOME: tmpDir(), ...env } },
      (err, stdout, stderr) => resolve({ code: err ? err.code : 0, stdout, stderr }))
  })

  test('redeems the code, saves the token and confirms it', async () => {
    const api = await fakeApi({
      'POST /api/pair/redeem': (req, body) => body.code === 'ABC123'
        ? [200, { token: 'tok', user: { id: 'u1', name: 'Mark', admin: false } }]
        : [400, { error: 'invalid or expired code', code: 'pair-invalid' }],
      'GET /api/me': req => req.headers.authorization === 'Bearer tok' ? [200, { user: { id: 'u1', name: 'Mark' } }] : [401, { error: 'not signed in' }]
    })
    const file = path.join(tmpDir(), 'sub', 'tok.json')
    const r = await run([' ABC123 ', '--url', api.url, '--token-file', file])
    expect(r.code).toBe(0)
    expect(r.stdout.trim()).toBe(`Paired with ${api.url} as Mark. Token saved to ${file}.`)
    const rec = JSON.parse(fs.readFileSync(file, 'utf8'))
    expect(rec).toMatchObject({ url: api.url, token: 'tok', uid: 'u1', name: 'Mark' })
    expect(typeof rec.pairedAt).toBe('string')
    expect(fs.statSync(file).mode & 0o777).toBe(0o600)
  })

  test('an invalid code exits 1 with a readable message', async () => {
    const api = await fakeApi({
      'POST /api/pair/redeem': () => [400, { error: 'invalid or expired code', code: 'pair-invalid' }]
    })
    const file = path.join(tmpDir(), 'tok.json')
    const r = await run(['NOPE', '--url', api.url, '--token-file', file])
    expect(r.code).toBe(1)
    expect(r.stderr).toMatch(/invalid or has expired/)
    expect(fs.existsSync(file)).toBe(false)
  })
})
