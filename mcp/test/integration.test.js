// The write path against the real api: api/server.js booted on a temp data directory, a session
// token signed with that directory's secret (test only; the MCP itself never reads the secret),
// and client.js committing through PUT /api/data. Pins what the fake-server tests cannot: the
// server's own stamping, revision chain and 409 answer accept what the client sends, and a
// change the app saved between the client's read and its push survives next to the coach's.
// Skips when api/node_modules is missing (the mcp CI job installs only mcp/).
import { describe, test, expect, beforeAll, afterAll, vi } from 'vitest'
import { spawn, spawnSync } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const apiDir = path.resolve(here, '../../api')
const haveApi = fs.existsSync(path.join(apiDir, 'node_modules'))

const UID = 'alex'

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer()
    srv.listen(0, '127.0.0.1', () => { const { port } = srv.address(); srv.close(() => resolve(port)) })
    srv.on('error', reject)
  })
}

async function waitFor(url, ms = 15000) {
  const until = Date.now() + ms
  while (Date.now() < until) {
    try { const r = await fetch(url); if (r.ok) return } catch { /* not up yet */ }
    await new Promise(r => setTimeout(r, 100))
  }
  throw new Error(`api did not answer at ${url}`)
}

// A PUT made by "the app" from a second process, so it can run inside a synchronous apply()
// (between the client's GET and its PUT) without fetch being awaited in the middle.
function appWrites(url, token, body) {
  const script = `
    const r = await fetch(${JSON.stringify(url + '/api/data')}, { method: 'PUT',
      headers: { Authorization: 'Bearer ' + ${JSON.stringify(token)}, 'Content-Type': 'application/json' },
      body: process.argv[1] })
    console.log(r.status)`
  const out = spawnSync(process.execPath, ['--input-type=module', '-e', script, JSON.stringify(body)], { encoding: 'utf8' })
  return Number(out.stdout.trim())
}

describe.skipIf(!haveApi)('client.js against the real api', () => {
  let child, dir, url, token, client

  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-int-'))
    const secret = crypto.randomBytes(32).toString('hex')
    fs.writeFileSync(path.join(dir, 'secret'), secret, { mode: 0o600 })
    fs.writeFileSync(path.join(dir, 'db.json'), JSON.stringify({
      users: [{ id: UID, name: 'Alex', created: '2026-01-01' }], creds: [], subs: [], invites: []
    }))
    const port = await freePort()
    url = `http://127.0.0.1:${port}`
    child = spawn(process.execPath, ['server.js'], {
      cwd: apiDir, stdio: ['ignore', 'ignore', 'pipe'],
      env: { ...process.env, PORT: String(port), DATA_DIR: dir, ORIGIN: url, RP_ID: '127.0.0.1' }
    })
    let stderr = ''
    child.stderr.on('data', d => { stderr += d })
    try { await waitFor(url + '/api/health') } catch (e) { throw new Error(e.message + '\n' + stderr) }
    // The same shape makeSession() signs: <uid>:<expiry>:<session version>, HMAC-SHA256 base64url.
    const payload = `${UID}:${Date.now() + 86400000}:0`
    token = payload + '.' + crypto.createHmac('sha256', secret).update(payload).digest('base64url')
    vi.resetModules()
    vi.stubEnv('OPENGYM_URL', url)
    vi.stubEnv('OPENGYM_TOKEN', token)
    client = await import('../src/client.js')
  }, 30000)

  afterAll(() => {
    vi.unstubAllEnvs()
    if (child) child.kill()
    if (dir) fs.rmSync(dir, { recursive: true, force: true })
  })

  test('whoami resolves the token owner', async () => {
    expect(await client.whoami()).toEqual({ id: UID, name: 'Alex' })
  })

  test('a first commit creates the document, stamped, at revision 1', async () => {
    const r = await client.commit(S => {
      S.routines = [{ id: 'r1', name: 'Smoke Day', emoji: 'barbell', ex: [{ id: '0025', sets: 3, reps: 5, weight: 60 }] }]
      S.week = { 1: ['r1'] }
      return { result: { made: 'r1' } }
    })
    expect(r).toEqual({ rev: 1, result: { made: 'r1' } })
    const { state, rev, wid } = await client.fetchState()
    expect(rev).toBe(1)
    expect(wid).toMatch(/^[0-9a-f]{16}$/)
    expect(state.routines[0]).toMatchObject({ id: 'r1', name: 'Smoke Day' })
    expect(typeof state.routines[0]._ts).toBe('number')
    expect(typeof state.edited['week.1']).toBe('number')
    expect(fs.existsSync(path.join(dir, `state-${UID}.json`))).toBe(true)
  })

  test('a second commit chains the revision and keeps the previous write id', async () => {
    const { wid: before } = await client.fetchState()
    const r = await client.commit(S => { S.routines[0].ex[0].weight = 65; return { result: null } })
    expect(r.rev).toBe(2)
    const { state } = await client.fetchState()
    expect(state.routines[0].ex[0].weight).toBe(65)
    expect(state.routines[0]._f.ex).toBeGreaterThan(0)
    expect(state._wids).toContain(before)
  })

  test('a 409 from the app saving mid-commit is merged: both changes survive', async () => {
    const { state: seen, rev } = await client.fetchState()
    const r = await client.commit(S => {
      const app = structuredClone(seen)
      const now = Date.now()
      app.routines.push({ id: 'r2', name: 'App Day', emoji: 'barbell', ex: [{ id: '0043', sets: 5, reps: 5, weight: 0 }], _ts: now })
      app.week['3'] = ['r2']
      app.edited = { ...(app.edited || {}), 'week.3': now }
      expect(appWrites(url, token, { state: app, baseRev: rev, baseWid: app._wid, stamped: true })).toBe(200)
      S.routines[0].name = 'Smoke Day (coach)'
      S.routines[0].ex.push({ id: '0047', sets: 3, reps: 8, weight: 40 })
      return { result: 'merged' }
    })
    expect(r.result).toBe('merged')
    const { state, rev: after } = await client.fetchState()
    expect(after).toBe(rev + 2)
    expect(state.routines.map(x => [x.name, x.ex.length])).toEqual([['Smoke Day (coach)', 2], ['App Day', 1]])
    expect(state.week).toEqual({ 1: ['r1'], 3: ['r2'] })
  })

  test('a thrown apply pushes nothing', async () => {
    const { rev } = await client.fetchState()
    await expect(client.commit(() => { const e = new Error('no'); e.code = 'EINVAL'; throw e })).rejects.toMatchObject({ code: 'EINVAL' })
    expect((await client.fetchState()).rev).toBe(rev)
  })

  test('a bad token is EAUTH', async () => {
    vi.resetModules()
    vi.stubEnv('OPENGYM_TOKEN', token.slice(0, -2) + 'xx')
    const bad = await import('../src/client.js')
    await expect(bad.fetchState()).rejects.toMatchObject({ code: 'EAUTH' })
    vi.stubEnv('OPENGYM_TOKEN', token)
  })
})
