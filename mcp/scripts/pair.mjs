#!/usr/bin/env node
/* Pairs this MCP server with an openGym instance, the way the mobile app pairs.
 *
 *   node scripts/pair.mjs <CODE> [--url http://localhost:8080] [--token-file path]
 *
 * In the app, Settings → Pair the mobile app shows a short code. This redeems it for a bearer
 * token (POST /api/pair/redeem), saves the token readable by you only, and confirms it works
 * (GET /api/me). The MCP server then reads it from the same file on start.
 */
import { apiFetch, defaultTokenPath, saveToken } from '../src/client.js'

function usage(msg) {
  if (msg) console.error(msg)
  console.error('usage: node scripts/pair.mjs <CODE> [--url http://localhost:8080] [--token-file path]')
  process.exit(1)
}

const args = process.argv.slice(2)
let code = null
let url = process.env.OPENGYM_URL || 'http://localhost:8080'
let file = null
for (let i = 0; i < args.length; i++) {
  const a = args[i]
  if (a === '--url') url = args[++i]
  else if (a.startsWith('--url=')) url = a.slice(6)
  else if (a === '--token-file') file = args[++i]
  else if (a.startsWith('--token-file=')) file = a.slice(13)
  else if (a === '-h' || a === '--help') usage()
  else if (a.startsWith('-')) usage(`unknown option ${a}`)
  else if (code == null) code = a
  else usage(`unexpected argument ${a}`)
}
code = (code || '').trim()
if (!code) usage('a pairing code is required')
if (!url) usage('--url needs a value')
if (file === undefined) usage('--token-file needs a value')
url = url.trim().replace(/\/+$/, '')
file = file || process.env.OPENGYM_TOKEN_FILE || defaultTokenPath(url)

async function main() {
  const r = await apiFetch('/api/pair/redeem', { method: 'POST', body: { code }, url })
  if (r.status !== 200 || typeof r.body.token !== 'string') {
    if (r.body.code === 'pair-invalid') throw new Error('That code is invalid or has expired. Make a new one in Settings → Pair the mobile app and run this again.')
    throw new Error(`pairing failed: HTTP ${r.status} (${r.body.error || 'no detail'})`)
  }
  const { token, user = {} } = r.body
  saveToken(file, { url, token, uid: user.id, name: user.name, pairedAt: new Date().toISOString() })
  const me = await apiFetch('/api/me', { token, url })
  if (me.status !== 200) throw new Error(`the token was saved to ${file} but ${url} did not accept it: HTTP ${me.status} (${me.body.error || 'no detail'})`)
  console.log(`Paired with ${url} as ${me.body.user?.name || user.name}. Token saved to ${file}.`)
}

main().catch(e => {
  console.error(e.message)
  process.exit(1)
})
