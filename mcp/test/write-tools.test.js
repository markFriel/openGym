// Tests for mcp/src/write-tools.js and mcp/src/validate.js. The apply functions are pure on the
// state they are handed, so most tests call them directly on a clone of the demo state with no
// network. The handler tests swap client.js for a fake commit() that does what the real one does
// to the change itself (apply on a copy, hand back the result) and answers revision 7.
import { describe, beforeAll, afterAll, beforeEach, test, expect, vi } from 'vitest'
import { z } from 'zod'
import { buildDemoState } from '../../frontend/src/lib/demoSeed.js'
import { _seedStateForTests } from '../src/state.js'
import { resolveExercise, normaliseItem } from '../src/validate.js'
import {
  WRITE_TOOLS, READ_HELPER_TOOLS,
  applyCreateRoutine, applyEditRoutine, applyDeleteRoutine, applyAssignWeekday, applyPlanDay,
  applySetDayNote, applyLogWorkout, applyAnnotateWorkout, applyAddBodyweight, applyCreateCustomExercise,
  searchView, dayNotesView, parseWeekday,
  createRoutineTool, editRoutineTool, logWorkoutTool, searchExercisesTool
} from '../src/write-tools.js'

const h = vi.hoisted(() => ({ state: null }))
vi.mock('../src/client.js', () => ({
  commit: vi.fn(async apply => {
    const next = structuredClone(h.state)
    const out = apply(next) || {}
    return { rev: 7, result: out.result }
  })
}))

const FAKE_TODAY_ISO = '2026-07-27'   // a Monday
const BENCH = '0025'                  // barbell bench press
const SQUAT = '0043'                  // barbell full squat
const RUN = '0685'                    // run (cardio)

let S = null

function freshState() {
  const s = buildDemoState()
  s.unit = 'kg'
  return s
}
const clone = () => structuredClone(S)
const routineNamed = (st, name) => st.routines.find(r => r.name === name)

// Runs fn and returns the thrown error, failing the test when nothing is thrown.
function errorOf(fn) {
  try { fn() } catch (e) { return e }
  throw new Error('expected a throw')
}

beforeAll(() => {
  vi.useFakeTimers({ now: new Date(FAKE_TODAY_ISO + 'T12:00:00Z'), toFake: ['Date'] })
})

afterAll(() => {
  vi.useRealTimers()
})

beforeEach(() => {
  S = freshState()
  _seedStateForTests(S)
  h.state = S
})

/* ---------- exercise resolution ---------- */

describe('resolveExercise', () => {
  test('an id resolves to itself, a custom id too', () => {
    expect(resolveExercise(S, BENCH)).toBe(BENCH)
    const st = clone()
    st.customEx = [{ id: 'cabc', n: 'Wicket run', bp: 'upper legs', tg: 'quadriceps', eq: 'body weight', sm: [], custom: true }]
    expect(resolveExercise(st, 'cabc')).toBe('cabc')
    expect(resolveExercise(st, 'wicket run')).toBe('cabc')
  })

  test('an exact name wins even among many hits', () => {
    expect(resolveExercise(S, 'barbell full squat')).toBe(SQUAT)
    expect(resolveExercise(S, 'Barbell Bench Press')).toBe(BENCH)
  })

  test('a vague name is EAMBIG and lists candidate ids', () => {
    const e = errorOf(() => resolveExercise(S, 'back squat'))
    expect(e.code).toBe('EAMBIG')
    const lines = e.message.split('\n').filter(l => /^\S+ {2}/.test(l))
    expect(lines.length).toBe(8)
    expect(lines[0]).toMatch(/^\d+ {2}.+ {2}\(.+, .+\)$/)
  })

  test('no match is ENOMATCH pointing at search and custom exercises', () => {
    const e = errorOf(() => resolveExercise(S, 'zzzqqqxx'))
    expect(e.code).toBe('ENOMATCH')
    expect(e.message).toMatch(/search_exercises/)
    expect(e.message).toMatch(/create_custom_exercise/)
    expect(errorOf(() => resolveExercise(S, '99999')).code).toBe('ENOMATCH')
  })
})

/* ---------- item normalisation ---------- */

describe('normaliseItem', () => {
  test('rep work omits the mode and a zero weight', () => {
    expect(normaliseItem(S, { exercise: BENCH, sets: 3, reps: 5, weight: 0 })).toEqual({ id: BENCH, sets: 3, reps: 5 })
  })

  test('sec makes a timed slot with the mode written out', () => {
    expect(normaliseItem(S, { exercise: SQUAT, sets: 2, sec: 30 })).toEqual({ id: SQUAT, sets: 2, mode: 'time', sec: 30 })
  })

  test('cardio: inferred on a cardio id, explicit elsewhere, reps on a cardio id says so', () => {
    expect(normaliseItem(S, { exercise: RUN, sets: 1 })).toEqual({ id: RUN, sets: 1, min: 20, speed: 8 })
    expect(normaliseItem(S, { exercise: SQUAT, sets: 1, min: 10 })).toEqual({ id: SQUAT, sets: 1, mode: 'cardio', min: 10, speed: 8 })
    expect(normaliseItem(S, { exercise: RUN, sets: 3, reps: 10 })).toMatchObject({ mode: 'reps', reps: 10 })
  })

  test('conflicting and missing fields are EINVAL naming the field', () => {
    expect(errorOf(() => normaliseItem(S, { exercise: BENCH, sets: 3, reps: 5, sec: 30 })).code).toBe('EINVAL')
    const missing = errorOf(() => normaliseItem(S, { exercise: BENCH, sets: 3 }))
    expect(missing.code).toBe('EINVAL')
    expect(missing.message).toMatch(/reps is required/)
    expect(errorOf(() => normaliseItem(S, { exercise: RUN, sets: 1, min: 20, weight: 10 })).message).toMatch(/weight does not apply to cardio/)
  })

  test('caps and ranges', () => {
    expect(errorOf(() => normaliseItem(S, { exercise: BENCH, sets: 11, reps: 5 })).message).toMatch(/sets/)
    expect(errorOf(() => normaliseItem(S, { exercise: BENCH, sets: 3, reps: 8, reps_min: 10 })).message).toMatch(/reps_min/)
    expect(errorOf(() => normaliseItem(S, { exercise: BENCH, sets: 3, reps: 12, reps_min: 8, reps_max: 6 })).message).toMatch(/reps_max/)
    expect(errorOf(() => normaliseItem(S, { exercise: BENCH, sets: 3, reps: 9, side: true })).message).toMatch(/even/)
    expect(errorOf(() => normaliseItem(S, { exercise: BENCH, sets: 3, reps: 5, prog: 'time' })).message).toMatch(/prog "time"/)
    expect(errorOf(() => normaliseItem(S, { exercise: BENCH, sets: 3, reps: 5, weight: 1200 })).message).toMatch(/weight/)
  })

  test('the bodyweight flag is written only when it disagrees with the catalogue', () => {
    expect(normaliseItem(S, { exercise: BENCH, sets: 3, reps: 5, bodyweight: false })).not.toHaveProperty('bodyweight')
    expect(normaliseItem(S, { exercise: BENCH, sets: 3, reps: 5, bodyweight: true }).bodyweight).toBe(true)
  })
})

/* ---------- create_routine ---------- */

describe('create_routine', () => {
  test('creates a routine with a superset and returns the get_routine view', () => {
    const st = clone()
    const before = st.routines.length
    const { state, result } = applyCreateRoutine(st, {
      name: 'Strength A', emoji: 'barbell', prog: 'linear',
      exercises: [
        { exercise: BENCH, sets: 3, reps: 5, weight: 60, superset: 'A' },
        { exercise: 'barbell full squat', sets: 3, reps: 5, superset: 'A', note: 'Brace' },
        { exercise: RUN, sets: 1, min: 15, speed: 10 }
      ]
    })
    expect(state.routines.length).toBe(before + 1)
    const r = state.routines.at(-1)
    expect(r).toMatchObject({ id: result.routine_id, name: 'Strength A', emoji: 'barbell', prog: 'linear' })
    expect(r.ex[0].sg).toBeTruthy()
    expect(r.ex[1].sg).toBe(r.ex[0].sg)
    expect(r.ex[2].sg).toBeUndefined()
    expect(result.routine.unit).toBe('kg')
    expect(result.routine.exercises.map(e => [e.position, e.id, e.mode])).toEqual([[1, BENCH, 'reps'], [2, SQUAT, 'reps'], [3, RUN, 'cardio']])
    expect(result.routine.exercises[0].summary).toBe('3 × 5 · 60 kg')
    expect(result.routine.exercises[0].superset_group).toBe(r.ex[0].sg)
  })

  test('default icon, and an unknown icon is EINVAL listing the keys', () => {
    expect(applyCreateRoutine(clone(), { name: 'X', exercises: [{ exercise: BENCH, sets: 1, reps: 5 }] }).state.routines.at(-1).emoji).toBe('figureStrength')
    expect(errorOf(() => applyCreateRoutine(clone(), { name: 'X', emoji: 'rocket', exercises: [{ exercise: BENCH, sets: 1, reps: 5 }] })).message).toMatch(/figureStrength/)
  })

  test('the same exercise twice is rejected', () => {
    const e = errorOf(() => applyCreateRoutine(clone(), { name: 'Dup', exercises: [{ exercise: BENCH, sets: 3, reps: 5 }, { exercise: 'barbell bench press', sets: 2, reps: 8 }] }))
    expect(e.code).toBe('EINVAL')
    expect(e.message).toMatch(/appears twice/)
  })

  test('superset members must be adjacent and at least two', () => {
    const items = [{ exercise: BENCH, sets: 3, reps: 5, superset: 'A' }, { exercise: SQUAT, sets: 3, reps: 5 }, { exercise: RUN, sets: 1, superset: 'A' }]
    expect(errorOf(() => applyCreateRoutine(clone(), { name: 'S', exercises: items })).message).toMatch(/next to each other/)
    expect(errorOf(() => applyCreateRoutine(clone(), { name: 'S', exercises: [{ exercise: BENCH, sets: 3, reps: 5, superset: 'B' }] })).message).toMatch(/one exercise only/)
  })

  test('an unresolvable exercise names the item it was in', () => {
    const e = errorOf(() => applyCreateRoutine(clone(), { name: 'S', exercises: [{ exercise: BENCH, sets: 3, reps: 5 }, { exercise: 'back squat', sets: 3, reps: 5 }] }))
    expect(e.code).toBe('EAMBIG')
    expect(e.message).toMatch(/^exercises\[1\]\.exercise/)
  })

  test('empty exercises and empty name are EINVAL', () => {
    expect(errorOf(() => applyCreateRoutine(clone(), { name: 'S', exercises: [] })).code).toBe('EINVAL')
    expect(errorOf(() => applyCreateRoutine(clone(), { name: '  ', exercises: [{ exercise: BENCH, sets: 1, reps: 5 }] })).code).toBe('EINVAL')
  })
})

/* ---------- edit_routine ---------- */

describe('edit_routine', () => {
  const push = () => routineNamed(S, 'Push Day')

  test('ops apply in order and the view reflects them', () => {
    const r0 = push()
    const { state, result } = applyEditRoutine(clone(), {
      routine_id: r0.id,
      ops: [
        { op: 'rename', name: 'Push A' },
        { op: 'set_policy', prog: 'double' },
        { op: 'add_exercise', item: { exercise: SQUAT, sets: 2, reps: 10 }, position: 1 },
        { op: 'set_targets', position: 2, reps: 12, reps_min: 8, weight: 70 },
        { op: 'move_exercise', from: 1, to: 3 },
        { op: 'set_note', exercise: 'barbell bench press', note: 'Pause on the chest' }
      ]
    })
    const r = state.routines.find(x => x.id === r0.id)
    expect(result.applied).toBe(6)
    expect(r.name).toBe('Push A')
    expect(r.prog).toBe('double')
    expect(r.ex[0]).toMatchObject({ id: BENCH, reps: 12, repsMin: 8, weight: 70, note: 'Pause on the chest' })
    expect(r.ex[2].id).toBe(SQUAT)
    expect(result.routine.name).toBe('Push A')
    expect(result.routine.exercises[0].reps_min).toBe(8)
    expect(result.routine.exercises.length).toBe(r0.ex.length + 1)
  })

  test('set_targets: null clears, 0 weight removes, a field of another mode is refused', () => {
    const r0 = push()
    const st = clone()
    st.routines.find(x => x.id === r0.id).ex[0].repsMin = 6
    const { state } = applyEditRoutine(st, { routine_id: r0.id, ops: [{ op: 'set_targets', position: 1, reps_min: null, weight: 0 }] })
    const slot = state.routines.find(x => x.id === r0.id).ex[0]
    expect(slot).not.toHaveProperty('repsMin')
    expect(slot).not.toHaveProperty('weight')
    const e = errorOf(() => applyEditRoutine(clone(), { routine_id: r0.id, ops: [{ op: 'set_targets', position: 1, sec: 30 }] }))
    expect(e.code).toBe('EINVAL')
    expect(e.message).toMatch(/logged as reps/)
    expect(errorOf(() => applyEditRoutine(clone(), { routine_id: r0.id, ops: [{ op: 'set_targets', position: 1, reps: null }] })).message).toMatch(/cannot be cleared/)
    expect(errorOf(() => applyEditRoutine(clone(), { routine_id: r0.id, ops: [{ op: 'set_targets', position: 1, reps: 200 }] })).message).toMatch(/reps/)
  })

  test('remove by name, replace keeps the position and the superset', () => {
    const r0 = push()
    const st = clone()
    const ex = st.routines.find(x => x.id === r0.id).ex
    ex[0].sg = 'zz1'; ex[1].sg = 'zz1'
    const second = ex[1].id
    const { state } = applyEditRoutine(st, {
      routine_id: r0.id,
      ops: [
        { op: 'replace_exercise', position: 1, item: { exercise: SQUAT, sets: 5, reps: 5 } },
        { op: 'remove_exercise', exercise: 'lateral raise' }
      ]
    })
    const r = state.routines.find(x => x.id === r0.id)
    expect(r.ex[0]).toMatchObject({ id: SQUAT, sets: 5, reps: 5, sg: 'zz1' })
    expect(r.ex[1]).toMatchObject({ id: second, sg: 'zz1' })
    expect(r.ex.some(e => e.id === BENCH)).toBe(false)
    expect(r.ex.some(e => e.id === '0334')).toBe(false)
    expect(r.ex.length).toBe(r0.ex.length - 1)
  })

  test('a name matching two of the routine\'s exercises is EAMBIG listing positions', () => {
    // Push Day has a flat and an incline bench press.
    const e = errorOf(() => applyEditRoutine(clone(), { routine_id: push().id, ops: [{ op: 'remove_exercise', exercise: 'bench press' }] }))
    expect(e.code).toBe('EAMBIG')
    expect(e.message).toMatch(/position 1: 0025/)
    expect(e.message).toMatch(/position 2: 0047/)
  })

  test('removing a superset partner clears the orphaned tag', () => {
    const r0 = push()
    const st = clone()
    const ex = st.routines.find(x => x.id === r0.id).ex
    ex[0].sg = 'zz1'; ex[1].sg = 'zz1'
    const { state } = applyEditRoutine(st, { routine_id: r0.id, ops: [{ op: 'remove_exercise', position: 2 }] })
    expect(state.routines.find(x => x.id === r0.id).ex[0].sg).toBeUndefined()
  })

  test('set_superset links adjacent positions with a name; clear_superset unlinks', () => {
    const r0 = push()
    const { state } = applyEditRoutine(clone(), { routine_id: r0.id, ops: [{ op: 'set_superset', positions: [3, 2], name: 'Shoulders' }] })
    const ex = state.routines.find(x => x.id === r0.id).ex
    expect(ex[1].sg).toBeTruthy()
    expect(ex[2].sg).toBe(ex[1].sg)
    expect(ex[1].sgName).toBe('Shoulders')
    expect(ex[0].sg).toBeUndefined()
    h.state = state
    const after = applyEditRoutine(structuredClone(state), { routine_id: r0.id, ops: [{ op: 'clear_superset', position: 2 }] }).state
    const ex2 = after.routines.find(x => x.id === r0.id).ex
    expect(ex2[1].sg).toBeUndefined()
    expect(ex2[2].sg).toBeUndefined()
    expect(ex2[2].sgName).toBeUndefined()
  })

  test('set_superset refuses positions that are not adjacent', () => {
    const e = errorOf(() => applyEditRoutine(clone(), { routine_id: push().id, ops: [{ op: 'set_superset', positions: [1, 3] }] }))
    expect(e.message).toMatch(/move_exercise/)
  })

  test('errors: unknown routine, ambiguous ref, missing exercise, duplicate, empty routine', () => {
    const id = push().id
    expect(errorOf(() => applyEditRoutine(clone(), { routine_id: 'nope', ops: [{ op: 'rename', name: 'x' }] })).code).toBe('ENOENT')
    expect(errorOf(() => applyEditRoutine(clone(), { routine_id: id, ops: [{ op: 'set_note', position: 1, exercise: BENCH, note: 'x' }] })).message).toMatch(/exactly one/)
    expect(errorOf(() => applyEditRoutine(clone(), { routine_id: id, ops: [{ op: 'remove_exercise', exercise: SQUAT }] })).code).toBe('ENOENT')
    expect(errorOf(() => applyEditRoutine(clone(), { routine_id: id, ops: [{ op: 'add_exercise', item: { exercise: BENCH, sets: 3, reps: 5 } }] })).message).toMatch(/appears twice/)
    const n = push().ex.length
    const removeAll = Array.from({ length: n }, () => ({ op: 'remove_exercise', position: 1 }))
    expect(errorOf(() => applyEditRoutine(clone(), { routine_id: id, ops: removeAll })).message).toMatch(/no exercises/)
    expect(errorOf(() => applyEditRoutine(clone(), { routine_id: id, ops: [{ op: 'explode' }] })).code).toBe('EINVAL')
  })
})

/* ---------- delete_routine ---------- */

describe('delete_routine', () => {
  test('removes the routine and clears it from the week and the day plan', () => {
    const st = clone()
    const r = routineNamed(st, 'Push Day')
    st.week = { 1: [r.id], 2: [r.id, routineNamed(st, 'Leg Day').id] }
    st.dayPlan = { '2026-07-29': r.id, '2026-07-30': 'rest' }
    const { state, result } = applyDeleteRoutine(st, { routine_id: r.id })
    expect(state.routines.some(x => x.id === r.id)).toBe(false)
    expect(state.week[1]).toBeUndefined()
    expect(state.week[2]).toEqual([routineNamed(st, 'Leg Day').id])
    expect(state.dayPlan).toEqual({ '2026-07-30': 'rest' })
    expect(result).toMatchObject({ deleted: r.id, name: 'Push Day', cleared_days: ['2026-07-29'], cleared_weekdays: ['Monday', 'Tuesday'] })
  })

  test('unknown id is ENOENT', () => {
    expect(errorOf(() => applyDeleteRoutine(clone(), { routine_id: 'nope' })).code).toBe('ENOENT')
  })
})

/* ---------- assign_weekday ---------- */

describe('assign_weekday', () => {
  test('weekday aliases', () => {
    expect(parseWeekday(0)).toBe(0)
    expect(parseWeekday('mon')).toBe(1)
    expect(parseWeekday('Tuesday')).toBe(2)
    expect(parseWeekday('thurs')).toBe(4)
    expect(parseWeekday('6')).toBe(6)
    expect(errorOf(() => parseWeekday('someday')).code).toBe('EINVAL')
    expect(errorOf(() => parseWeekday(7)).code).toBe('EINVAL')
  })

  test('sets a list, replacing a legacy scalar', () => {
    const st = clone()
    const push = routineNamed(st, 'Push Day'), legs = routineNamed(st, 'Leg Day')
    st.week = { 1: push.id }
    const { state, result } = applyAssignWeekday(st, { weekday: 'monday', routine_ids: [legs.id, push.id] })
    expect(state.week[1]).toEqual([legs.id, push.id])
    expect(result).toMatchObject({ weekday: 1, weekday_name: 'Monday', routine_ids: [legs.id, push.id], previous_routine_ids: [push.id] })
    expect(result.routines.map(r => r.name)).toEqual(['Leg Day', 'Push Day'])
    expect(result.warning).toBeUndefined()
  })

  test('an empty list deletes the key', () => {
    const st = clone()
    st.week = { 3: [routineNamed(st, 'Pull Day').id] }
    const { state } = applyAssignWeekday(st, { weekday: 3, routine_ids: [] })
    expect(Object.hasOwn(state.week, '3')).toBe(false)
  })

  test('unknown routine is ENOENT, duplicates and more than 3 are EINVAL', () => {
    const id = routineNamed(S, 'Push Day').id
    expect(errorOf(() => applyAssignWeekday(clone(), { weekday: 1, routine_ids: ['nope'] })).code).toBe('ENOENT')
    expect(errorOf(() => applyAssignWeekday(clone(), { weekday: 1, routine_ids: [id, id] })).code).toBe('EINVAL')
    expect(errorOf(() => applyAssignWeekday(clone(), { weekday: 1, routine_ids: [id, 'a', 'b', 'c'] })).code).toBe('EINVAL')
  })

  test('rotation mode warns and is left alone', () => {
    const st = clone()
    st.scheduleMode = 'rotation'
    const { state, result } = applyAssignWeekday(st, { weekday: 'fri', routine_ids: [routineNamed(st, 'Leg Day').id] })
    expect(result.warning).toMatch(/rotation/)
    expect(state.scheduleMode).toBe('rotation')
  })
})

/* ---------- plan_day ---------- */

describe('plan_day', () => {
  test('plans a routine, a rest day, and clears', () => {
    const legs = routineNamed(S, 'Leg Day')
    let st = applyPlanDay(clone(), { date: '2026-07-28', routine_id: legs.id })
    expect(st.state.dayPlan['2026-07-28']).toBe(legs.id)
    expect(st.result).toMatchObject({ date: '2026-07-28', planned: legs.id, routine_name: 'Leg Day' })
    st = applyPlanDay(st.state, { date: '2026-07-28', routine_id: 'rest' })
    expect(st.state.dayPlan['2026-07-28']).toBe('rest')
    expect(st.result.previous).toBe(legs.id)
    st = applyPlanDay(st.state, { date: '2026-07-28', routine_id: null })
    expect(Object.hasOwn(st.state.dayPlan, '2026-07-28')).toBe(false)
    expect(st.result.planned).toBeNull()
  })

  test('past date, bad date and unknown routine', () => {
    expect(errorOf(() => applyPlanDay(clone(), { date: '2026-07-20', routine_id: 'rest' })).message).toMatch(/past/)
    expect(errorOf(() => applyPlanDay(clone(), { date: '2026-02-30', routine_id: 'rest' })).code).toBe('EINVAL')
    expect(errorOf(() => applyPlanDay(clone(), { date: '2026-07-28', routine_id: 'nope' })).code).toBe('ENOENT')
  })
})

/* ---------- set_day_note / get_day_notes ---------- */

describe('day notes', () => {
  test('sets a tagged note, on a future date too', () => {
    const { state, result } = applySetDayNote(clone(), { date: '2026-07-30', text: '  Speed day: full recovery  ', tag: 'rest' })
    expect(state.dayNotes['2026-07-30']).toMatchObject({ tag: 'rest', text: 'Speed day: full recovery' })
    expect(state.dayNotes['2026-07-30']._ts).toBeGreaterThan(0)
    expect(result).toEqual({ date: '2026-07-30', tag: 'rest', text: 'Speed day: full recovery', cleared: false })
  })

  test('neither text nor tag clears with a stamped empty entry', () => {
    const first = applySetDayNote(clone(), { date: '2026-07-26', text: 'Sick' }).state
    const { state, result } = applySetDayNote(first, { date: '2026-07-26' })
    expect(Object.keys(state.dayNotes['2026-07-26'])).toEqual(['_ts'])
    expect(result).toMatchObject({ tag: null, text: null, cleared: true })
  })

  test('bad tag and long text are EINVAL', () => {
    expect(errorOf(() => applySetDayNote(clone(), { date: '2026-07-26', tag: 'hungover' })).code).toBe('EINVAL')
    expect(errorOf(() => applySetDayNote(clone(), { date: '2026-07-26', text: 'x'.repeat(501) })).code).toBe('EINVAL')
  })

  test('get_day_notes lists notes in range by date and skips cleared ones', () => {
    const st = clone()
    st.dayNotes = {
      '2026-07-20': { tag: 'sick', _ts: 1 },
      '2026-07-10': { text: 'Travel to Leeds', _ts: 1 },
      '2026-07-22': { _ts: 2 },
      '2026-05-01': { text: 'too old', _ts: 1 },
      '2026-08-05': { text: 'Session intent', _ts: 1 }
    }
    const v = dayNotesView(st, {})
    expect(v.notes).toEqual([
      { date: '2026-07-10', tag: null, text: 'Travel to Leeds' },
      { date: '2026-07-20', tag: 'sick', text: null },
      { date: '2026-08-05', tag: null, text: 'Session intent' }
    ])
    expect(dayNotesView(st, { from: '2026-07-15', to: '2026-07-31' }).notes.map(n => n.date)).toEqual(['2026-07-20'])
  })
})

/* ---------- search_exercises ---------- */

describe('search_exercises', () => {
  test('filters by equipment and body part, honours the limit', () => {
    const v = searchView(S, { query: 'bench press', equipment: 'Barbell', limit: 5 })
    expect(v.exercises.length).toBe(5)
    expect(v.count).toBeGreaterThan(5)
    expect(v.exercises.every(e => e.equipment === 'barbell')).toBe(true)
    expect(v.exercises[0]).toMatchObject({ id: BENCH, name: 'barbell bench press', body_part: 'chest', mode: 'reps', custom: false })
    expect(searchView(S, { query: 'run', body_part: 'cardio' }).exercises.every(e => e.body_part === 'cardio' && e.mode === 'cardio')).toBe(true)
  })

  test('custom exercises are searched and flagged', () => {
    const st = clone()
    st.customEx = [{ id: 'cw1', n: 'wicket run', bp: 'upper legs', tg: 'quadriceps', eq: 'body weight', sm: [], custom: true }]
    const v = searchView(st, { query: 'wicket' })
    expect(v.exercises[0]).toMatchObject({ id: 'cw1', name: 'wicket run', custom: true })
    expect(searchView(st, { query: 'run' }).exercises.some(e => e.id === 'cw1')).toBe(true)
  })

  test('a profile that never synced still searches the catalogue, without customs', () => {
    _seedStateForTests(null)
    const v = searchExercisesTool.handler({ query: 'bench press', equipment: 'barbell', limit: 3 })
    expect(v.error).toBeUndefined()
    expect(v.note).toBe('no synced state yet; custom exercises not included')
    expect(v.exercises.length).toBe(3)
    expect(v.exercises[0]).toMatchObject({ id: BENCH, custom: false })
  })
})

/* ---------- log_workout ---------- */

describe('log_workout', () => {
  test('builds a workout with topW and volume excluding warm-ups, filed in date order', () => {
    const st = clone()
    const legs = routineNamed(st, 'Leg Day')
    const { state, result } = applyLogWorkout(st, {
      date: '2026-07-25', routine_id: legs.id, start_time: '07:30', duration_min: 45, note: 'Track session',
      entries: [
        { exercise: SQUAT, note: 'Felt quick', sets: [{ weight: 100, reps: 5, warmup: true }, { weight: 80, reps: 5, rir: 2 }, { weight: 80, reps: 5, rpe: 8 }] },
        { exercise: RUN, sets: [{ min: 12, speed: 14 }] },
        { exercise: 'barbell bench press', sets: [{ sec: 30, weight: 20 }] }
      ]
    })
    const w = state.workouts.find(x => x.id === result.workout_id)
    expect(w).toMatchObject({ d: '2026-07-25', routineIds: [legs.id], routineId: legs.id, name: 'Leg Day', note: 'Track session' })
    expect(w.end - w.start).toBe(45 * 60000)
    expect(new Date(w.start).getHours()).toBe(7)
    expect(w.entries[0]).toMatchObject({ id: SQUAT, rid: legs.id, topW: 80, note: 'Felt quick' })
    expect(w.entries[0].sets[0]).toEqual({ w: 100, r: 5, done: true, phase: 'warmup' })
    expect(w.entries[0].sets[1]).toEqual({ w: 80, r: 5, done: true, rir: 2 })
    expect(w.entries[1].sets[0]).toEqual({ min: 12, speed: 14, done: true })
    expect(w.entries[1].topW).toBeNull()
    expect(w.entries[2].target).toEqual({ mode: 'time' })
    expect(w.vol).toBe(800)
    expect(w._ts).toBeGreaterThan(0)
    // Filed by date: everything before it is dated on or before the 25th, everything after later.
    const at = state.workouts.indexOf(w)
    expect(state.workouts.slice(0, at).every(x => x.d <= '2026-07-25')).toBe(true)
    expect(state.workouts.slice(at + 1).every(x => x.d > '2026-07-25' || (x.d === '2026-07-25' && x.start >= w.start))).toBe(true)
    expect(result).toMatchObject({ date: '2026-07-25', name: 'Leg Day', exercises: 3, sets: 5, volume: 800, unit: 'kg', duration_min: 45 })
    expect(result.entries[0].sets[1]).toMatch(/80/)
  })

  test('defaults: name, bodyweight from the latest weigh-in, today ends by now', () => {
    const st = clone()
    const { state, result } = applyLogWorkout(st, { date: FAKE_TODAY_ISO, entries: [{ exercise: BENCH, sets: [{ weight: 60, reps: 5 }] }] })
    const w = state.workouts.find(x => x.id === result.workout_id)
    expect(w.name).toBe('Logged session')
    expect(w.routineIds).toEqual([])
    expect(w.routineId).toBeNull()
    expect(w.end).toBeLessThanOrEqual(Date.now())
    const latest = [...st.bodyweight].filter(b => b.d <= FAKE_TODAY_ISO).sort((a, b) => a.d.localeCompare(b.d)).at(-1)
    expect(w.bw).toBe(latest.w)
  })

  test('rejects a future date, a start time that ends in the future, mixed modes, an unknown routine', () => {
    expect(errorOf(() => applyLogWorkout(clone(), { date: '2026-07-28', entries: [{ exercise: BENCH, sets: [{ reps: 5 }] }] })).message).toMatch(/future/)
    expect(errorOf(() => applyLogWorkout(clone(), { date: FAKE_TODAY_ISO, start_time: '23:30', entries: [{ exercise: BENCH, sets: [{ reps: 5 }] }] })).message).toMatch(/ends in the future/)
    expect(errorOf(() => applyLogWorkout(clone(), { date: '2026-07-25', entries: [{ exercise: BENCH, sets: [{ reps: 5 }, { sec: 30 }] }] })).message).toMatch(/mix/)
    expect(errorOf(() => applyLogWorkout(clone(), { date: '2026-07-25', entries: [{ exercise: BENCH, sets: [{ reps: 5, rir: 1, rpe: 9 }] }] })).message).toMatch(/both rir and rpe/)
    expect(errorOf(() => applyLogWorkout(clone(), { date: '2026-07-25', entries: [{ exercise: BENCH, sets: [{ weight: 50 }] }] })).message).toMatch(/logs nothing/)
    expect(errorOf(() => applyLogWorkout(clone(), { date: '2026-07-25', routine_id: 'nope', entries: [{ exercise: BENCH, sets: [{ reps: 5 }] }] })).code).toBe('ENOENT')
    expect(errorOf(() => applyLogWorkout(clone(), { date: '2026-07-25', entries: [{ exercise: 'back squat', sets: [{ reps: 5 }] }] })).code).toBe('EAMBIG')
  })
})

/* ---------- annotate_workout ---------- */

describe('annotate_workout', () => {
  test('sets and clears the note, stamping the workout', () => {
    const id = S.workouts.at(-1).id
    const { state, result } = applyAnnotateWorkout(clone(), { workout_id: id, note: ' Hips sluggish; deload next week ' })
    const w = state.workouts.find(x => x.id === id)
    expect(w.note).toBe('Hips sluggish; deload next week')
    expect(w._ts).toBe(Date.now())
    expect(result).toMatchObject({ workout_id: id, note: 'Hips sluggish; deload next week' })
    const cleared = applyAnnotateWorkout(state, { workout_id: id, note: null })
    expect(cleared.state.workouts.find(x => x.id === id)).not.toHaveProperty('note')
    expect(cleared.result.note).toBeNull()
  })

  test('unknown id is ENOENT, a long note EINVAL', () => {
    expect(errorOf(() => applyAnnotateWorkout(clone(), { workout_id: 'nope', note: 'x' })).code).toBe('ENOENT')
    expect(errorOf(() => applyAnnotateWorkout(clone(), { workout_id: S.workouts[0].id, note: 'x'.repeat(2001) })).code).toBe('EINVAL')
  })
})

/* ---------- add_bodyweight ---------- */

describe('add_bodyweight', () => {
  test('upserts the same day and keeps the list sorted', () => {
    const st = clone()
    st.bodyweight = [{ d: '2026-07-20', w: 79, t: 1 }, { d: '2026-07-27', w: 78.3, t: 1 }]
    let out = applyAddBodyweight(st, { weight: 78.1 })
    expect(out.result).toMatchObject({ date: FAKE_TODAY_ISO, weight: 78.1, unit: 'kg', previous: 78.3 })
    expect(out.state.bodyweight.length).toBe(2)
    out = applyAddBodyweight(out.state, { date: '2026-07-23', weight: 78.6 })
    expect(out.state.bodyweight.map(b => b.d)).toEqual(['2026-07-20', '2026-07-23', '2026-07-27'])
    expect(out.result).not.toHaveProperty('previous')
    expect(out.state.bodyweight[1].t).toBe(Date.now())
  })

  test('future dates and silly weights are EINVAL', () => {
    expect(errorOf(() => applyAddBodyweight(clone(), { date: '2026-07-28', weight: 78 })).code).toBe('EINVAL')
    expect(errorOf(() => applyAddBodyweight(clone(), { weight: 4 })).code).toBe('EINVAL')
  })
})

/* ---------- create_custom_exercise ---------- */

describe('create_custom_exercise', () => {
  test('stores the shape the app form writes and is then resolvable', () => {
    const { state, result } = applyCreateCustomExercise(clone(), { name: 'Wicket runs', body_part: 'Upper Legs', target: 'quads', secondary: ['Glutes', 'calves', 'quadriceps'], description: 'Mini hurdles, quick contacts' })
    const c = state.customEx.at(-1)
    expect(c).toMatchObject({ n: 'Wicket runs', bp: 'upper legs', tg: 'quadriceps', primaries: ['quadriceps'], sm: ['gluteal', 'calves'], secondaries: ['gluteal', 'calves'], muscleGroups: ['quadriceps', 'gluteal', 'calves'], eq: 'body weight', desc: 'Mini hurdles, quick contacts', custom: true })
    expect(c.id).toMatch(/^c/)
    expect(result).toMatchObject({ exercise_id: c.id, name: 'Wicket runs', body_part: 'upper legs', target: 'quadriceps', equipment: 'body weight' })
    expect(resolveExercise(state, 'wicket runs')).toBe(c.id)
    expect(applyCreateRoutine(state, { name: 'Drills', exercises: [{ exercise: c.id, sets: 3, sec: 20 }] }).result.routine.exercises[0].name).toBe('Wicket runs')
  })

  test('cardio takes the cardio pseudo-muscle', () => {
    expect(applyCreateCustomExercise(clone(), { name: 'Hill sprints', body_part: 'cardio', target: 'anything' }).result.target).toBe('cardiovascular system')
  })

  test('vocabulary errors list the allowed values', () => {
    expect(errorOf(() => applyCreateCustomExercise(clone(), { name: 'X1', body_part: 'legs', target: 'quads' })).message).toMatch(/upper legs/)
    expect(errorOf(() => applyCreateCustomExercise(clone(), { name: 'X1', body_part: 'upper legs', target: 'quads', equipment: 'hurdle' })).message).toMatch(/barbell/)
    expect(errorOf(() => applyCreateCustomExercise(clone(), { name: 'X1', body_part: 'upper legs', target: 'spleen' })).message).toMatch(/quadriceps/)
    expect(errorOf(() => applyCreateCustomExercise(clone(), { name: 'X1', body_part: 'upper legs', target: 'quads', secondary: ['spleen'] })).code).toBe('EINVAL')
  })

  test('a name that already exists is EINVAL naming its id', () => {
    const e = errorOf(() => applyCreateCustomExercise(clone(), { name: 'Barbell Bench Press', body_part: 'chest', target: 'chest' }))
    expect(e.code).toBe('EINVAL')
    expect(e.message).toMatch(BENCH)
  })
})

/* ---------- handlers through a fake commit ---------- */

describe('handlers', () => {
  const byName = Object.fromEntries([...WRITE_TOOLS, ...READ_HELPER_TOOLS].map(t => [t.name, t.handler]))
  const call = (name, params) => byName[name](params)

  test('every write tool is registered with a schema and a description', () => {
    expect(WRITE_TOOLS.map(t => t.name)).toEqual([
      'create_routine', 'edit_routine', 'delete_routine', 'assign_weekday', 'plan_day',
      'set_day_note', 'log_workout', 'annotate_workout', 'add_bodyweight', 'create_custom_exercise'
    ])
    expect(READ_HELPER_TOOLS.map(t => t.name)).toEqual(['search_exercises', 'get_day_notes'])
    for (const t of [...WRITE_TOOLS, ...READ_HELPER_TOOLS]) {
      expect(t.description.length).toBeGreaterThan(80)
      expect(t.description).not.toMatch(/\u2014/)
      expect(typeof t.schema).toBe('object')
    }
  })

  test('create_routine', async () => {
    const out = await call('create_routine', { name: 'H', exercises: [{ exercise: BENCH, sets: 3, reps: 5 }] })
    expect(out.rev).toBe(7)
    expect(out.routine.name).toBe('H')
    expect(out.routine_id).toBe(out.routine.id)
  })

  test('edit_routine', async () => {
    const out = await call('edit_routine', { routine_id: routineNamed(S, 'Push Day').id, ops: [{ op: 'rename', name: 'Push B' }] })
    expect(out).toMatchObject({ rev: 7, applied: 1 })
    expect(out.routine.name).toBe('Push B')
  })

  test('delete_routine', async () => {
    const out = await call('delete_routine', { routine_id: routineNamed(S, 'Pull Day').id })
    expect(out).toMatchObject({ rev: 7, name: 'Pull Day' })
  })

  test('assign_weekday', async () => {
    const out = await call('assign_weekday', { weekday: 'sat', routine_ids: [routineNamed(S, 'Leg Day').id] })
    expect(out).toMatchObject({ rev: 7, weekday: 6, weekday_name: 'Saturday' })
  })

  test('plan_day', async () => {
    expect(await call('plan_day', { date: '2026-07-29', routine_id: 'rest' })).toMatchObject({ rev: 7, date: '2026-07-29', planned: 'rest' })
  })

  test('set_day_note', async () => {
    expect(await call('set_day_note', { date: '2026-07-29', tag: 'travel' })).toMatchObject({ rev: 7, tag: 'travel' })
  })

  test('log_workout', async () => {
    const out = await call('log_workout', { date: '2026-07-26', entries: [{ exercise: BENCH, sets: [{ weight: 50, reps: 10 }] }] })
    expect(out).toMatchObject({ rev: 7, date: '2026-07-26', volume: 500, unit: 'kg' })
  })

  test('annotate_workout', async () => {
    const id = S.workouts[0].id
    expect(await call('annotate_workout', { workout_id: id, note: 'Good' })).toMatchObject({ rev: 7, workout_id: id, note: 'Good' })
  })

  test('add_bodyweight', async () => {
    expect(await call('add_bodyweight', { weight: 77.9 })).toMatchObject({ rev: 7, date: FAKE_TODAY_ISO, weight: 77.9, unit: 'kg' })
  })

  test('create_custom_exercise', async () => {
    expect(await call('create_custom_exercise', { name: 'A-skips', body_part: 'upper legs', target: 'hip-flexors' })).toMatchObject({ rev: 7, name: 'A-skips', target: 'hip-flexors' })
  })

  test('a validation error propagates with its code', async () => {
    await expect(call('plan_day', { date: '2026-07-29', routine_id: 'nope' })).rejects.toMatchObject({ code: 'ENOENT' })
  })

  test('read helpers answer from the seeded state', () => {
    expect(call('search_exercises', { query: 'barbell bench press' }).exercises[0].id).toBe(BENCH)
    expect(call('get_day_notes', {})).toMatchObject({ notes: expect.any(Array) })
  })
})

/* ---------- schemas ---------- */

describe('schemas', () => {
  test('create_routine accepts a realistic payload and rejects a bad one', () => {
    const schema = z.object(createRoutineTool.schema)
    expect(schema.safeParse({
      name: 'Sprint day: acceleration', emoji: 'figureRun', prog: 'off',
      exercises: [
        { exercise: 'barbell full squat', sets: 4, reps: 4, weight: 90, rest_sec: 180, warmup_sets: 2, note: 'Fast out of the hole' },
        { exercise: '0685', sets: 1, min: 10, speed: 9 },
        { exercise: 'plank', sets: 3, sec: 45, superset: 'A' }
      ]
    }).success).toBe(true)
    expect(schema.safeParse({ name: 'x', exercises: [{ exercise: BENCH, sets: 0, reps: 5 }] }).success).toBe(false)
    expect(schema.safeParse({ name: 'x', exercises: [] }).success).toBe(false)
  })

  test('edit_routine ops are a discriminated union', () => {
    const schema = z.object(editRoutineTool.schema)
    expect(schema.safeParse({
      routine_id: 'r1',
      ops: [
        { op: 'set_targets', position: 2, reps: 6, weight: null },
        { op: 'add_exercise', item: { exercise: BENCH, sets: 3, reps: 5 }, position: 1 },
        { op: 'set_superset', positions: [1, 2], name: 'Pair' },
        { op: 'set_note', exercise: 'bench', note: null }
      ]
    }).success).toBe(true)
    expect(schema.safeParse({ routine_id: 'r1', ops: [{ op: 'explode' }] }).success).toBe(false)
    expect(schema.safeParse({ routine_id: 'r1', ops: [{ op: 'move_exercise', from: 0, to: 1 }] }).success).toBe(false)
  })

  test('log_workout rejects a malformed start time and an impossible date', () => {
    const schema = z.object(logWorkoutTool.schema)
    const ok = { date: '2026-07-25', entries: [{ exercise: BENCH, sets: [{ weight: 60, reps: 5, rir: 2 }] }] }
    expect(schema.safeParse(ok).success).toBe(true)
    expect(schema.safeParse({ ...ok, start_time: '7:30' }).success).toBe(false)
    expect(schema.safeParse({ ...ok, date: '2026-02-30' }).success).toBe(false)
  })
})
