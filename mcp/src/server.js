/* What both transports share: the McpServer with every tool registered behind one wrapper, and
   the startup lines on stderr. index.js connects it to stdio; http.js builds one per request. */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { TOOLS } from './tools.js'
import { READ_HELPER_TOOLS, WRITE_TOOLS } from './write-tools.js'
import { init, getUser, mode, refresh } from './state.js'
import { hasToken, tokenSource, baseUrl } from './client.js'

export const ALL_TOOLS = [...TOOLS, ...READ_HELPER_TOOLS, ...WRITE_TOOLS]

/** A fresh McpServer with every tool registered. Cheap: registration is a few Map inserts. */
export function buildServer() {
  const server = new McpServer({ name: 'opengym', version: '0.2.0' })
  for (const t of ALL_TOOLS) {
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
  return server
}

/**
 * Resolves the configuration and says on stderr what this process serves. Never throws: a bad
 * OPENGYM_DATA or an unreachable api is logged, and the tools stay registered so the client sees
 * a useful error after the config is fixed and the server restarted.
 */
export async function logStartup() {
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
  }
}
