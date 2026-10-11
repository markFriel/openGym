// The Streamable HTTP transport (src/http.js) driven by the SDK's own client, over a fake openGym
// api in remote mode: both auth forms, the refusals, health, and a write that reaches the api.
import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest'
import http from 'node:http'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

const SECRET = 'a-long-shared-secret'

// A fake api: one profile, one routine, counts its PUTs.
function fakeApi() {
  const calls = []
  let state = { _rev: 3, _wid: 'w3', routines: [{ id: 'r1', name: 'Push Day', emoji: 'barbell', ex: [{ id: '0025', sets: 3, reps: 8, weight: 60 }] }], workouts: [], week: {} }
  const srv = http.createServer((req, res) => {
    calls.push(`${req.method} ${req.url}`)
    const out = (status, body) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)) }
    if (req.headers.authorization !== 'Bearer tok') return out(401, { error: 'not signed in' })
    if (req.url === '/api/me') return out(200, { user: { id: 'u1', name: 'Alex' } })
    if (req.url === '/api/data/rev') return out(200, { rev: state._rev, wid: state._wid })
    if (req.url === '/api/data' && req.method === 'GET') return out(200, { state, rev: state._rev })
    if (req.url === '/api/data' && req.method === 'PUT') {
      let raw = ''
      req.on('data', d => { raw += d })
      req.on('end', () => {
        const body = JSON.parse(raw)
        state = { ...body.state, _rev: state._rev + 1, _wid: 'w' + (state._rev + 1) }
        out(200, { ok: true, rev: state._rev, wid: state._wid })
      })
      return
    }
    out(404, { error: 'no' })
  })
  return new Promise(resolve => srv.listen(0, '127.0.0.1', () => resolve({ srv, url: `http://127.0.0.1:${srv.address().port}`, calls, state: () => state })))
}

async function connect(url, { bearer } = {}) {
  const client = new Client({ name: 'test', version: '0' })
  const opts = bearer ? { requestInit: { headers: { Authorization: 'Bearer ' + bearer } } } : {}
  await client.connect(new StreamableHTTPClientTransport(new URL(url), opts))
  return client
}

describe('http transport', () => {
  let api, started, startHttp

  beforeEach(async () => {
    api = await fakeApi()
    vi.resetModules()
    vi.stubEnv('OPENGYM_REMOTE', '1')
    vi.stubEnv('OPENGYM_URL', api.url)
    vi.stubEnv('OPENGYM_TOKEN', 'tok')
    ;({ startHttp } = await import('../src/http.js'))
    started = await startHttp({ port: 0, host: '127.0.0.1', secret: SECRET })
  })

  afterEach(async () => {
    vi.unstubAllEnvs()
    if (started) await started.close()
    await new Promise(r => api.srv.close(r))
  })

  test('the capability URL lists every tool', async () => {
    const c = await connect(`${started.url}/${SECRET}`)
    const names = (await c.listTools()).tools.map(t => t.name)
    expect(names).toHaveLength(21)
    expect(names).toContain('create_routine')
    await c.close()
  })

  test('the bare path with a bearer header works too', async () => {
    const c = await connect(started.url, { bearer: SECRET })
    expect((await c.listTools()).tools.length).toBe(21)
    await c.close()
  })

  test('a read tool answers from the remote document', async () => {
    const c = await connect(`${started.url}/${SECRET}`)
    const r = await c.callTool({ name: 'list_routines', arguments: {} })
    expect(r.isError).toBeFalsy()
    expect(JSON.parse(r.content[0].text).routines.map(x => x.name)).toEqual(['Push Day'])
    expect(api.calls).toContain('GET /api/data')
    await c.close()
  })

  test('a write tool reaches the api with a PUT and the result carries the new revision', async () => {
    const c = await connect(`${started.url}/${SECRET}`)
    const r = await c.callTool({ name: 'assign_weekday', arguments: { weekday: 'mon', routine_ids: ['r1'] } })
    expect(r.isError).toBeFalsy()
    const out = JSON.parse(r.content[0].text)
    expect(out.rev).toBe(4)
    expect(api.calls.filter(x => x === 'PUT /api/data')).toHaveLength(1)
    expect(api.state().week['1']).toEqual(['r1'])
    await c.close()
  })

  test('a wrong secret is 401 in both forms, a wrong path 404', async () => {
    await expect(connect(`${started.url}/nope`)).rejects.toThrow(/unauthorized/)
    await expect(connect(started.url, { bearer: 'nope' })).rejects.toThrow(/unauthorized/)
    await expect(connect(started.url)).rejects.toThrow(/unauthorized/)
    const r = await fetch(`${started.url.replace(/\/mcp$/, '')}/elsewhere`, { method: 'POST' })
    expect(r.status).toBe(404)
    const deep = await fetch(`${started.url}/${SECRET}/more`, { method: 'POST' })
    expect(deep.status).toBe(404)
  })

  test('GET and DELETE on the endpoint are 405 (stateless, nothing to stream or end)', async () => {
    for (const method of ['GET', 'DELETE']) {
      const r = await fetch(`${started.url}/${SECRET}`, { method })
      expect(r.status).toBe(405)
      expect((await r.json()).error.code).toBe(-32000)
    }
  })

  test('health needs no secret and reports remote mode with a writable token', async () => {
    const r = await fetch(`${started.url}/health`)
    expect(r.status).toBe(200)
    expect(await r.json()).toEqual({ ok: true, mode: 'remote', profile: expect.any(String), writable: true })
  })

  test('starting without a secret is refused unless insecure is set', async () => {
    await expect(startHttp({ port: 0, host: '127.0.0.1' })).rejects.toMatchObject({ code: 'EINVAL' })
    const open = await startHttp({ port: 0, host: '127.0.0.1', insecure: true })
    const c = await connect(open.url)
    expect((await c.listTools()).tools.length).toBe(21)
    await c.close()
    await open.close()
  })
})
