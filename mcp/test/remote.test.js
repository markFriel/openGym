// Tests for remote mode in mcp/src/state.js: reads through the api when this machine has no data
// directory. A fake api on an ephemeral port, as in client.test.js; state.js and client.js cache
// per process, so each case stubs the env and imports fresh copies. Nothing here touches a real
// profile or ~/.config.
import { describe, test, expect, afterEach, afterAll, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'

const servers = []
const dirs = []

// A fake api. `routes` maps 'METHOD /path' to (req, body, calls) => [status, json]; /api/me
// answers a default user unless a route overrides it. Every request is recorded.
async function fakeApi(routes) {
  const calls = []
  const srv = http.createServer((req, res) => {
    let raw = ''
    req.on('data', c => { raw += c })
    req.on('end', () => {
      const body = raw ? JSON.parse(raw) : undefined
      const key = req.method + ' ' + req.url
      calls.push({ key, auth: req.headers.authorization, body })
      const h = routes[key] || (key === 'GET /api/me' ? () => [200, { user: { id: 'u1', name: 'Mark' } }] : null)
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
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-remote-'))
  dirs.push(d)
  return d
}

// Fresh state.js (and the client.js it imports) in forced remote mode against `url`.
async function load(url, extra = {}) {
  vi.resetModules()
  vi.stubEnv('HOME', tmpDir())
  vi.stubEnv('OPENGYM_TOKEN_FILE', '')
  vi.stubEnv('OPENGYM_DATA', '')
  vi.stubEnv('OPENGYM_UID', '')
  vi.stubEnv('OPENGYM_REMOTE', '1')
  vi.stubEnv('OPENGYM_URL', url)
  vi.stubEnv('OPENGYM_TOKEN', 't1')
  for (const [k, v] of Object.entries(extra)) vi.stubEnv(k, v)
  return import('../src/state.js')
}

// A server whose document and revision the test can move.
async function movingApi(doc) {
  const box = { doc }
  const api = await fakeApi({
    'GET /api/data/rev': () => [200, { rev: box.doc?._rev || 0, ...(box.doc?._wid ? { wid: box.doc._wid } : {}) }],
    'GET /api/data': () => [200, { state: box.doc, rev: box.doc?._rev || 0 }]
  })
  return { ...api, box }
}

const count = (calls, key) => calls.filter(c => c.key === key).length

afterEach(async () => {
  vi.unstubAllEnvs()
  await Promise.all(servers.splice(0).map(s => new Promise(r => { s.closeAllConnections?.(); s.close(r) })))
})
afterAll(() => { dirs.forEach(d => fs.rmSync(d, { recursive: true, force: true })) })

describe('remote mode', () => {
  test('the first refresh asks who, the revision, and the document', async () => {
    const api = await movingApi({ _rev: 3, _wid: 'w3', unit: 'lb' })
    const s = await load(api.url)
    expect(s.mode()).toBe('remote')
    await s.refresh()
    expect(api.calls.map(c => c.key)).toEqual(['GET /api/me', 'GET /api/data/rev', 'GET /api/data'])
    expect(api.calls.every(c => c.auth === 'Bearer t1')).toBe(true)
  })

  test('an unchanged revision makes no second document fetch; a moved one does', async () => {
    const api = await movingApi({ _rev: 3, _wid: 'w3', unit: 'lb' })
    const s = await load(api.url)
    await s.refresh()
    await s.refresh()
    expect(count(api.calls, 'GET /api/data/rev')).toBe(2)
    expect(count(api.calls, 'GET /api/data')).toBe(1)
    expect(count(api.calls, 'GET /api/me')).toBe(1)

    api.box.doc = { _rev: 4, _wid: 'w4', unit: 'kg' }
    await s.refresh()
    expect(count(api.calls, 'GET /api/data')).toBe(2)
    expect(s.getState().unit).toBe('kg')
  })

  test('a new writer at the same revision number refetches too', async () => {
    const api = await movingApi({ _rev: 3, _wid: 'w3', unit: 'lb' })
    const s = await load(api.url)
    await s.refresh()
    api.box.doc = { _rev: 3, _wid: 'other', unit: 'kg' }
    await s.refresh()
    expect(count(api.calls, 'GET /api/data')).toBe(2)
    expect(s.getState().unit).toBe('kg')
  })

  test('getState() is the server document with the app defaults merged in', async () => {
    const api = await movingApi({ _rev: 1, unit: 'lb', workouts: [{ id: 'w1' }] })
    const s = await load(api.url)
    expect(s.getState()).toBeNull()   // nothing before the first refresh
    await s.refresh()
    const S = s.getState()
    expect(S.unit).toBe('lb')
    expect(S.workouts).toEqual([{ id: 'w1' }])
    expect(S.routines).toEqual([])
    expect(S.dayPlan).toEqual({})
  })

  test('getUser() is the token\'s user', async () => {
    const api = await movingApi({ _rev: 1 })
    const s = await load(api.url)
    expect(s.getUser()).toEqual({ id: null, name: 'Profile', created: null })
    await s.refresh()
    expect(s.getUser()).toEqual({ id: 'u1', name: 'Mark', created: null })
  })

  test('OPENGYM_UID is ignored: the token names the profile', async () => {
    const api = await movingApi({ _rev: 1 })
    const s = await load(api.url, { OPENGYM_UID: 'someone-else' })
    await s.refresh()
    expect(s.getUser().id).toBe('u1')
  })

  test('a null server state is a profile that never synced', async () => {
    const api = await movingApi(null)
    const s = await load(api.url)
    await s.refresh()
    expect(s.getState()).toBeNull()
  })

  test('a 401 surfaces as EAUTH from refresh()', async () => {
    const api = await fakeApi({ 'GET /api/me': () => [401, { error: 'not signed in' }] })
    const s = await load(api.url)
    await expect(s.refresh()).rejects.toMatchObject({ code: 'EAUTH' })
  })

  test('a 401 on the revision surfaces as EAUTH too', async () => {
    const api = await fakeApi({ 'GET /api/data/rev': () => [401, { error: 'not signed in' }] })
    const s = await load(api.url)
    await expect(s.refresh()).rejects.toMatchObject({ code: 'EAUTH' })
  })

  test('no instance at the URL surfaces as ECONN', async () => {
    const s = await load('http://127.0.0.1:1')
    await expect(s.refresh()).rejects.toMatchObject({ code: 'ECONN' })
  })

  test('a read tool answers from the remote document', async () => {
    const api = await movingApi({ _rev: 2, unit: 'lb', routines: [{ id: 'r1', name: 'Push', ex: [{ id: 'bench' }] }] })
    const s = await load(api.url)
    const { listRoutines } = await import('../src/tools.js')
    await s.refresh()
    const out = listRoutines.handler({})
    expect(out.unit).toBe('lb')
    expect(out.routines.map(r => [r.id, r.name, r.exercise_count])).toEqual([['r1', 'Push', 1]])
  })
})
