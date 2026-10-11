#!/usr/bin/env node
/* openGym MCP server, stdio transport. The LLM client (Claude Code, Claude Desktop, Cursor and
   the like) spawns this process locally, talks JSON-RPC over stdin/stdout, tears it down when the
   session ends. Reads come straight from the data directory, or through the api when this machine
   has none (remote mode); writes go to your own openGym api at OPENGYM_URL with a token you
   paired, the way a second phone would. No extra container, and nothing leaves your box.
   For a long-lived server the phone can reach (a claude.ai connector), see http.js. */
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { buildServer, logStartup } from './server.js'

await logStartup()
const server = buildServer()
await server.connect(new StdioServerTransport())
// Process stays alive serving JSON-RPC over stdio until the LLM client disconnects.
