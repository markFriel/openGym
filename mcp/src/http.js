#!/usr/bin/env node
/* openGym MCP server, Streamable HTTP transport. A long-lived process (a container next to the
   api is the intended home) that a remote MCP client reaches over HTTPS: claude.ai's custom
   connectors, so the phone app can coach, or Claude Code's `--transport http`.

   Stateless, as the SDK documents it: every POST gets its own transport and McpServer, and the
   SDK answers in the same response. Nothing is kept between requests except what state.js
   caches anyway (the profile document, refreshed when the api's revision moves).

   Auth is one shared secret, MCP_SECRET, accepted two ways:
     POST <MCP_PATH>/<secret>                 the capability URL, for clients that cannot set a
                                              header on a plain connector (claude.ai)
     POST <MCP_PATH>  Authorization: Bearer <secret>    for clients that can
   Over TLS the URL form is as strong as the header form; it does end up in proxy access logs
   and in the connector settings, so rotate MCP_SECRET if either leaks. The spec's preferred
   route for remote servers is OAuth; that is not implemented here.

   GET <MCP_PATH>/health needs no secret and reports mode, profile and whether writes work. */
import http from 'node:http'
import crypto from 'node:crypto'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { buildServer, logStartup } from './server.js'
import { getUser, mode } from './state.js'
import { hasToken } from './client.js'

const json = (res, status, body) => {
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(body))
}

// Constant-time comparison; a length mismatch is a mismatch, not an exception.
function sameSecret(given, secret) {
  if (typeof given !== 'string' || !given || !secret) return false
  const a = Buffer.from(given), b = Buffer.from(secret)
  return a.length === b.length && crypto.timingSafeEqual(a, b)
}

// The JSON-RPC error the spec wants for a method the stateless server does not serve: no
// standalone GET stream (nothing is pushed between requests) and no session to DELETE.
const notAllowed = res => {
  res.writeHead(405, { 'Content-Type': 'application/json', Allow: 'POST, OPTIONS' })
  res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed.' }, id: null }))
}

/**
 * Starts the HTTP server. `secret` is required unless `insecure` is set (tests and a box that is
 * not reachable from anywhere else). Resolves { server, url, port, close } once listening.
 */
export async function startHttp({ port = 8086, host = '0.0.0.0', path = '/mcp', secret, insecure = false } = {}) {
  if (!secret && !insecure) {
    const e = new Error('MCP_SECRET is not set. Generate one (openssl rand -hex 32) and pass it, or set MCP_INSECURE=1 on a box nothing else can reach.')
    e.code = 'EINVAL'
    throw e
  }
  const base = path.replace(/\/+$/, '') || '/mcp'
  const healthPath = base + '/health'

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost')
    const p = url.pathname.replace(/\/+$/, '')
    if (req.method === 'OPTIONS') { res.writeHead(204, { Allow: 'POST, OPTIONS' }); return res.end() }

    if (p === healthPath && req.method === 'GET') {
      const u = getUser()
      return json(res, 200, { ok: true, mode: mode(), profile: u.name || null, writable: hasToken() })
    }

    // The MCP endpoint: the bare path with a bearer header, or the path carrying the secret.
    let authed = false
    if (p === base) {
      const h = req.headers.authorization || ''
      authed = insecure || (h.startsWith('Bearer ') && sameSecret(h.slice(7).trim(), secret))
      if (!authed) return json(res, 401, { error: 'unauthorized' })
    } else if (p.startsWith(base + '/')) {
      const rest = p.slice(base.length + 1)
      if (rest.includes('/')) return json(res, 404, { error: 'not found' })
      if (!sameSecret(rest, secret)) return json(res, 401, { error: 'unauthorized' })
      authed = true
    } else {
      return json(res, 404, { error: 'not found' })
    }
    if (req.method !== 'POST') return notAllowed(res)

    // One transport and one McpServer per request, torn down when the response is done.
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined })
    const mcp = buildServer()
    res.on('close', () => { transport.close().catch(() => {}); mcp.close().catch(() => {}) })
    try {
      await mcp.connect(transport)
      await transport.handleRequest(req, res)
    } catch (e) {
      console.error(`[opengym-mcp] request failed: ${e.message}`)
      if (!res.headersSent) json(res, 500, { jsonrpc: '2.0', error: { code: -32603, message: 'Internal server error' }, id: null })
    }
  })

  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, host, () => { server.off('error', reject); resolve() })
  })
  const actual = server.address().port
  const shownHost = host === '0.0.0.0' || host === '::' ? '127.0.0.1' : host
  return {
    server,
    port: actual,
    url: `http://${shownHost}:${actual}${base}`,
    close: () => new Promise(resolve => server.close(() => resolve()))
  }
}

// Run as the bin: configuration from the environment, stop cleanly on a container's SIGTERM.
if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const secret = (process.env.MCP_SECRET || '').trim()
  const path = (process.env.MCP_PATH || '/mcp').trim()
  let started
  try {
    await logStartup()
    started = await startHttp({
      port: Number(process.env.MCP_PORT) || 8086,
      host: process.env.MCP_HOST || '0.0.0.0',
      path,
      secret,
      insecure: process.env.MCP_INSECURE === '1'
    })
  } catch (e) {
    console.error(`[opengym-mcp] ${e.message}`)
    process.exit(1)
  }
  const shown = secret ? `${started.url}/<secret>` : started.url
  console.error(`[opengym-mcp] http on ${started.url}  connector URL: ${shown}  health: ${started.url}/health`)
  const stop = sig => { console.error(`[opengym-mcp] ${sig}, stopping`); started.close().then(() => process.exit(0)) }
  process.on('SIGTERM', () => stop('SIGTERM'))
  process.on('SIGINT', () => stop('SIGINT'))
}
