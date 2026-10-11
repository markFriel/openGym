#!/usr/bin/env node
/* openGym MCP server, stdio transport. The LLM client (Claude Code, Claude Desktop, Cursor and
   the like) spawns this process locally, talks JSON-RPC over stdin/stdout, tears it down when the
   session ends. Reads come straight from the data directory, or through the api when this machine
   has none (remote mode); writes go to your own openGym api at OPENGYM_URL with a token you
   paired, the way a second phone would. No extra container, and nothing leaves your box. */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { TOOLS } from './tools.js'
import { READ_HELPER_TOOLS, WRITE_TOOLS } from './write-tools.js'
import { init, getUser, mode, refresh } from './state.js'
import { hasToken, tokenSource, baseUrl } from './client.js'

const server = new McpServer({
  name: 'opengym',
  version: '0.1.0'
})

// Fail fast on bad config so a misnamed OPENGYM_DATA doesn't silently answer every call with
// the no-state sentinel. Always register every tool so the LLM sees the full list at
// handshake, even when state didn't resolve.
try {
  init()
  if (mode() === 'remote') {
    // One fetch now, so the startup line can name the profile. A failure here only logs: every
    // tool call refreshes again and reports the error itself.
    try { await refresh() } catch (e) { console.error(`[opengym-mcp] ${e.code ? e.code + ': ' : ''}${e.message}`) }
    const u = getUser()
    console.error(`[opengym-mcp] serving profile ${u.name} (${u.id}) through ${baseUrl()}`)
  } else {
    const u = getUser()
    console.error(`[opengym-mcp] serving profile ${u.name} (${u.id})`)
  }
  // Writes go through the api with a paired token (client.js); reads come from the data
  // directory or the api. Say which mode this is so a coach whose writes fail knows why at once.
  if (hasToken()) console.error(`[opengym-mcp] read+write, token from ${tokenSource()}`)
  else console.error('[opengym-mcp] read-only: no token. Settings → Pair the mobile app, then `npm run pair -- <CODE>` in mcp/ to enable the write tools')
} catch (e) {
  console.error(`[opengym-mcp] ${e.message}`)
  // Don't exit — keep the tool listings up so the user sees a useful error after fixing their
  // env and restarting.
}

for (const t of [...TOOLS, ...READ_HELPER_TOOLS, ...WRITE_TOOLS]) {
  server.tool(
    t.name,
    t.description,
    t.schema,
    async (params) => {
      try {
        // Remote mode brings the document up to date first; a no-op in file mode.
        await refresh()
        const result = await t.handler(params || {})   // write handlers are async
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] }
      } catch (err) {
        const code = err.code || 'ERROR'
        return {
          isError: true,
          content: [{ type: 'text', text: `${code}: ${err.message}` }]
        }
      }
    }
  )
}

const transport = new StdioServerTransport()
await server.connect(transport)
// Process stays alive serving JSON-RPC over stdio until the LLM client disconnects.
