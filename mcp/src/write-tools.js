/* The write tools, and two read helpers the coach needs beside them. A write tool's handler
   commits through client.js: commit() fetches the athlete's document from the running api,
   hands a copy to the tool's apply function, stamps the result with the app's own stamping and
   pushes it conditional on the revision it read. The apply functions here are pure on the state
   they are given: they mutate it, return { state, result }, and throw an Error with a `.code`
   (EINVAL, ENOENT, EAMBIG, ENOMATCH) when the change cannot be made. Nothing is half-applied:
   a throw means commit() pushes nothing.

   Each result is built from the state the apply function just changed, never re-read from disk,
   so the confirmation is exactly what was written. */
import { z } from 'zod'
import { getState } from './state.js'
import { commit } from './client.js'
import { isoDate, todayIso, localIso, exerciseOf, withCustomsIndexed, entryView, routineView } from './tools.js'
import {
  CAPS, NAME_MAX, NOTE_MAX, POLICIES, GLYPHS, MAX_EX_PER_ROUTINE,
  fail, invalid, resolveExercise, candidateLine, normaliseItem, validateRoutine,
  cleanName, cleanEmoji, cleanPolicy
} from './validate.js'
import { modeOf, workoutVolume, cleanupSg, setsDone, bestWeightForEntry } from '../../frontend/src/lib/history.js'
import { searchExercises, allExercises, BODYPARTS, CATALOGUE } from '../../frontend/src/lib/exercises.js'
import { ALL_EQUIPMENT } from '../../frontend/src/lib/equipment.js'
import { MUSCLES, MUSCLE_NAME, muscleGroupsOf, inMuscleOrder } from '../../frontend/src/lib/muscles.js'
import { deleteRoutine } from '../../frontend/src/lib/routines.js'
import { withDayNote, readDayNote, DAY_NOTE_TAGS } from '../../frontend/src/lib/day-notes.js'
import { uid, DAYN } from '../../frontend/src/lib/format.js'
import { stampWorkout } from '../../frontend/src/lib/sync-merge.js'
import { insertChronological } from '../../frontend/src/lib/backfill.js'
import { rebuildPrHistory } from '../../frontend/src/lib/workout-date.js'
import { setSupersetMeta, SG_NAME_MAX } from '../../frontend/src/lib/superset-meta.js'
import { queueView } from '../../frontend/src/lib/queue.js'

/* ---------- shared helpers ---------- */

const unitOf = S => S.unit || 'kg'
const given = v => v !== undefined && v !== null

function noState() {
  return {
    error: 'no synced state yet: sign in at least once from a device so the openGym api can save a state file for this profile',
    unit: 'kg'
  }
}

// The same calendar check as the zod schema, for the apply functions, which tests (and any
// future caller) reach without going through zod.
function checkIso(v, where) {
  if (!isoDate().safeParse(v).success) throw invalid(`${where} must be a real date as YYYY-MM-DD (got ${JSON.stringify(v)})`)
  return v
}

const shiftDays = (n) => {
  const now = new Date()
  return localIso(new Date(now.getFullYear(), now.getMonth(), now.getDate() + n, 12))
}

function findRoutine(S, id) {
  const r = (Array.isArray(S.routines) ? S.routines : []).find(x => x && x.id === id)
  if (!r) {
    const known = (S.routines || []).map(x => `${x.id} (${x.name})`).join(', ') || 'none'
    throw fail('ENOENT', `no routine with id ${JSON.stringify(id)}. Routines: ${known}`)
  }
  return r
}

// A superset tag the routine does not use yet. uid() starts with the clock, so two tags made in
// the same millisecond would collide on their first six characters; the loop moves on to random ones.
function freshSg(ex) {
  let tag = uid().slice(0, 6)
  while (ex.some(e => e && e.sg === tag)) tag = Math.random().toString(36).slice(2, 8)
  return tag
}

/* ---------- zod pieces ---------- */

const POLICY_ENUM = z.enum(POLICIES)
const posInt = () => z.number().int().min(1)

const ITEM_FIELDS = {
  exercise: z.string().min(1).describe('An exercise id from search_exercises (catalogue or custom), or a name. A name is only accepted when it matches one exercise exactly or uniquely; otherwise the tool answers EAMBIG with candidate ids to choose from.'),
  sets: z.number().int().min(1).max(10).describe('Working sets, 1 to 10 (warm-ups are separate, see warmup_sets).'),
  reps: z.number().int().min(1).max(100).optional().describe('Reps per set, 1 to 100. Required for rep work. With reps_min it is the TOP of a double-progression range. On a per-side exercise it is the total of both sides, so even.'),
  reps_min: z.number().int().min(1).max(100).optional().describe('Bottom of a double-progression rep range (reps is the top), e.g. reps_min 8 with reps 12 reads as 8-12.'),
  reps_max: z.number().int().min(1).max(100).optional().describe('Rep ceiling for bodyweight progression: reaching it adds a set and restarts the reps. Not the top of a range (that is reps).'),
  sets_max: z.number().int().min(1).max(10).optional().describe('Set ceiling for triple progression, at least sets.'),
  weight: z.number().min(0).max(1000).optional().describe('Planned load in the athlete\'s profile unit (kg or lb, see `unit` in any result). It is only the starting point: the progression policy and the last session usually decide what the app opens with, so check preview_session before telling the athlete a number. Omit for bodyweight work.'),
  sec: z.number().int().min(5).max(3600).optional().describe('Seconds per set for a timed hold (plank, wall sit, isometrics). Makes the exercise timed instead of rep-counted.'),
  min: z.number().int().min(1).max(180).optional().describe('Minutes for a cardio exercise (run, bike, row).'),
  speed: z.number().positive().max(60).optional().describe('Cardio speed in km/h (or mph on a mph profile). Defaults to 8.'),
  rest_sec: z.number().int().min(0).max(900).optional().describe('This exercise\'s own rest between sets in seconds; omit to use the athlete\'s global rest timer.'),
  warmup_sets: z.number().int().min(0).max(5).optional().describe('Warm-up ramp sets the app builds before the working sets, 0 to 5. Not for cardio.'),
  side: z.boolean().optional().describe('Unilateral (per side). Reps are then the total across both sides: 8 per side is reps 16.'),
  superset: z.string().min(1).max(20).optional().describe('A tag of your choosing ("A"). Exercises listed next to each other with the same tag become one superset.'),
  note: z.string().max(NOTE_MAX).optional().describe('A cue the athlete sees on this exercise during the session (form cue, intent, tempo).'),
  prog: POLICY_ENUM.optional().describe('Progression for this exercise only, overriding the routine\'s: off, linear, greyskull, double, triple (rep work) or time (timed holds).'),
  inc: z.number().min(0).max(50).optional().describe('Load step for progression in the profile unit; omit for the app default (2.5 kg upper body, 5 kg lower body).'),
  bodyweight: z.boolean().optional().describe('Override whether the exercise is bodyweight (weight then means ADDED load). Omit to follow the catalogue.')
}
const itemSchema = z.object(ITEM_FIELDS)

const SLOT_REF = {
  position: posInt().optional().describe('1-based position in the routine (from get_routine). Give this or exercise.'),
  exercise: z.string().min(1).optional().describe('The exercise in this routine, by id or name. Give this or position.')
}

const TARGET_FIELDS = {
  sets: z.number().int().min(1).max(10).optional().describe('Working sets.'),
  reps: z.number().int().min(1).max(100).nullable().optional().describe('Reps per set (top of the range when reps_min is set).'),
  reps_min: z.number().int().min(1).max(100).nullable().optional().describe('Bottom of a double-progression range; null removes the range.'),
  reps_max: z.number().int().min(1).max(100).nullable().optional().describe('Bodyweight rep ceiling; null removes it.'),
  sets_max: z.number().int().min(1).max(10).nullable().optional().describe('Triple-progression set ceiling; null removes it.'),
  weight: z.number().min(0).max(1000).nullable().optional().describe('Planned load in the profile unit; 0 or null removes it. Progression and history usually override it: check preview_session.'),
  sec: z.number().int().min(5).max(3600).optional().describe('Seconds per set (timed exercises only).'),
  min: z.number().int().min(1).max(180).optional().describe('Minutes (cardio only).'),
  speed: z.number().positive().max(60).optional().describe('Speed (cardio only).'),
  rest_sec: z.number().int().min(0).max(900).nullable().optional().describe('Own rest in seconds; 0 or null goes back to the global timer.'),
  warmup_sets: z.number().int().min(0).max(5).nullable().optional().describe('Warm-up sets; 0 or null removes them.'),
  inc: z.number().min(0).max(50).nullable().optional().describe('Progression load step; 0 or null goes back to the default.'),
  prog: POLICY_ENUM.nullable().optional().describe('Progression for this exercise; null follows the routine.'),
  side: z.boolean().nullable().optional().describe('Per-side (unilateral); false or null turns it off.')
}

const OP_SCHEMAS = [
  z.object({ op: z.literal('rename'), name: z.string().min(1).max(NAME_MAX).describe('New routine name.') }),
  z.object({ op: z.literal('set_emoji'), emoji: z.string().min(1).describe(`Icon key: ${GLYPHS.join(', ')}.`) }),
  z.object({ op: z.literal('set_policy'), prog: POLICY_ENUM.nullable().describe('Routine-wide progression; null returns to the default (linear for rep work).') }),
  z.object({ op: z.literal('add_exercise'), item: itemSchema.describe('The exercise to add, same shape as in create_routine (superset is not accepted here; use set_superset).'), position: posInt().optional().describe('1-based position to insert at; default is the end.') }),
  z.object({ op: z.literal('remove_exercise'), ...SLOT_REF }),
  z.object({ op: z.literal('replace_exercise'), ...SLOT_REF, item: itemSchema.describe('The new prescription for this slot. It keeps the slot\'s place, superset, and (unless given) its note and rest.') }),
  z.object({ op: z.literal('set_targets'), ...SLOT_REF, ...TARGET_FIELDS }),
  z.object({ op: z.literal('move_exercise'), from: posInt().describe('Current 1-based position.'), to: posInt().describe('New 1-based position.') }),
  z.object({ op: z.literal('set_superset'), positions: z.array(posInt()).min(2).max(6).describe('Positions next to each other (e.g. [2,3]) to run as one superset. Move them together first with move_exercise if needed.'), name: z.string().max(SG_NAME_MAX).optional().describe('Optional superset name shown in the app.') }),
  z.object({ op: z.literal('clear_superset'), position: posInt().describe('A position whose exercise leaves its superset.') }),
  z.object({ op: z.literal('set_note'), ...SLOT_REF, note: z.string().max(NOTE_MAX).nullable().describe('Cue shown on the exercise during the session; null removes it.') })
]
const opSchema = z.discriminatedUnion('op', OP_SCHEMAS)

/* ---------- resolving a slot inside a routine ---------- */

// The routine's own exercises are searched first, so "remove bench" finds the one bench press
// this routine has even though the catalogue has dozens.
function slotIndex(S, r, op, where) {
  const hasPos = given(op.position)
  const hasEx = given(op.exercise)
  if (hasPos === hasEx) throw invalid(`${where}: give either position or exercise (exactly one)`)
  const ex = r.ex || []
  if (hasPos) {
    if (!Number.isInteger(op.position) || op.position < 1 || op.position > ex.length) {
      throw invalid(`${where}.position ${op.position} is not in this routine (1 to ${ex.length})`)
    }
    return op.position - 1
  }
  const ref = String(op.exercise).trim()
  const byId = ex.findIndex(s => s.id === ref)
  if (byId >= 0) return byId
  const own = ex.map(s => exerciseOf(s.id, S))
  const lower = ref.toLowerCase()
  const exact = own.findIndex(e => String(e.n || '').toLowerCase() === lower)
  if (exact >= 0) return exact
  const hits = searchExercises(own, ref)
  if (hits.length === 1) return own.indexOf(hits[0])
  if (hits.length > 1) {
    const lines = hits.map(h => `position ${own.indexOf(h) + 1}: ${candidateLine(h)}`).join('\n')
    throw fail('EAMBIG', `${where}.exercise "${ref}" matches several exercises in "${r.name}"; use position:\n${lines}`)
  }
  throw fail('ENOENT', `${where}.exercise "${ref}" is not in routine "${r.name}" (it has: ${own.map((e, i) => `${i + 1} ${e.n}`).join(', ')})`)
}

/* ---------- create_routine ---------- */

// Items that share a superset tag get one fresh `sg`. The app links a superset by adjacency
// (history.js cleanupSg), so members listed apart would be split apart again on the first edit.
function applySupersetTags(ex, tags) {
  const groups = new Map()
  tags.forEach((t, i) => {
    if (!given(t) || !String(t).trim()) return
    const k = String(t).trim()
    if (!groups.has(k)) groups.set(k, [])
    groups.get(k).push(i)
  })
  for (const [tag, idx] of groups) {
    if (idx.length < 2) throw invalid(`exercises[${idx[0]}].superset "${tag}" is on one exercise only; a superset needs two or more, listed next to each other`)
    if (idx.some((v, j) => j > 0 && v !== idx[j - 1] + 1)) {
      throw invalid(`superset "${tag}" members (exercises[${idx.join('], exercises[')}]) must be listed next to each other: the app links supersets by adjacency`)
    }
    const sg = freshSg(ex)
    idx.forEach(i => { ex[i].sg = sg })
  }
}

export function applyCreateRoutine(S, p) {
  return withCustomsIndexed(S, () => {
    const name = cleanName(p.name, 'name')
    const emoji = cleanEmoji(p.emoji)
    const items = p.exercises
    if (!Array.isArray(items) || !items.length) throw invalid('exercises must list at least one exercise')
    if (items.length > MAX_EX_PER_ROUTINE) throw invalid(`exercises lists ${items.length}; the most a routine holds is ${MAX_EX_PER_ROUTINE}`)
    const ex = items.map((it, i) => normaliseItem(S, it, `exercises[${i}]`))
    applySupersetTags(ex, items.map(it => it && it.superset))
    const r = { id: uid(), name, emoji, ...(given(p.prog) ? { prog: cleanPolicy(p.prog) } : {}), ex }
    validateRoutine(S, r)
    S.routines = [...(Array.isArray(S.routines) ? S.routines : []), r]
    return { state: S, result: { routine_id: r.id, routine: routineView(S, r) } }
  })
}

/* ---------- edit_routine ---------- */

// Which set_targets fields a slot of each mode reads. A field from another mode is refused
// rather than stored where nothing reads it: sec on a rep exercise would be silently ignored.
const TARGET_KEYS = {
  sets: 'sets', reps: 'reps', reps_min: 'repsMin', reps_max: 'repsMax', sets_max: 'setsMax', weight: 'weight',
  sec: 'sec', min: 'min', speed: 'speed', rest_sec: 'restSec', warmup_sets: 'warmupSets', inc: 'inc', prog: 'prog', side: 'side'
}
const TARGETS_FOR = {
  reps: ['sets', 'reps', 'reps_min', 'reps_max', 'sets_max', 'weight', 'rest_sec', 'warmup_sets', 'inc', 'prog', 'side'],
  time: ['sets', 'sec', 'weight', 'rest_sec', 'warmup_sets', 'inc', 'prog', 'side'],
  cardio: ['sets', 'min', 'speed', 'rest_sec', 'prog']
}
// Fields a slot of that mode cannot do without.
const REQUIRED = new Set(['sets', 'reps', 'sec', 'min', 'speed'])
// Fields whose 0 / false means "not set": stored only when they say something.
const ZERO_CLEARS = new Set(['weight', 'restSec', 'warmupSets', 'inc', 'side'])

const OPS = {
  rename: (S, r, op) => { r.name = cleanName(op.name, 'name') },
  set_emoji: (S, r, op) => { r.emoji = cleanEmoji(op.emoji) },
  set_policy: (S, r, op) => {
    if (op.prog == null) delete r.prog
    else r.prog = cleanPolicy(op.prog)
  },
  add_exercise: (S, r, op, where, touched) => {
    if (op.item && given(op.item.superset)) throw invalid(`${where}.item.superset is not used here; add the exercise, then link it with set_superset`)
    const slot = normaliseItem(S, op.item, `${where}.item`)
    const len = r.ex.length
    const pos = given(op.position) ? op.position : len + 1
    if (!Number.isInteger(pos) || pos < 1 || pos > len + 1) throw invalid(`${where}.position ${pos} is outside 1 to ${len + 1}`)
    r.ex.splice(pos - 1, 0, slot)
    touched.add(slot)
  },
  remove_exercise: (S, r, op, where) => {
    r.ex.splice(slotIndex(S, r, op, where), 1)
  },
  replace_exercise: (S, r, op, where, touched) => {
    const i = slotIndex(S, r, op, where)
    if (op.item && given(op.item.superset)) throw invalid(`${where}.item.superset is not used here; the slot keeps its superset (set_superset / clear_superset change it)`)
    const old = r.ex[i]
    const slot = normaliseItem(S, op.item, `${where}.item`)
    // The slot keeps its place in a superset, as the app's own replace does (routines.js
    // replaceSlotExercise), and the note and rest unless the new prescription names its own.
    for (const k of ['sg', 'sgName', 'sgRest']) if (old[k] != null) slot[k] = old[k]
    if (old.note != null && slot.note == null && op.item.note === undefined) slot.note = old.note
    if (old.restSec != null && slot.restSec == null && op.item.rest_sec === undefined) slot.restSec = old.restSec
    r.ex[i] = slot
    touched.add(slot)
  },
  set_targets: (S, r, op, where, touched) => {
    const i = slotIndex(S, r, op, where)
    const slot = r.ex[i]
    const mode = modeOf(slot)
    const fields = Object.keys(TARGET_KEYS).filter(k => op[k] !== undefined)
    if (!fields.length) throw invalid(`${where} changes nothing: give at least one of ${TARGETS_FOR[mode].join(', ')}`)
    for (const k of fields) {
      if (!TARGETS_FOR[mode].includes(k)) {
        throw invalid(`${where}.${k} does not apply to position ${i + 1}, which is logged as ${mode}; it takes ${TARGETS_FOR[mode].join(', ')}. To change how it is logged, use replace_exercise with a full item.`)
      }
      const key = TARGET_KEYS[k]
      const v = op[k]
      if (v === null) {
        if (REQUIRED.has(k)) throw invalid(`${where}.${k} cannot be cleared on a ${mode} exercise`)
        delete slot[key]
      } else if (ZERO_CLEARS.has(key) && !v) {
        delete slot[key]
      } else {
        slot[key] = key === 'side' ? true : v
      }
    }
    touched.add(slot)
  },
  move_exercise: (S, r, op, where) => {
    const len = r.ex.length
    for (const k of ['from', 'to']) {
      if (!Number.isInteger(op[k]) || op[k] < 1 || op[k] > len) throw invalid(`${where}.${k} ${op[k]} is outside 1 to ${len}`)
    }
    const [slot] = r.ex.splice(op.from - 1, 1)
    r.ex.splice(op.to - 1, 0, slot)
  },
  set_superset: (S, r, op, where) => {
    const pos = Array.isArray(op.positions) ? [...new Set(op.positions)].sort((a, b) => a - b) : []
    if (pos.length < 2) throw invalid(`${where}.positions needs two or more different positions`)
    for (const p of pos) {
      if (!Number.isInteger(p) || p < 1 || p > r.ex.length) throw invalid(`${where}.positions has ${p}, outside 1 to ${r.ex.length}`)
    }
    if (pos.some((p, j) => j > 0 && p !== pos[j - 1] + 1)) {
      throw invalid(`${where}.positions ${pos.join(', ')} are not next to each other; the app links supersets by adjacency, so move_exercise them together first`)
    }
    const tag = freshSg(r.ex)
    for (const p of pos) {
      const slot = r.ex[p - 1]
      slot.sg = tag
      delete slot.sgName
      delete slot.sgRest
    }
    if (op.name && String(op.name).trim()) setSupersetMeta(r.ex, tag, { name: op.name })
  },
  clear_superset: (S, r, op, where) => {
    if (!Number.isInteger(op.position) || op.position < 1 || op.position > r.ex.length) throw invalid(`${where}.position ${op.position} is outside 1 to ${r.ex.length}`)
    const slot = r.ex[op.position - 1]
    if (!slot.sg) throw invalid(`${where}: position ${op.position} is not in a superset`)
    delete slot.sg
    delete slot.sgName
    delete slot.sgRest
  },
  set_note: (S, r, op, where, touched) => {
    const slot = r.ex[slotIndex(S, r, op, where)]
    const note = op.note == null ? '' : String(op.note).trim()
    if (note.length > NOTE_MAX) throw invalid(`${where}.note is longer than ${NOTE_MAX} characters`)
    if (note) slot.note = note
    else delete slot.note
    touched.add(slot)
  }
}

export function applyEditRoutine(S, p) {
  return withCustomsIndexed(S, () => {
    const r = findRoutine(S, p.routine_id)
    const ops = p.ops
    if (!Array.isArray(ops) || !ops.length) throw invalid('ops must list at least one operation')
    if (ops.length > 25) throw invalid(`ops lists ${ops.length}; send at most 25 per call`)
    if (!Array.isArray(r.ex)) r.ex = []
    const touched = new Set()
    ops.forEach((op, i) => {
      const fn = op && OPS[op.op]
      if (!fn) throw invalid(`ops[${i}].op ${JSON.stringify(op && op.op)} is not one of ${Object.keys(OPS).join(', ')}`)
      fn(S, r, op, `ops[${i}] (${op.op})`, touched)
    })
    // A superset whose partner moved away or left is one exercise with a tag; the app clears
    // those the same way after its own edits.
    cleanupSg(r.ex)
    validateRoutine(S, r, touched)
    return { state: S, result: { routine_id: r.id, applied: ops.length, routine: routineView(S, r) } }
  })
}

/* ---------- delete_routine ---------- */

export function applyDeleteRoutine(S, p) {
  const r = findRoutine(S, p.routine_id)
  const weekdays = Object.keys(S.week || {}).filter(d => [].concat(S.week[d]).includes(r.id)).map(Number).sort()
  const dropped = deleteRoutine(S, r.id)
  const inRotation = Array.isArray(S.rotation?.sequence) && S.rotation.sequence.includes(r.id)
  return {
    state: S,
    result: {
      deleted: r.id,
      name: r.name,
      cleared_days: Object.keys(dropped).sort(),
      cleared_weekdays: weekdays.map(d => DAYN[d]),
      ...(inRotation ? { warning: 'The routine was in the app\'s rotation; the app skips it there from now on.' } : {})
    }
  }
}

/* ---------- assign_weekday ---------- */

const WEEKDAY_ALIASES = {
  sun: 0, sunday: 0, mon: 1, monday: 1, tue: 2, tues: 2, tuesday: 2, wed: 3, wednesday: 3,
  thu: 4, thur: 4, thurs: 4, thursday: 4, fri: 5, friday: 5, sat: 6, saturday: 6
}

export function parseWeekday(v) {
  if (Number.isInteger(v) && v >= 0 && v <= 6) return v
  const s = String(v ?? '').trim().toLowerCase()
  if (/^[0-6]$/.test(s)) return Number(s)
  if (Object.hasOwn(WEEKDAY_ALIASES, s)) return WEEKDAY_ALIASES[s]
  throw invalid(`weekday ${JSON.stringify(v)} is not a weekday: use 0-6 (0 = Sunday) or a name like "mon" / "monday"`)
}

export function applyAssignWeekday(S, p) {
  const d = parseWeekday(p.weekday)
  const ids = Array.isArray(p.routine_ids) ? p.routine_ids : []
  if (ids.length > 3) throw invalid(`routine_ids lists ${ids.length}; a day holds at most 3 routines`)
  if (new Set(ids).size !== ids.length) throw invalid('routine_ids names the same routine twice')
  const routines = ids.map(id => findRoutine(S, id))
  if (!S.week || typeof S.week !== 'object' || Array.isArray(S.week)) S.week = {}
  const previous = [].concat(S.week[d] ?? [])
  // An empty day is a missing key, never [] (routines.js deleteRoutine says the same).
  if (ids.length) S.week[d] = [...ids]
  else delete S.week[d]
  const warnings = []
  if (S.scheduleMode === 'rotation') {
    warnings.push('The app is in rotation mode: Home and Plan show the rotation, not this weekday plan, until the athlete switches back to the weekly schedule in the app.')
  }
  if (queueView(S, todayIso())) {
    warnings.push('A coach week is running: its next session is what the app offers first; the weekday plan rides alongside it.')
  }
  return {
    state: S,
    result: {
      weekday: d,
      weekday_name: DAYN[d],
      routine_ids: [...ids],
      routines: routines.map(r => ({ id: r.id, name: r.name })),
      previous_routine_ids: previous,
      ...(warnings.length ? { warning: warnings.join(' ') } : {})
    }
  }
}

/* ---------- plan_day ---------- */

export function applyPlanDay(S, p) {
  const iso = checkIso(p.date, 'date')
  if (iso < todayIso()) throw invalid(`date ${iso} is in the past; plan_day plans today or a later day (log_workout records a past session)`)
  const rid = p.routine_id
  let routine = null
  if (given(rid) && rid !== 'rest') routine = findRoutine(S, rid)
  if (!S.dayPlan || typeof S.dayPlan !== 'object' || Array.isArray(S.dayPlan)) S.dayPlan = {}
  const previous = S.dayPlan[iso] ?? null
  if (!given(rid)) delete S.dayPlan[iso]
  else S.dayPlan[iso] = rid === 'rest' ? 'rest' : routine.id
  const wd = new Date(iso + 'T12:00:00').getDay()
  const weekIds = [].concat(S.week?.[wd] ?? []).filter(id => (S.routines || []).some(x => x.id === id))
  return {
    state: S,
    result: {
      date: iso,
      planned: S.dayPlan[iso] ?? null,
      ...(routine ? { routine_name: routine.name } : {}),
      previous,
      weekday_plan: weekIds.map(id => (S.routines || []).find(x => x.id === id).name)
    }
  }
}

/* ---------- set_day_note ---------- */

export function applySetDayNote(S, p) {
  const iso = checkIso(p.date, 'date')
  const text = given(p.text) ? String(p.text).trim() : ''
  if (text.length > NOTE_MAX) throw invalid(`text is longer than ${NOTE_MAX} characters`)
  if (given(p.tag) && !DAY_NOTE_TAGS.includes(p.tag)) throw invalid(`tag "${p.tag}" is not one of ${DAY_NOTE_TAGS.join(', ')}`)
  S.dayNotes = withDayNote(S.dayNotes, iso, { tag: p.tag || null, text }, Date.now())
  const note = readDayNote(S.dayNotes[iso])
  return { state: S, result: { date: iso, tag: note?.tag ?? null, text: note?.text || null, cleared: !note } }
}

/* ---------- log_workout ---------- */

const LOG_CAPS = { reps: [0, 300], sec: [1, 36000], min: [0.1, 600], rir: [0, 10], rpe: [1, 10] }

function loggedSet(s, where) {
  if (!s || typeof s !== 'object') throw invalid(`${where} must be an object`)
  const timed = given(s.sec)
  const cardio = given(s.min) || given(s.speed)
  const reps = given(s.reps)
  if ([timed, cardio, reps].filter(Boolean).length > 1) throw invalid(`${where} mixes reps, sec and min/speed; a set is one of them`)
  const mode = timed ? 'time' : cardio ? 'cardio' : reps ? 'reps' : null
  if (!mode) throw invalid(`${where} logs nothing: give reps (and weight), sec, or min`)
  const num = (k, [lo, hi], int = false) => {
    const v = s[k]
    if (typeof v !== 'number' || !Number.isFinite(v) || v < lo || v > hi || (int && !Number.isInteger(v))) {
      throw invalid(`${where}.${k} must be ${int ? 'a whole number' : 'a number'} from ${lo} to ${hi} (got ${JSON.stringify(v)})`)
    }
    return v
  }
  const w = given(s.weight) ? num('weight', CAPS.weight) : 0
  let set
  if (mode === 'reps') set = { w, r: num('reps', LOG_CAPS.reps, true), done: true }
  else if (mode === 'time') set = { sec: num('sec', LOG_CAPS.sec, true), w, done: true }
  else {
    if (given(s.weight)) throw invalid(`${where}.weight does not apply to a cardio set`)
    set = { min: given(s.min) ? num('min', LOG_CAPS.min) : 0, speed: given(s.speed) ? num('speed', CAPS.speed) : 0, done: true }
  }
  if (given(s.rir) && given(s.rpe)) throw invalid(`${where} gives both rir and rpe; give the one the athlete reported`)
  if (given(s.rir)) set.rir = num('rir', LOG_CAPS.rir)
  if (given(s.rpe)) set.rpe = num('rpe', LOG_CAPS.rpe)
  if (s.warmup) set.phase = 'warmup'
  return { set, mode }
}

const clock = (iso, hhmm) => {
  const [h, m] = String(hhmm).split(':').map(Number)
  const d = new Date(iso + 'T12:00:00')
  d.setHours(h, m, 0, 0)
  return d.getTime()
}

export function applyLogWorkout(S, p) {
  return withCustomsIndexed(S, () => {
    const iso = checkIso(p.date, 'date')
    if (iso > todayIso()) throw invalid(`date ${iso} is in the future; log_workout records sessions already done (plan_day plans one)`)
    const routine = given(p.routine_id) ? findRoutine(S, p.routine_id) : null
    const dur = given(p.duration_min) ? p.duration_min : 60
    if (!Number.isInteger(dur) || dur < 1 || dur > 600) throw invalid(`duration_min must be a whole number from 1 to 600 (got ${JSON.stringify(dur)})`)
    if (given(p.start_time) && !/^([01]\d|2[0-3]):[0-5]\d$/.test(String(p.start_time))) throw invalid(`start_time must be HH:MM, 24-hour (got ${JSON.stringify(p.start_time)})`)
    const items = p.entries
    if (!Array.isArray(items) || !items.length) throw invalid('entries must list at least one exercise')
    if (items.length > 30) throw invalid(`entries lists ${items.length}; the most is 30`)

    const entries = items.map((it, i) => {
      const where = `entries[${i}]`
      if (!it || typeof it !== 'object') throw invalid(`${where} must be an object`)
      let id
      try { id = resolveExercise(S, it.exercise) } catch (e) { e.message = `${where}.exercise: ${e.message}`; throw e }
      const sets = Array.isArray(it.sets) ? it.sets : []
      if (!sets.length) throw invalid(`${where}.sets must list at least one set`)
      if (sets.length > 30) throw invalid(`${where}.sets lists ${sets.length}; the most is 30`)
      const parsed = sets.map((s, j) => loggedSet(s, `${where}.sets[${j}]`))
      const mode = parsed[0].mode
      if (parsed.some(x => x.mode !== mode)) throw invalid(`${where}.sets mix reps, timed and cardio sets; one exercise is logged one way`)
      const entry = { id, sets: parsed.map(x => x.set) }
      if (routine) entry.rid = routine.id
      // Where the catalogue would read the sets another way (a timed plank, reps on a cardio id),
      // the entry says how it was logged, as a session entry carries its routine target.
      if (mode !== modeOf({ id })) entry.target = { mode }
      const note = given(it.note) ? String(it.note).trim() : ''
      if (note.length > NOTE_MAX) throw invalid(`${where}.note is longer than ${NOTE_MAX} characters`)
      if (note) entry.note = note
      return entry
    })
    // Taken the way the app's finish takes it (finish-workout.js): completed work sets only, so a
    // warm-up never sets it, and the least help on an assistance machine.
    for (const e of entries) e.topW = bestWeightForEntry(e) || null

    let start = clock(iso, given(p.start_time) ? p.start_time : '12:00')
    let end = start + dur * 60000
    const now = Date.now()
    if (end > now) {
      if (given(p.start_time)) throw invalid(`start_time ${p.start_time} plus ${dur} min ends in the future; log_workout records sessions already done`)
      // Today, before the default noon has come and gone: the session ended just now.
      end = now
      start = now - dur * 60000
    }
    const name = given(p.name) && String(p.name).trim() ? cleanName(p.name, 'name') : (routine ? routine.name : 'Logged session')
    let bw = null
    if (given(p.bodyweight)) {
      if (typeof p.bodyweight !== 'number' || p.bodyweight < 20 || p.bodyweight > 400) throw invalid(`bodyweight must be from 20 to 400 in the profile unit (got ${JSON.stringify(p.bodyweight)})`)
      bw = p.bodyweight
    } else {
      // The weigh-in the app would have stamped on a session started that day: the latest one.
      const before = (Array.isArray(S.bodyweight) ? S.bodyweight : []).filter(b => b && b.d <= iso)
      bw = before.length ? before.reduce((a, b) => (b.d >= a.d ? b : a)).w : null
    }
    const note = given(p.note) ? String(p.note).trim() : ''
    if (note.length > 2000) throw invalid('note is longer than 2000 characters')

    const w = {
      id: uid(),
      d: iso,
      start,
      end,
      routineIds: routine ? [routine.id] : [],
      routineId: routine ? routine.id : null,
      name,
      bw,
      entries,
      prs: [],
      ...(note ? { note } : {})
    }
    w.vol = workoutVolume(w)
    // As the app files a workout logged after the fact (sheets.jsx finish, backfill): stamped
    // with when it was logged, put in date order, and the PR badges of the exercises it touches
    // rebuilt so it gains the ones it leads with and a later session it outdoes loses its own.
    stampWorkout(w)
    S.workouts = rebuildPrHistory(
      insertChronological(Array.isArray(S.workouts) ? S.workouts : [], w),
      [...new Set(entries.map(e => e.id))],
      w
    )
    const saved = S.workouts.find(x => x.id === w.id)
    return {
      state: S,
      result: {
        workout_id: saved.id,
        date: saved.d,
        name: saved.name,
        routine_id: saved.routineId,
        exercises: saved.entries.length,
        sets: setsDone(saved),
        volume: saved.vol,
        duration_min: Math.round((saved.end - saved.start) / 60000),
        bodyweight_at_workout: saved.bw,
        prs: (saved.prs || []).map(id => exerciseOf(id, S).n),
        unit: unitOf(S),
        entries: saved.entries.map(e => {
          const v = entryView(e, S)
          return { id: v.id, name: v.name, mode: v.mode, sets: v.sets.map(s => s.label), ...(e.note ? { note: e.note } : {}) }
        })
      }
    }
  })
}

/* ---------- annotate_workout ---------- */

export function applyAnnotateWorkout(S, p) {
  const w = (Array.isArray(S.workouts) ? S.workouts : []).find(x => x && x.id === p.workout_id)
  if (!w) throw fail('ENOENT', `no workout with id ${JSON.stringify(p.workout_id)}; list_workouts gives the ids`)
  const note = given(p.note) ? String(p.note).trim() : ''
  if (note.length > 2000) throw invalid('note is longer than 2000 characters')
  if (note) w.note = note
  else delete w.note
  // A saved workout edited later carries the edit time, so a merge keeps this version
  // (sync-merge.js stampWorkout).
  stampWorkout(w)
  return { state: S, result: { workout_id: w.id, date: w.d, name: w.name || null, note: w.note ?? null } }
}

/* ---------- add_bodyweight ---------- */

export function applyAddBodyweight(S, p) {
  const iso = given(p.date) ? checkIso(p.date, 'date') : todayIso()
  if (iso > todayIso()) throw invalid(`date ${iso} is in the future; a weigh-in is recorded on the day it happened`)
  const kg = p.weight
  if (typeof kg !== 'number' || !Number.isFinite(kg) || kg < 20 || kg > 400) throw invalid(`weight must be from 20 to 400 in the profile unit (got ${JSON.stringify(kg)})`)
  const weight = Math.round(kg * 100) / 100
  const list = Array.isArray(S.bodyweight) ? S.bodyweight : []
  // One weigh-in per day, the later one wins (sync-merge.js mergeBodyweight reads `t`).
  const same = list.find(b => b && b.d === iso)
  const previous = same ? same.w : undefined
  if (same) { same.w = weight; same.t = Date.now() } else list.push({ d: iso, w: weight, t: Date.now() })
  list.sort((a, b) => (a.d < b.d ? -1 : a.d > b.d ? 1 : 0))
  S.bodyweight = list
  return {
    state: S,
    result: { date: iso, weight, unit: unitOf(S), ...(previous !== undefined ? { previous } : {}), goal: S.targetW ?? null }
  }
}

/* ---------- create_custom_exercise ---------- */

// The vocabularies the app's own custom-exercise form offers (sheets.jsx CustomExForm): the
// catalogue's body parts and equipment, and the muscles the body map can draw. A muscle may also
// be named the catalogue's way ("quads", "pectorals"); it is stored as the map's slug, the way
// the form stores it, so the app's muscle map and the edit form both read it.
const CATALOGUE_TARGETS = [...new Set(CATALOGUE.map(e => e.tg).filter(Boolean))].sort()

function muscleSlug(v) {
  const s = String(v ?? '').trim().toLowerCase()
  if (!s) return null
  if (MUSCLES.includes(s)) return s
  const byLabel = MUSCLES.find(m => String(MUSCLE_NAME[m]).toLowerCase() === s)
  if (byLabel) return byLabel
  return muscleGroupsOf({ primaries: [s] })[0] || null
}

const pick = (list, v) => list.find(x => x.toLowerCase() === String(v ?? '').trim().toLowerCase()) || null

export function applyCreateCustomExercise(S, p) {
  const name = cleanName(p.name, 'name')
  const dup = allExercises(S).find(e => String(e.n || '').trim().toLowerCase() === name.toLowerCase())
  if (dup) throw invalid(`"${dup.n}" already exists as exercise ${dup.id}${dup.custom ? ' (one of the athlete\'s own)' : ''}; use that id instead of creating another`)
  const bp = pick(BODYPARTS, p.body_part)
  if (!bp) throw invalid(`body_part "${p.body_part}" is not one the app has; use one of ${BODYPARTS.join(', ')}`)
  const eq = pick(ALL_EQUIPMENT, given(p.equipment) ? p.equipment : 'body weight')
  if (!eq) throw invalid(`equipment "${p.equipment}" is not one the app has; use one of ${ALL_EQUIPMENT.join(', ')}`)
  const vocab = `${MUSCLES.join(', ')} (or the catalogue's words: ${CATALOGUE_TARGETS.join(', ')})`
  let prim
  if (bp === 'cardio') {
    // The form gives a cardio exercise this one pseudo-muscle and no choice.
    prim = ['cardiovascular system']
  } else {
    const tg = muscleSlug(p.target)
    if (!tg) throw invalid(`target "${p.target}" is not a muscle the app can draw; use one of ${vocab}`)
    prim = [tg]
  }
  const secondary = (Array.isArray(p.secondary) ? p.secondary : []).map(m => {
    const slug = muscleSlug(m)
    if (!slug) throw invalid(`secondary "${m}" is not a muscle the app can draw; use one of ${vocab}`)
    return slug
  })
  const sm = inMuscleOrder([...new Set(secondary)].filter(m => !prim.includes(m)))
  const desc = given(p.description) ? String(p.description).trim() : ''
  if (desc.length > 1000) throw invalid('description is longer than 1000 characters')
  const c = {
    id: 'c' + uid(),
    n: name,
    bp,
    desc,
    tg: prim[0],
    sm,
    muscleGroups: [...prim, ...sm],
    primaries: prim,
    secondaries: sm,
    eq,
    custom: true
  }
  S.customEx = [...(Array.isArray(S.customEx) ? S.customEx : []), c]
  return {
    state: S,
    result: {
      exercise_id: c.id,
      name: c.n,
      body_part: c.bp,
      target: c.tg,
      target_name: MUSCLE_NAME[c.tg] || c.tg,
      secondary: c.sm,
      equipment: c.eq,
      mode: bp === 'cardio' ? 'cardio' : 'reps'
    }
  }
}

/* ---------- read helpers ---------- */

export function searchView(S, { query, equipment, body_part, limit } = {}) {
  return withCustomsIndexed(S, () => {
    const lim = Math.min(Math.max(limit || 15, 1), 50)
    const eq = given(equipment) ? String(equipment).trim().toLowerCase() : null
    const bp = given(body_part) ? String(body_part).trim().toLowerCase() : null
    const customIds = new Set((S.customEx || []).map(c => c && c.id))
    const hits = searchExercises(allExercises(S), String(query ?? ''))
      .filter(e => (!eq || String(e.eq || '').toLowerCase() === eq) && (!bp || String(e.bp || '').toLowerCase() === bp))
    return {
      count: hits.length,
      exercises: hits.slice(0, lim).map(e => ({
        id: e.id,
        name: e.n,
        equipment: e.eq || null,
        body_part: e.bp || null,
        target: e.tg || null,
        mode: modeOf({ id: e.id }),
        custom: customIds.has(e.id)
      }))
    }
  })
}

export function dayNotesView(S, { from, to } = {}) {
  const lo = from || shiftDays(-30)
  const hi = to || shiftDays(14)
  const map = S.dayNotes && typeof S.dayNotes === 'object' && !Array.isArray(S.dayNotes) ? S.dayNotes : {}
  const notes = Object.keys(map)
    .filter(iso => iso >= lo && iso <= hi)
    .sort()
    .map(iso => ({ date: iso, note: readDayNote(map[iso]) }))
    .filter(x => x.note)
    .map(x => ({ date: x.date, tag: x.note.tag, text: x.note.text || null }))
  return { from: lo, to: hi, notes }
}

/* ---------- tool definitions ---------- */

// A write handler: the apply function on a fresh copy of the athlete's document, committed
// through the api. Async, unlike the read tools.
const writeHandler = apply => async (params) => {
  const { rev, result } = await commit(S => apply(S, params || {}))
  return { rev, ...result }
}

export const searchExercisesTool = {
  name: 'search_exercises',
  description: 'Search the exercise library (about 5,000 catalogue exercises plus the athlete\'s own custom ones, customs listed first) the way the app\'s picker does. Works before the profile has ever synced (catalogue only, with a note saying so). Use it before naming an exercise in create_routine, edit_routine or log_workout: catalogue names are literal ("barbell full squat", not "back squat") and there are many near twins, so pick an id from here and show the athlete the candidates when it is not obvious. If nothing fits an athletics drill, create_custom_exercise.',
  schema: {
    query: z.string().min(1).describe('Words to search for, e.g. "bench press", "hip thrust", "sprint".'),
    equipment: z.string().optional().describe('Only exercises with this equipment, e.g. "barbell", "dumbbell", "body weight".'),
    body_part: z.string().optional().describe(`Only this body part: ${BODYPARTS.join(', ')}.`),
    limit: z.number().int().min(1).max(50).optional().describe('How many to return, 1 to 50. Defaults to 15.')
  },
  handler: (params) => {
    // The catalogue does not depend on the athlete's document, so a profile that has never
    // synced can still be searched; only its custom exercises are missing.
    const S = getState()
    if (!S) return { ...searchView({}, params || {}), note: 'no synced state yet; custom exercises not included' }
    return searchView(S, params || {})
  }
}

export const getDayNotesTool = {
  name: 'get_day_notes',
  description: 'Read the notes on days: the athlete\'s own (sick, travelling, rest, injured, or a line of text on a day they did not train) and session-intent notes the coach left with set_day_note. Defaults to the last 30 days through the next 14.',
  schema: {
    from: isoDate().optional().describe('Inclusive start date YYYY-MM-DD. Defaults to 30 days ago.'),
    to: isoDate().optional().describe('Inclusive end date YYYY-MM-DD. Defaults to 14 days ahead.')
  },
  handler: (params) => {
    const S = getState()
    if (!S) return noState()
    return dayNotesView(S, params || {})
  }
}

export const createRoutineTool = {
  name: 'create_routine',
  description: 'Create a new routine in the athlete\'s plan (it appears on the Plan screen right away; it is not scheduled on any day until assign_weekday or plan_day). Each exercise is an id or exact name with its prescription. Weights are in the profile unit and are only the starting point: progression and the last session usually decide what the app opens with, so check preview_session before telling the athlete a number. Each exercise may appear once per routine. Returns the routine as get_routine shows it.',
  schema: {
    name: z.string().min(1).max(NAME_MAX).describe('Routine name the athlete sees, e.g. "Sprint day: acceleration".'),
    emoji: z.string().optional().describe(`Icon key: ${GLYPHS.join(', ')}. Defaults to figureStrength.`),
    exercises: z.array(itemSchema).min(1).max(MAX_EX_PER_ROUTINE).describe('The exercises in order (1 to 20).'),
    prog: POLICY_ENUM.optional().describe('Routine-wide progression: off, linear, greyskull, double, triple, time. Omit for the default (linear for rep work). Use off for technique or rehab work you plan by hand.')
  },
  handler: writeHandler(applyCreateRoutine)
}

export const editRoutineTool = {
  name: 'edit_routine',
  description: 'Change an existing routine with a list of operations applied in order, all or nothing: rename, set_emoji, set_policy, add_exercise, remove_exercise, replace_exercise (keeps the slot\'s position and superset), set_targets (only the fields you give change; null clears one), move_exercise, set_superset, clear_superset, set_note. Positions are 1-based as get_routine shows them, and each op sees the routine as the earlier ops left it. The athlete sees the change on the routine and from their next session; history is untouched. Editing a target weight does not force the next session to it when progression has its own reading: check preview_session afterwards.',
  schema: {
    routine_id: z.string().min(1).describe('The routine to change (id from list_routines).'),
    ops: z.array(opSchema).min(1).max(25).describe('Operations, applied in order.')
  },
  handler: writeHandler(applyEditRoutine)
}

export const deleteRoutineTool = {
  name: 'delete_routine',
  description: 'Delete a routine from the plan. It also comes off every weekday and every one-off planned date that named it (those are listed in the result). Logged workouts done with it are kept. There is no undo from here, so confirm with the athlete first.',
  schema: {
    routine_id: z.string().min(1).describe('The routine to delete (id from list_routines).')
  },
  handler: writeHandler(applyDeleteRoutine)
}

export const assignWeekdayTool = {
  name: 'assign_weekday',
  description: 'Set which routines the athlete\'s weekly plan has on one weekday, replacing what that day had. Several routines on one day are a combined session; an empty list makes it a rest day. This is the repeating plan; for one date only use plan_day. If the app is in rotation mode the result carries a warning, since the app then shows the rotation instead (do not try to change the mode from here).',
  schema: {
    weekday: z.union([z.number().int().min(0).max(6), z.string().min(1)]).describe('0-6 with 0 = Sunday (the app\'s numbering), or a name: "mon", "monday", "tue" ...'),
    routine_ids: z.array(z.string().min(1)).max(3).describe('Routine ids for that day, in order (0 to 3). [] makes it a rest day.')
  },
  handler: writeHandler(applyAssignWeekday)
}

export const planDayTool = {
  name: 'plan_day',
  description: 'Plan one date (today or later) differently from the weekly plan: a routine, "rest", or null to go back to the weekly plan. It wins over the weekday plan for that date only, and the app shows the day as rescheduled. To tell the athlete what the session is for, add set_day_note on the same date.',
  schema: {
    date: isoDate().describe('The date, YYYY-MM-DD, today or later.'),
    routine_id: z.string().min(1).nullable().describe('A routine id, "rest" for a planned rest day, or null to clear the override.')
  },
  handler: writeHandler(applyPlanDay)
}

export const setDayNoteTool = {
  name: 'set_day_note',
  description: 'Write the note on a date the athlete sees in the app\'s calendar and week strip: a tag (sick, travel, rest, injured) and/or a line of text up to 500 characters. Use it for session intent ("Speed day: full recovery between reps") or to record why a day was missed. A tagged or noted day is excused from the app\'s missed-workout nudge. Future dates are allowed on purpose for coach instructions, which the app itself does not offer, so keep them to instructions. Giving neither text nor tag clears the note. Replaces any note already on that date: read get_day_notes first if one might be there.',
  schema: {
    date: isoDate().describe('The date, YYYY-MM-DD.'),
    text: z.string().max(NOTE_MAX).optional().describe('The note text, up to 500 characters.'),
    tag: z.enum(DAY_NOTE_TAGS).optional().describe('A quick tag: sick, travel, rest, injured.')
  },
  handler: writeHandler(applySetDayNote)
}

const loggedSetSchema = z.object({
  weight: z.number().min(0).max(1000).optional().describe('Load in the profile unit (added load for bodyweight work). Omit or 0 for bodyweight.'),
  reps: z.number().int().min(0).max(300).optional().describe('Reps done (both sides together for unilateral work).'),
  sec: z.number().int().min(1).max(36000).optional().describe('Seconds, for a timed set.'),
  min: z.number().positive().max(600).optional().describe('Minutes, for a cardio set.'),
  speed: z.number().positive().max(60).optional().describe('Speed, for a cardio set.'),
  rir: z.number().min(0).max(10).optional().describe('Reps in reserve the athlete reported.'),
  rpe: z.number().min(1).max(10).optional().describe('RPE the athlete reported (give rir or rpe, not both).'),
  warmup: z.boolean().optional().describe('A warm-up set: kept, but left out of volume, records and progression.')
})

export const logWorkoutTool = {
  name: 'log_workout',
  description: 'Record a session the athlete did without the app (on the track, at another gym), on today or an earlier date. It appears in History like a session logged in the app, counts for volume, records and the muscle map, and progression reads it next time that exercise comes up, so log what was really done. Name exercises by id or exact name (search_exercises first). Weights are in the profile unit. With routine_id it counts as that routine\'s session.',
  schema: {
    date: isoDate().describe('The day it was done, YYYY-MM-DD, not in the future.'),
    routine_id: z.string().min(1).optional().describe('The routine it was, if any (id from list_routines).'),
    name: z.string().max(NAME_MAX).optional().describe('Session name; defaults to the routine\'s name or "Logged session".'),
    start_time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'must be HH:MM').optional().describe('Local start time HH:MM. Defaults to midday.'),
    duration_min: z.number().int().min(1).max(600).optional().describe('Length in minutes. Defaults to 60.'),
    bodyweight: z.number().min(20).max(400).optional().describe('Body weight that day; defaults to the latest weigh-in.'),
    note: z.string().max(2000).optional().describe('A note on the whole session.'),
    entries: z.array(z.object({
      exercise: z.string().min(1).describe('Exercise id or exact name.'),
      note: z.string().max(NOTE_MAX).optional().describe('A note on this exercise.'),
      sets: z.array(loggedSetSchema).min(1).max(30).describe('The sets, in order. Rep sets give reps (and weight), timed sets sec, cardio min/speed.')
    })).min(1).max(30).describe('What was done, one entry per exercise.')
  },
  handler: writeHandler(applyLogWorkout)
}

export const annotateWorkoutTool = {
  name: 'annotate_workout',
  description: 'Set the note on a logged workout, replacing any note it had (null removes it). The athlete sees it on the session in History. Use it to record the takeaways agreed in a debrief; read the existing note with get_workout first and include what should stay.',
  schema: {
    workout_id: z.string().min(1).describe('The workout id from list_workouts or get_workout.'),
    note: z.string().max(2000).nullable().describe('The note, up to 2000 characters, or null to remove it.')
  },
  handler: writeHandler(applyAnnotateWorkout)
}

export const addBodyweightTool = {
  name: 'add_bodyweight',
  description: 'Record a weigh-in in the profile unit (see `unit`). One per day: a second one on the same date replaces the first (the old value comes back as `previous`). It shows in the app\'s body-weight chart.',
  schema: {
    date: isoDate().optional().describe('The day, YYYY-MM-DD, not in the future. Defaults to today.'),
    weight: z.number().min(20).max(400).describe('Body weight in the profile unit.')
  },
  handler: writeHandler(applyAddBodyweight)
}

export const createCustomExerciseTool = {
  name: 'create_custom_exercise',
  description: 'Add one of the athlete\'s own exercises to the library, for a drill the catalogue lacks (bounding, wicket runs, A-skips). Search first with search_exercises: names must be unique, and a near-identical catalogue exercise keeps its history and muscle data. It then works like any exercise, in routines and logs. Rep-counted unless the body part is cardio; for a timed drill give `sec` when adding it to a routine.',
  schema: {
    name: z.string().min(1).max(NAME_MAX).describe('The name the athlete sees.'),
    body_part: z.string().min(1).describe(`One of: ${BODYPARTS.join(', ')}.`),
    target: z.string().min(1).describe(`The main muscle: ${MUSCLES.join(', ')} (catalogue words like "quads" or "glutes" work too). Ignored for cardio.`),
    equipment: z.string().optional().describe('Equipment, e.g. "body weight" (default), "barbell", "dumbbell", "kettlebell", "band".'),
    secondary: z.array(z.string().min(1)).max(10).optional().describe('Other muscles worked, same vocabulary as target.'),
    description: z.string().max(1000).optional().describe('How to do it; shown on the exercise.')
  },
  handler: writeHandler(applyCreateCustomExercise)
}

export const READ_HELPER_TOOLS = [searchExercisesTool, getDayNotesTool]

export const WRITE_TOOLS = [
  createRoutineTool, editRoutineTool, deleteRoutineTool, assignWeekdayTool, planDayTool,
  setDayNoteTool, logWorkoutTool, annotateWorkoutTool, addBodyweightTool, createCustomExerciseTool
]
