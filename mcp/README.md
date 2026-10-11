# openGym MCP server

A [Model Context Protocol](https://modelcontextprotocol.io) bridge that lets an external LLM
application (Claude Desktop, Claude Code, Cursor, Cline, Continue, etc.) read and change your
openGym profile: routines, the weekly plan, workouts, day notes, the body-weight log, estimated
1RMs and muscle balance.

It runs locally as a stdio process spawned by the LLM client and adds no new container and no
new dependency. Reads come straight from the `state-<uid>.json` files the openGym api already
writes in your self-hosted `./data` directory. Writes go through the running api, over the same
`PUT /api/data` the app uses, with a token you get by pairing the server the way you pair the
mobile app: to the api the MCP server is just a second device. The LLM never sees passkeys,
VAPID keys or the session secret.

The numbers it answers with are computed by the **same pure functions the React UI uses**
(`frontend/src/lib/*.js`): `estimate1RM`, `loadOfWorkouts`, `effectiveRoutine`, etc. So a
"what's my bench 1RM?" answer matches the Stats screen exactly, and a change it writes is
stamped and merged by the same code the app stamps and merges with.

Without a token it still starts and serves every read tool; the write tools then answer
`ENOTOKEN` with the steps to pair. See **Roadmap** for what it cannot change yet.

## Quick start

### 1. Install

```bash
cd mcp
npm install
```

### 2. Point it at your data

The MCP server reads the same `./data` directory `docker compose up` creates. Pick the profile
to answer for; its user id is in `./data/db.json` under `users[].id`:

```bash
# single-user instance (the common self-hosted case), auto-detected:
node src/index.js

# multi-user instance, or just to be explicit:
OPENGYM_UID=<your-uid> OPENGYM_DATA=/path/to/openGym/data node src/index.js
```

#### Remote mode

The server does not have to run on the machine that holds `./data`. On any machine that can
reach the api (over Tailscale, say), give it only `OPENGYM_URL` and a paired token (step 3) and
no data directory: when neither `OPENGYM_DATA` is set nor `./data` exists, but a token is there,
it reads through the api instead and says so on stderr
(`no data directory here; reading through <url>`). `OPENGYM_REMOTE=1` forces remote mode even
where a data directory exists.

```bash
OPENGYM_URL=https://gym.example.ts.net node src/index.js
```

What it costs: one `GET /api/data/rev` before every tool call, and a full `GET /api/data` only
when the revision moved since the last one. What it cannot do: nothing; reads and writes both
work. `OPENGYM_UID` is ignored, because the token names the profile.

### 3. Pair it for writes

In the app open **Settings → Pair the mobile app**. It shows a short code. Redeem it from `mcp/`:

```bash
npm run pair -- <CODE>
# a different instance than http://localhost:8080:
npm run pair -- <CODE> --url https://gym.example.ts.net
```

`pair` trades the code for a bearer token (`POST /api/pair/redeem`), checks it with
`GET /api/me`, and saves it readable by you only (mode 600) in
`~/.config/opengym-mcp/<host_port>.json`, one file per instance, so pairing with a second server
does not overwrite the first. The server reads it from there on start. The token belongs to the
account that made the code, so pair from the profile the coach should write to; it should be the
same profile `OPENGYM_UID` reads.

| Variable | What it does |
|---|---|
| `OPENGYM_URL` | The api to write to (and to pair with). Defaults to `http://localhost:8080`. Also picks which token file is read. |
| `OPENGYM_TOKEN` | A raw token. Used instead of any file; when the api renews it, the new one lasts only as long as the process. |
| `OPENGYM_TOKEN_FILE` | A token file somewhere other than the default path. `pair` writes there too when it is set (or pass `--token-file`). |

On start the server says on stderr which profile it serves (`serving profile <name> (<id>)`,
with `through <url>` added in remote mode) and whether it can write: `read+write, token from
<source>` or `read-only: no token`. With a data directory nothing goes over the network until
the first write tool runs; in remote mode the server fetches the profile once at start, and a
failure there is only logged, since every tool call tries again and reports the error itself.

### 4. Register with your LLM client

Add the server to your LLM client's MCP config. For Claude Desktop, edit
`claude_desktop_config.json` (macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`):

```jsonc
{
  "mcpServers": {
    "opengym": {
      "command": "node",
      "args": ["/absolute/path/to/openGym/mcp/src/index.js"],
      "env": {
        "OPENGYM_DATA": "/absolute/path/to/openGym/data",
        "OPENGYM_UID": "<your-uid>",          // optional, auto-detected if you have one profile
        "OPENGYM_URL": "http://localhost:8080" // optional, this is the default
      }
    }
  }
}
```

For Claude Code, a `.mcp.json` at the repo root. Claude Code starts the server from the repo root,
so the relative path works and `./data` is found there (without `OPENGYM_DATA` the server looks
for `data/` in the directory it was started from):

```json
{
  "mcpServers": {
    "opengym": {
      "command": "node",
      "args": ["mcp/src/index.js"],
      "env": {
        "OPENGYM_URL": "http://localhost:8080"
      }
    }
  }
}
```

For Cursor and other MCP-compatible clients, see the client's MCP docs: the same `command` +
`args` + `env` shape is what every stdio MCP server expects.

Restart the client; you should see the openGym tools appear with "serving profile \<name\>" and
the read+write or read-only line on the server's stderr.

## Tools

Twenty-one tools: nine read tools, two read helpers for the write tools, and ten write tools.

### Read tools

| Tool | What it answers |
|---|---|
| `list_routines` | What routines are saved in my profile? (names + exercise counts) |
| `get_routine` | What does the Push Day routine prescribe? (sets/reps/weight and rest per exercise) |
| `preview_session` | What will the app actually put on screen when I start this routine, after the progression policy and my history have overridden the plan? |
| `get_week_plan` | What's planned when: the next seven days with their routines and how each was decided (coach week, a pinned session, an override, the weekday plan), the current coach week when one is running, and the weekday table. |
| `list_workouts` | Recent sessions, newest first, with dates, sets done/planned, volume, duration, PRs. |
| `get_workout` | Full set-by-set breakdown of one session, by `workout_id` or by date. On a day with two sessions the date alone returns both ids to pick from rather than guessing at one. |
| `get_bodyweight` | Weigh-ins with the latest weight, the goal line, and deltas vs goal. |
| `estimate_1rm` | All-time best 1RM for an exercise + the trend, or a PR table across all exercises. |
| `muscle_balance` | Which muscles I've trained this week/month/all-time, ranked + which I've neglected. |

`get_routine` and `preview_session` answer two different questions, and confusing them is the
easiest way for a coach to give wrong advice. `get_routine` reports what the routine *stores*.
`preview_session` reports what the athlete will actually *see*: a routine holding "squat 3×8 @
60 kg" opens at 75 kg if the policy progressed or deloaded from that routine's last logged
session. The routine's own weight is the last fallback the session builder consults, not the
first; its reps hold unless a policy that moves reps moved them, or the profile starts planned
sessions from the last session (`starts_from`). Ask `preview_session` before naming a weight.
That holds after a write too: `create_routine` and `edit_routine` set the plan, not the number
the app opens with.

Each tool returns JSON the LLM can format as it likes; structured fields (sets, dates, levels)
are pre-formatted into human-readable labels in `src/labels.js` so the LLM doesn't need to
re-interpret them.

### Read helpers

They read the data file like the read tools, and exist so the write tools can be used well.

| Tool | What it answers |
|---|---|
| `search_exercises` | Which exercise ids match "hip thrust"? Searches the catalogue (about 5,000) and the athlete's custom exercises the way the app's picker does, customs first, with optional `equipment`, `body_part` and `limit` (1 to 50, default 15). On a profile that has never synced it still searches the catalogue, with a `note` that custom exercises are not included. |
| `get_day_notes` | The notes on days, the athlete's own (sick, travel, rest, injured, or a line of text) and the coach's, from `from` to `to`. Defaults to the last 30 days through the next 14. |

### Write tools

Every write tool answers with the revision it saved (`rev`) and what it wrote, built from the
changed document rather than re-read, so the confirmation is exactly what was saved.

| Tool | What it changes, and what the athlete sees in the app |
|---|---|
| `create_routine` | A new routine from `name`, optional `emoji`, `prog` and 1 to 20 `exercises`. It appears on the Plan screen, not yet on any day. Answers with the routine as `get_routine` shows it. |
| `edit_routine` | Up to 25 `ops` on one routine, in order, all or nothing: `rename`, `set_emoji`, `set_policy`, `add_exercise`, `remove_exercise`, `replace_exercise`, `set_targets`, `move_exercise`, `set_superset`, `clear_superset`, `set_note`. The routine changes, and so does the next session started from it; history is untouched. |
| `delete_routine` | The routine is gone from the Plan screen and from every weekday and planned date that named it (listed in the answer). Logged workouts stay. |
| `assign_weekday` | The weekly plan's routines for one weekday (`0` to `6`, 0 = Sunday, or `"mon"`, `"monday"`), 0 to 3 of them; `[]` makes it a rest day. Home and Plan show it on that weekday from now on. |
| `plan_day` | One date planned apart from the weekly plan: a routine, `"rest"`, or `null` to go back to the weekly plan. The app shows the day as rescheduled. |
| `set_day_note` | The note on a date (a `tag` and/or up to 500 characters of `text`), shown in the calendar and week strip. A noted day is excused from the missed-workout nudge. Neither text nor tag clears it. |
| `log_workout` | A session done without the app. It shows in History like any session and counts for volume, records, the muscle map and the next progression step. |
| `annotate_workout` | The note on a logged workout (null removes it), shown on that session in History. |
| `add_bodyweight` | A weigh-in (default today), shown in the body-weight chart. A second one on the same date replaces the first and the old value comes back as `previous`. |
| `create_custom_exercise` | One of the athlete's own exercises, for a drill the catalogue lacks. It shows in the exercise picker and works in routines and logs like any exercise. |

An exercise item in `create_routine`, `add_exercise` and `replace_exercise` takes `exercise` (an
id or exact name) and `sets`, then one way of logging it: `reps` (with optional `reps_min`,
`reps_max`, `sets_max`), `sec` for a timed hold, or `min`/`speed` for cardio. The rest are
optional: `weight`, `rest_sec`, `warmup_sets`, `side`, `superset`, `note`, `prog`, `inc`,
`bodyweight`. `set_targets` takes the same fields, changes only the ones given, and clears one
with `null`. `log_workout` takes `date`, `entries` (each an `exercise` and its `sets`, each set
`reps` + `weight`, `sec` or `min`/`speed`, with optional `rir` or `rpe` and `warmup`) and
optionally `routine_id`, `name`, `start_time`, `duration_min`, `bodyweight` and `note`.

### Rules the write tools enforce

- **An exercise name is never guessed.** An id wins outright. A name is taken only when it
  matches one exercise exactly, or the search finds just one; otherwise the answer is `EAMBIG`
  listing up to eight candidate ids, or `ENOMATCH`. The catalogue has no "back squat"
  ("barbell full squat" is the one) and dozens of near twins. Inside `edit_routine` a name is
  looked up among that routine's own exercises first.
- **Caps are the AI coach's.** The same limits `api/coach/core/validate.js` holds a coach plan
  to: 1 to 10 sets, 1 to 100 reps, 5 to 3600 s, 1 to 180 min, weight up to 1000, increment up
  to 50, rest up to 900 s, warm-up sets up to 5, 1 to 20 exercises per routine, names up to 60
  characters, notes up to 500. Each exercise appears once per routine. Reps on a per-side
  exercise are the total of both sides, so they must be even.
- **One way of logging per exercise.** `sec`, `min`/`speed` and the rep fields do not mix, and a
  field that does not apply (weight on cardio, `sec` on a rep exercise) is refused rather than
  stored where nothing reads it.
- **Supersets are adjacent.** The app links a superset by adjacency, so members must be listed
  next to each other (in `create_routine`) or be next to each other (in `set_superset`); a tag on
  one exercise only is refused. A superset left with one member after an edit is cleared, as the
  app clears it.
- **Dates.** Every date is a real calendar date, `YYYY-MM-DD`. `plan_day` rejects a past date
  (`log_workout` records a past session). `log_workout` and `add_bodyweight` reject a future
  date. `set_day_note` allows a future date on purpose, for session intent the athlete reads
  ahead of time (the app itself only notes days that have come).
- **`log_workout` rebuilds PR badges.** The session is filed in date order, stamped as the app
  stamps a backfilled session, and the PR badges of the exercises it touches are rebuilt: it
  gains the ones it leads with, and a later session it outdoes loses its own.
- **`assign_weekday` warns, it does not switch.** In rotation mode the answer carries a warning
  that Home and Plan show the rotation, not the weekday plan; while a coach week (the queue) is
  running it warns that its next session comes first. The mode, the rotation and the queue are
  never changed from here.
- **Custom exercises speak the app's vocabulary.** `body_part` and `equipment` must be ones the
  app has. `target` and `secondary` are body-map muscles, and a catalogue word like "quads" is
  accepted and stored as the body-map slug, the way the app's own form stores it, so the muscle
  map reads it. A cardio exercise gets the cardiovascular system and no choice. A name already
  in the library is refused with the existing id.
- **Icons are app icon keys.** `emoji` is one of the icon keys in
  `api/coach/core/glyphs.js` (`figureStrength`, `arm`, `abs`, `legs`, `pullup`, `dumbbell`,
  `barbell`, `kettlebell`, `plate`, `machine`, `figureRun`, `bike`, `swim`, `boxing`, `timer`,
  `stretch`, `moon`, `heart`, `flame`, `bolt`), not an emoji character. It defaults to
  `figureStrength`.

### Errors

A failed tool call answers `isError` with `<CODE>: <message>`. The message names the field.

| Code | Meaning | What the coach should do |
|---|---|---|
| `EINVAL` | A value is out of range, the wrong shape, or breaks a rule above. | Fix the named field and call again. Nothing was saved. |
| `ENOENT` | No routine, workout or routine slot with that id or name. | Look it up with `list_routines`, `list_workouts` or `get_routine`. |
| `EAMBIG` | A name matches several exercises (or several slots in the routine). | Pass one of the listed ids (or a `position`), or ask the athlete which one. |
| `ENOMATCH` | No exercise matches, or an id-shaped value is not a real id. | Try `search_exercises` with other words, or `create_custom_exercise`. |
| `ENOTOKEN` | The server is not paired. | Tell the athlete to pair it: Settings → Pair the mobile app, then `npm run pair -- <CODE>`, then restart the client. |
| `EAUTH` | The api refused the token (expired, or revoked by "Sign out everywhere"). | Pair again. |
| `ECONN` | The api cannot be reached at `OPENGYM_URL`. | Check that the instance is running and the URL is right. |
| `ECONFLICT` | The app kept saving while the change was being written, three pushes in a row. | Call again; nothing of this call was saved. |
| `EHTTP` | Any other HTTP failure, with its status and the api's message. | Report it; do not retry blindly. |

## How a write is saved

A write tool does what the app does when it saves:

1. Read the document and its revision from the api (`GET /api/data`).
2. Apply the change to a copy. The apply functions in `src/write-tools.js` are pure: they check
   everything first and throw before anything is pushed, so nothing is half-applied.
3. Stamp the copy with the app's own `stampChange` (`frontend/src/lib/sync-merge.js`).
4. Push it with `PUT /api/data`, conditional on the revision it read (`baseRev`, and `baseWid`
   when there is one) and marked `stamped: true`.
5. If the app saved in between, the api answers 409 with its current document. That is merged
   with ours by `mergeStates`, ours first and the server's second, exactly as the app merges on
   a 409, and pushed again over the new revision. Up to three pushes in all; then `ECONFLICT`.

Around that:

- **The running workout is never touched.** `active` is device-local; the MCP server drops it
  from what it reads and never sends it, so a session in progress on the phone is safe.
- **The api still does its own stamping.** `stampPut` in the api runs on every push, the coach's
  included, exactly as for the app.
- **The MCP never writes the data files and never reads `data/secret`.** Reads come from
  `state-<uid>.json`; after a write the api's atomic rename changes the file and the next read
  picks it up.
- **The token is a normal session.** It is the same 90-day session the mobile app gets from
  pairing. The server's first request is `GET /api/me`; once the token is past half its life the
  api hands back a fresh one and the token file is rewritten, so the pairing does not run out
  while it is in use. "Sign out everywhere" in the app revokes it like any other session.

**What the athlete sees.** The app asks the server for its revision every 30 seconds while it is
open, and again when it comes back into focus, so a change made by the coach appears within 30
seconds, or as soon as the app is opened.

## Remote MCP over HTTPS (the phone, claude.ai)

Everything above runs the server as a process your LLM client spawns on the same machine. The
Claude phone app cannot spawn processes: it reaches MCP servers over HTTPS as **custom
connectors** (claude.ai, Settings → Connectors, available on every plan including Pro, and the
connection is made from Anthropic's cloud, so the server has to be reachable from the internet).
For that, `src/http.js` serves the same tools over the Streamable HTTP transport, and
`Dockerfile` packages it to run next to the api.

It is stateless: every request gets its own transport and server, nothing is held between
requests except the cached profile document. Reads and writes both go through the api (remote
mode), so no data directory is mounted.

**Auth** is one shared secret, `MCP_SECRET`, accepted two ways:

| Form | Who uses it |
|---|---|
| `POST https://<host>/mcp/<secret>` | claude.ai custom connectors, which cannot set a header without OAuth |
| `POST https://<host>/mcp` with `Authorization: Bearer <secret>` | Claude Code (`claude mcp add --transport http`), scripts |

Over TLS the URL form is as strong as the header form. It does end up in the proxy's access log
and in the connector settings, so treat it like a password and rotate it by changing
`MCP_SECRET`. The spec's preferred route for remote servers is OAuth; it is not implemented.
`GET /mcp/health` needs no secret and reports `{ ok, mode, profile, writable }`. The server
refuses to start without `MCP_SECRET` unless `MCP_INSECURE=1` (a box nothing else can reach).

Env: `MCP_PORT` (8086), `MCP_HOST` (0.0.0.0), `MCP_PATH` (/mcp), `MCP_SECRET`, plus the usual
`OPENGYM_URL` and token settings. The image sets `OPENGYM_REMOTE=1` and
`OPENGYM_TOKEN_FILE=/token/opengym.json`.

### Running it with Docker Compose next to the api

Build from the repository root (the training logic lives in `frontend/src/lib`):

```yaml
  opengym-mcp:
    build:
      context: ./openGym          # a clone of this repository
      dockerfile: mcp/Dockerfile
    container_name: opengym-mcp
    environment:
      - OPENGYM_URL=http://api:3000       # the api service, inside the compose network
      - MCP_SECRET=${OPENGYM_MCP_SECRET}  # openssl rand -hex 32
    volumes:
      - ./config/opengym/mcp:/token       # the paired token; chown 1000:1000 (the node user)
    ports:
      - "127.0.0.1:8086:8086"             # only the reverse proxy talks to it
    depends_on:
      api:
        condition: service_started
    restart: unless-stopped
```

Pair it once (the code comes from the app: Settings → Pair the mobile app):

```bash
docker compose run --rm opengym-mcp node scripts/pair.mjs <CODE> --url http://api:3000 --token-file /token/opengym.json
docker compose up -d opengym-mcp
curl -s http://127.0.0.1:8086/mcp/health   # "writable": true
```

Put it behind the same HTTPS host as the app. With Caddy, inside the existing site block:

```
opengym.abhaile.dev {
    handle /mcp/* {
        reverse_proxy localhost:8086
    }
    reverse_proxy localhost:8085
}
```

Then in claude.ai: Settings → Connectors → Add custom connector → URL
`https://<host>/mcp/<secret>`, leave the OAuth fields empty, save. Switch the connector on in a
chat (the tools menu) and it is there on the phone, the web and the desktop. A claude.ai
Project whose instructions hold your coaching rules (see the fork's `CLAUDE.md`) gives every
chat the same behaviour.

## How it reuses the training logic

The MCP server imports the training helpers under `frontend/src/lib/` directly as Node ESM
and calls the same functions the React UI does (`history.js`, `onerm.js`, `muscles.js`,
`exercises.js`). The numbers it returns match what the Stats screen shows, because they are
the same code.

The write path reaches one more set of them: the app's sync stamping and merging
(`sync-merge.js`), and the helpers the app changes its own document with (`routines.js`,
`day-notes.js`, `backfill.js`, `workout-date.js`, `superset-meta.js`, `equipment.js`), plus the
icon keys in `api/coach/core/glyphs.js`. `scripts/check-node-loadable.mjs` imports each of them
under plain node, since vitest would not notice one that only loads under Vite.

The one lib file that wasn't Node-safe was `i18n.js` (Vite's `import.meta.glob` at module
top level), split into `i18n-core.js` (pure, Node-safe) + `i18n.js` (Vite/React bits,
re-exports from core). `exercises.js` got a one-line `import.meta.env || {}` guard. No new
dependencies landed in `frontend/`, no public exports changed.

## Design constraints honoured

- **No runtime dependency beyond the MCP SDK and zod.** No database driver, no HTTP framework;
  writes use Node's own `fetch`.
- **No new container.** stdio transport is spawned by the LLM client; nothing to add to
  `docker-compose.yml`.
- **No new auth.** Reads stay behind the filesystem, the same boundary as `docker compose`
  running on the user's box. Writes use the pairing the app already has for phones, and a token
  the api already knows how to renew and revoke. No passkey material, VAPID keys or session
  secrets cross either boundary.
- **No telemetry, no network beyond your own instance.** Reads `./data/*.json` (or, in remote
  mode, `GET /api/data`); writes talk only to `OPENGYM_URL`. It exits when the LLM client disconnects.

## Tests

```bash
cd mcp && npm test
node scripts/check-node-loadable.mjs
```

206 cases in 8 files, seeding state from `frontend/src/lib/demoSeed.js` (the same deterministic
fixture the public demo runs on):

- `test/tools.test.js` (87) pins the read tools' JSON shape and the user-facing edge cases:
  rest-day override, missing routine, zero-workout history, no synced state, superset links,
  three 1RM formulas.
- `test/write-tools.test.js` (67) runs every apply function on the seed without a network: the
  exercise resolver, the caps, each `edit_routine` op, the date rules, PR rebuilding, custom
  exercise vocabularies, and the tool schemas.
- `test/client.test.js` (13) runs `commit` against a fake api: stamping, the conditional push,
  409 merging and retries, every error code, token sources and renewal, and `pair.mjs`.
- `test/integration.test.js` (6) boots the real `api/server.js` on a temporary data directory
  and commits through it, including a change the app saved between the read and the push. It
  runs when `api/node_modules` exists and skips otherwise.
- `test/remote.test.js` (11) drives remote mode against a fake api: what the first refresh
  fetches, skipping the document when the revision has not moved, the defaults merge, the
  token's user, a never-synced profile, `EAUTH` and `ECONN`, and a read tool answering from it.
- `test/http.test.js` (8) drives the Streamable HTTP server with the SDK's own client: both
  auth forms, the refusals, 405 on GET and DELETE, health, a read and a write through it.
- `test/state.test.js` (13) and `test/labels.test.js` (1) cover data loading, mode selection and
  labels.

"Today" is pinned via `vi.useFakeTimers({ now: ..., toFake: ['Date'] })` so date-dependent
tools see consistent values regardless of when the suite runs. The pure lib functions have
their own tests in `frontend/src/lib/*.test.js`.

## Roadmap

- **Done (Phase 1):** read-only stdio, nine read tools, direct `./data` access.
- **Done (Phase 1.5):** `preview_session`, the policy's next prescription, the opening set
  rows it produces, and which of plan / confirmed weight / history each number came from.
- **Done (Phase 2):** read+write over stdio. Writes go through `PUT /api/data` with a token from
  the app's existing pairing, stamped and merged by the app's own code, so no write lock and no
  new token store were needed. Ten write tools and two read helpers.
- **Not yet (Phase 2):** writing the coach week (queue) or the rotation, or switching the
  schedule mode; changing settings; media; deleting workouts.
- **Done (Phase 3):** Streamable HTTP transport (`src/http.js`) and a container
  (`mcp/Dockerfile`) to run next to the api, so the Claude phone app reaches the same tools as a
  claude.ai custom connector. Shared-secret auth; OAuth is the remaining gap.

## License

AGPL-3.0-or-later, same as openGym.
