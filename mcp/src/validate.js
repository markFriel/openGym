/* Validation and normalisation for the write tools. Everything a coach sends is someone else's
   input, so it is checked against the same caps the AI coach's plan validator uses
   (api/coach/core/validate.js) and written in the slot shape the app's own plan file writes
   (frontend/src/lib/plan-share.js cleanEx): only meaningful fields, a mode only where the
   catalogue would read it wrong, a weight only when there is one.

   Every failure throws an Error with a `.code` (EINVAL, ENOENT, EAMBIG, ENOMATCH) and a message
   that names the field, so index.js can hand it back to the model as something it can act on. */
import {
  EXIDX, canonicalExId, searchExercises, allExercises, isBodyweightEq, isCardio
} from '../../frontend/src/lib/exercises.js'
import { modeOf, NOTE_MAX, MAX_PLANNED_WARMUPS } from '../../frontend/src/lib/history.js'
import { POLICIES, POLICIES_FOR, MAX_TRIPLE_SETS } from '../../frontend/src/lib/progression.js'
import { ROUTINE_GLYPHS, LEGACY_ROUTINE_GLYPHS, DEFAULT_GLYPH } from '../../api/coach/core/glyphs.js'

/* ---------- caps ---------- */

// The same numbers api/coach/core/validate.js holds a coach's plan to. A prescription, not a
// world record: anything past these is a slip, and it would reach the plan, the progression
// engine and a printed line.
export const CAPS = {
  sets: [1, 10],
  reps: [1, 100],
  sec: [5, 3600],
  min: [1, 180],
  speed: [0, 60],
  weight: [0, 1000],
  inc: [0, 50],
  restSec: [0, 900],
  warmupSets: [0, MAX_PLANNED_WARMUPS],
  setsMax: [1, MAX_TRIPLE_SETS]
}
export const MAX_EX_PER_ROUTINE = 20
export const NAME_MAX = 60
export { NOTE_MAX, POLICIES, POLICIES_FOR }
export const GLYPHS = [...ROUTINE_GLYPHS]

/* ---------- errors ---------- */

export function fail(code, message) {
  const e = new Error(message)
  e.code = code
  return e
}
export const invalid = message => fail('EINVAL', message)

/* ---------- exercises ---------- */

const customById = (S, id) => (Array.isArray(S.customEx) ? S.customEx : []).find(c => c && c.id === id)

// How a candidate reads in an EAMBIG message: enough for the coach to pick one, or to ask.
export const candidateLine = e => `${e.id}  ${e.n}  (${e.eq || 'no equipment'}, ${e.tg || e.bp || 'no target'})`

/**
 * An exercise id (catalogue or custom) or a name, resolved to an id. An id wins outright. A name
 * is searched the way the app's picker searches (customs first); it is taken only when the
 * search leaves no doubt: one hit, or a hit whose name is exactly the query. The catalogue has
 * no "back squat" ('0043' is "barbell full squat") and dozens of near twins, so anything else is
 * an EAMBIG listing the candidates rather than a guess the athlete then trains.
 */
export function resolveExercise(S, ref) {
  const q = String(ref ?? '').trim()
  if (!q) throw invalid('exercise is empty: give an exercise id from search_exercises, or its exact name')
  const id = canonicalExId(q)
  if (customById(S, id) || Object.hasOwn(EXIDX, id)) return id
  // Something shaped like a catalogue id that is not one is a stale or invented id, and
  // searching the text "0999" would only match whatever happens to contain those digits.
  if (/^\d+$/.test(q)) {
    throw fail('ENOMATCH', `no exercise has id "${q}". Look it up with search_exercises.`)
  }
  const hits = searchExercises(allExercises(S), q)
  const lower = q.toLowerCase()
  const exact = hits.find(e => String(e.n || '').trim().toLowerCase() === lower)
  if (exact) return exact.id
  if (hits.length === 1) return hits[0].id
  if (!hits.length) {
    throw fail('ENOMATCH', `no exercise matches "${q}". Try search_exercises with other words, or create_custom_exercise if the athlete does something the catalogue lacks.`)
  }
  const shown = hits.slice(0, 8).map(candidateLine).join('\n')
  throw fail('EAMBIG', `"${q}" matches ${hits.length} exercises; pass one of these ids instead (or ask the athlete which one):\n${shown}${hits.length > 8 ? '\n(more: narrow it with search_exercises)' : ''}`)
}

/* ---------- number checks ---------- */

const isNum = v => typeof v === 'number' && Number.isFinite(v)

function checkInt(v, [lo, hi], where) {
  if (!Number.isInteger(v) || v < lo || v > hi) throw invalid(`${where} must be a whole number from ${lo} to ${hi} (got ${JSON.stringify(v)})`)
}
function checkNum(v, [lo, hi], where, { above = false } = {}) {
  if (!isNum(v) || v < lo || v > hi || (above && v <= lo)) {
    throw invalid(`${where} must be a number ${above ? 'above' : 'from'} ${lo}${above ? ' and at most' : ' to'} ${hi} (got ${JSON.stringify(v)})`)
  }
}

/**
 * The caps on one routine slot as it stands: a slot built from a coach's item, or one a
 * set_targets op just edited. Checks only what the slot's mode reads, so a stray key an older
 * build left behind does not block an unrelated edit.
 */
export function checkSlot(slot, where) {
  const mode = modeOf(slot)
  checkInt(slot.sets, CAPS.sets, `${where}.sets`)
  if (mode === 'reps') {
    if (!Array.isArray(slot.pyramid) || !slot.pyramid.length) checkInt(slot.reps, CAPS.reps, `${where}.reps`)
    if (slot.repsMin != null) {
      checkInt(slot.repsMin, CAPS.reps, `${where}.reps_min`)
      if (isNum(slot.reps) && slot.repsMin > slot.reps) throw invalid(`${where}.reps_min (${slot.repsMin}) is above reps (${slot.reps}); reps is the top of the range and reps_min its bottom`)
    }
    if (slot.repsMax != null) {
      checkInt(slot.repsMax, CAPS.reps, `${where}.reps_max`)
      if (slot.repsMin != null && slot.repsMax < slot.repsMin) throw invalid(`${where}.reps_max (${slot.repsMax}) sets a rep ceiling below its own floor reps_min (${slot.repsMin})`)
    }
    if (slot.setsMax != null) {
      checkInt(slot.setsMax, CAPS.setsMax, `${where}.sets_max`)
      if (slot.setsMax < slot.sets) throw invalid(`${where}.sets_max (${slot.setsMax}) is below sets (${slot.sets})`)
    }
    // Unilateral reps are the total across both sides, so they step in twos.
    if (slot.side && isNum(slot.reps) && slot.reps % 2) throw invalid(`${where}.reps is ${slot.reps} on a per-side exercise: reps are the total across both sides and must be even (8 per side is reps 16)`)
  } else if (mode === 'time') {
    checkInt(slot.sec, CAPS.sec, `${where}.sec`)
  } else {
    checkInt(slot.min, CAPS.min, `${where}.min`)
    checkNum(slot.speed, CAPS.speed, `${where}.speed`, { above: true })
  }
  if (slot.weight != null) checkNum(slot.weight, CAPS.weight, `${where}.weight`)
  if (slot.inc != null) checkNum(slot.inc, CAPS.inc, `${where}.inc`)
  if (slot.restSec != null) checkInt(slot.restSec, CAPS.restSec, `${where}.rest_sec`)
  if (slot.warmupSets != null) checkInt(slot.warmupSets, CAPS.warmupSets, `${where}.warmup_sets`)
  if (slot.note != null && String(slot.note).length > NOTE_MAX) throw invalid(`${where}.note is longer than ${NOTE_MAX} characters`)
  if (slot.prog != null && !POLICIES_FOR[mode].includes(slot.prog)) {
    throw invalid(`${where}.prog "${slot.prog}" cannot drive a ${mode} exercise; use one of ${POLICIES_FOR[mode].join(', ')}`)
  }
  if (mode === 'cardio' && slot.side) throw invalid(`${where}.side does not apply to cardio`)
  return slot
}

/* ---------- items ---------- */

const given = (o, k) => o[k] !== undefined && o[k] !== null

/**
 * A coach's exercise item ({ exercise, sets, reps, ... } in snake_case) as a routine slot. The
 * mode comes from what was given: `sec` is a timed hold, `min`/`speed` is cardio, rep fields are
 * reps; with none of them a cardio exercise keeps the app's cardio default (20 min at 8) and
 * anything else needs `reps`. `superset` is not handled here: create_routine turns shared tags
 * into `sg` once every item is a slot.
 */
export function normaliseItem(S, item, where = 'exercise') {
  if (!item || typeof item !== 'object') throw invalid(`${where} must be an object with at least exercise and sets`)
  let id
  try {
    id = resolveExercise(S, item.exercise)
  } catch (e) {
    e.message = `${where}.exercise: ${e.message}`
    throw e
  }
  const timed = given(item, 'sec')
  const cardio = given(item, 'min') || given(item, 'speed')
  const reps = ['reps', 'reps_min', 'reps_max', 'sets_max'].some(k => given(item, k))
  if ([timed, cardio, reps].filter(Boolean).length > 1) {
    throw invalid(`${where} mixes ways of logging: sec is a timed hold, min/speed is cardio, reps/reps_min/reps_max/sets_max are rep work. Give one of them.`)
  }
  const catalogueCardio = isCardio(id)
  const mode = timed ? 'time' : cardio ? 'cardio' : reps ? 'reps' : catalogueCardio ? 'cardio' : null
  if (!mode) throw invalid(`${where}.reps is required for a rep-counted exercise (or give sec for a timed hold, min for cardio)`)
  if (mode === 'cardio') {
    for (const k of ['weight', 'side', 'warmup_sets', 'bodyweight']) {
      if (given(item, k)) throw invalid(`${where}.${k} does not apply to cardio (logged as minutes at a speed)`)
    }
  }

  const slot = { id, sets: item.sets }
  if (mode === 'cardio') {
    if (!catalogueCardio) slot.mode = 'cardio'
    slot.min = given(item, 'min') ? item.min : 20
    slot.speed = given(item, 'speed') ? item.speed : 8
  } else if (mode === 'time') {
    // Written out even though it could be inferred nowhere: without it a 45-second plank reads
    // as 45 reps (plan-share.js says the same).
    slot.mode = 'time'
    slot.sec = item.sec
    if (item.weight) slot.weight = item.weight
  } else {
    if (catalogueCardio) slot.mode = 'reps'
    slot.reps = item.reps
    if (item.weight) slot.weight = item.weight
    if (given(item, 'reps_min')) slot.repsMin = item.reps_min
    if (given(item, 'reps_max')) slot.repsMax = item.reps_max
    if (given(item, 'sets_max')) slot.setsMax = item.sets_max
  }
  if (given(item, 'weight')) checkNum(item.weight, CAPS.weight, `${where}.weight`)
  // Only when it disagrees with the catalogue, as cleanEx writes it: agreeing is what an absent
  // flag already means.
  if (given(item, 'bodyweight') && !!item.bodyweight !== isBodyweightEq(id)) slot.bodyweight = !!item.bodyweight
  if (item.side) slot.side = true
  if (given(item, 'prog')) slot.prog = item.prog
  if (given(item, 'inc')) {
    checkNum(item.inc, CAPS.inc, `${where}.inc`)
    if (item.inc > 0) slot.inc = item.inc
  }
  if (given(item, 'rest_sec')) {
    checkInt(item.rest_sec, CAPS.restSec, `${where}.rest_sec`)
    if (item.rest_sec > 0) slot.restSec = item.rest_sec
  }
  if (given(item, 'warmup_sets')) {
    checkInt(item.warmup_sets, CAPS.warmupSets, `${where}.warmup_sets`)
    if (item.warmup_sets > 0) slot.warmupSets = item.warmup_sets
  }
  if (given(item, 'note')) {
    const note = String(item.note).trim()
    if (note.length > NOTE_MAX) throw invalid(`${where}.note is longer than ${NOTE_MAX} characters`)
    if (note) slot.note = note
  }
  return checkSlot(slot, where)
}

/* ---------- routines ---------- */

export function cleanName(v, where = 'name') {
  const name = String(v ?? '').trim()
  if (!name) throw invalid(`${where} is empty`)
  if (name.length > NAME_MAX) throw invalid(`${where} is longer than ${NAME_MAX} characters`)
  return name
}

/** A routine icon: one of the app's icon keys (an old emoji-era key is kept as it is). */
export function cleanEmoji(v) {
  if (v == null || v === '') return DEFAULT_GLYPH
  if (ROUTINE_GLYPHS.includes(v) || LEGACY_ROUTINE_GLYPHS.includes(v)) return v
  throw invalid(`emoji "${v}" is not an icon the app has; use one of ${ROUTINE_GLYPHS.join(', ')}`)
}

export function cleanPolicy(v, where = 'prog') {
  if (!POLICIES.includes(v)) throw invalid(`${where} "${v}" is not one of ${POLICIES.join(', ')}`)
  return v
}

/**
 * A routine after an edit, as a whole: a name, 1 to 20 exercises, each exercise once (the app,
 * like the coach validator, has no honest reading of the same exercise twice in one routine:
 * every edit by exercise would land on whichever copy comes first). `touched` limits the per-slot
 * caps to the slots this call wrote; a slot the app wrote is the app's business.
 */
export function validateRoutine(S, r, touched = null) {
  cleanName(r.name, 'routine name')
  const ex = Array.isArray(r.ex) ? r.ex : []
  if (!ex.length) throw invalid(`routine "${r.name}" would have no exercises; a routine needs at least one (delete_routine removes it)`)
  if (ex.length > MAX_EX_PER_ROUTINE) throw invalid(`routine "${r.name}" would have ${ex.length} exercises; the most is ${MAX_EX_PER_ROUTINE}`)
  const seen = new Map()
  ex.forEach((slot, i) => {
    if (seen.has(slot.id)) {
      throw invalid(`exercise ${slot.id} appears twice in "${r.name}" (positions ${seen.get(slot.id) + 1} and ${i + 1}); list each exercise once`)
    }
    seen.set(slot.id, i)
  })
  ex.forEach((slot, i) => {
    if (!touched || touched.has(slot)) checkSlot(slot, `position ${i + 1}`)
  })
  return r
}
