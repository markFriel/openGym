# openGym, write-mcp fork

This fork adds write tools to the MCP server in `mcp/` so Claude Code can act as Mark's coach for
his athletics gym programme. Upstream is DuarteSantos8/openGym; keep changes upstream-shaped
(small commits, tests beside the code, no new runtime dependencies in `mcp/`).

## Running things

- Instance: on the mini PC (`ssh cph-minipc`), in the servarr compose project at
  `~/Documents/projects/servarr` (services `api` and `opengym`, upstream prebuilt v1.4.1 images,
  data in `config/opengym/data`, Caddy in front). Public URL https://opengym.abhaile.dev.
  Upgrading: bump the two image tags in that compose file, `docker compose pull api opengym`,
  `docker compose up -d api opengym`. Back up `config/opengym/data` first.
- MCP: registered in `.mcp.json` in remote mode (stdio, `node mcp/src/index.js`, reads and
  writes through the api at `OPENGYM_URL`). Writes need a token: app → Settings → Pair the
  mobile app → `cd mcp && npm run pair -- <CODE> --url https://opengym.abhaile.dev`.
- Tests: `cd mcp && npx vitest run && node scripts/check-node-loadable.mjs`. The api and
  frontend are unchanged in this fork; their suites are `cd api && npm test`, `cd frontend && npm test`.
- Phone: the same tools run as the `opengym-mcp` container on the mini PC (built from the fork
  clone at `~/Documents/projects/servarr/data/openGym`, Caddy routes `/mcp/*` to it) and are
  reached by claude.ai through Tailscale Funnel at `https://cphnas.tail30add0.ts.net/mcp/<secret>`
  (opengym.abhaile.dev resolves to a tailnet address, so Anthropic's servers cannot use it; the
  Funnel is mounted at the root of port 8086 because `--set-path` strips the prefix). The secret
  is `OPENGYM_MCP_SECRET` in the servarr `.env`. Its token is paired separately:
  `docker compose run --rm opengym-mcp node scripts/pair.mjs <CODE> --url http://api:3000 --token-file /token/opengym.json`.
  Redeploy after a push: `git -C data/openGym pull && docker compose up -d --build opengym-mcp`.
- No instance runs on the laptop; `docker compose up` here would start a separate empty one.

## How the write path works (read before touching mcp/src/client.js)

The only safe writer is `PUT /api/data` (`api/server.js`). `commit()` in `mcp/src/client.js`
reads the document, applies a pure mutation to a clone, stamps it with the frontend's own
`stampChange` (`frontend/src/lib/sync-merge.js`), and pushes with `baseRev`/`baseWid` and
`stamped: true`. A 409 is merged with `mergeStates` and retried. Never write `data/state-*.json`
directly and never read `data/secret`. Read tools keep reading the file; after a commit the api's
atomic rename changes the mtime and `getState()` re-reads.

Every write tool is `apply*(state, params) → { state, result }` in `mcp/src/write-tools.js`,
pure and tested on `demoSeed` without a network; the handler is `commit(S => apply*(S, params))`.

## Coaching protocol (for Claude acting as the coach)

- Before naming a weight, call `preview_session`, not `get_routine`: the routine stores a plan,
  the preview is what the athlete will see after progression and history.
- After any write, read it back (`get_routine`, `get_week_plan`) and tell Mark what changed in
  one or two lines. Weights are in the profile unit (`unit` in every result).
- Session intent goes in `set_day_note` for that date; Mark sees it in the app. Debriefs: read
  the session with `get_workout` (sets, RIR/RPE, notes), discuss, then record the agreed
  takeaways with `annotate_workout` so the history carries them.
- Exercise names rarely match the catalogue exactly. Use `search_exercises` and show the
  candidates; use `create_custom_exercise` for athletics drills the library lacks.
- Do not change `scheduleMode`, the queue or the rotation from the MCP; `assign_weekday` warns
  when the app is in rotation mode.
- Mark decides; propose, then write. One session change per message unless he asks for a
  whole block.
