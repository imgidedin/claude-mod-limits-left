import { atom, read, update } from 'claude-code'
import type { EngineInterface, ModelUsage, Register, RenderElement, RenderInput, SessionRateLimit } from 'claude-code'

import type { DeviceState, Hourly, LimitWindow, Peer, Sample, Spend, Spent, Windows } from '../types'

// Left to right: the 5-hour window, then the weekly one.
const KINDS = ['five_hour', 'seven_day'] as const

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR
const SPANS = [
  { label: '15m', title: 'Últimos 15 min', ms: 15 * MINUTE },
  { label: '30m', title: 'Últimos 30 min', ms: 30 * MINUTE },
  { label: '1h', title: 'Última hora', ms: HOUR },
] as const

// A working day, in minutes after local midnight.
export type WorkHours = { start: number; end: number }
export const DEFAULT_WORK: WorkHours = { start: 8 * 60, end: 18 * 60 }

// `8-18` or `08:30-17:45`, as the option is written; the default where it does not read as a day.
export const workHours = (text: unknown): WorkHours => {
  const match = typeof text === 'string' ? /^\s*(\d{1,2})(?::(\d{2}))?\s*-\s*(\d{1,2})(?::(\d{2}))?\s*$/.exec(text) : null
  if (match === null) return DEFAULT_WORK
  const start = Number(match[1]) * 60 + Number(match[2] ?? 0)
  const end = Number(match[3]) * 60 + Number(match[4] ?? 0)

  return start < end && end <= 24 * 60 ? { start, end } : DEFAULT_WORK
}

const clock = (minutes: number): string => {
  const m = minutes % 60

  return m === 0 ? `${Math.floor(minutes / 60)}h` : `${Math.floor(minutes / 60)}h${String(m).padStart(2, '0')}`
}

// A stretch the cards count what went in: its short label, its title, and its ends.
export type Range = { label: string; title: string; from: number; to: number }

// The last 15 minutes, 30 minutes and hour; the working day, today's once it began and
// yesterday's before; and the last 24 hours. Local time, as the person reads a clock.
export const ranges = (at: number, work: WorkHours = DEFAULT_WORK): Range[] => {
  const midnight = new Date(at)
  midnight.setHours(0, 0, 0, 0)
  const startToday = new Date(midnight).setMinutes(work.start)
  const isToday = at >= startToday
  const day = new Date(midnight)
  if (!isToday) day.setDate(day.getDate() - 1)
  const from = new Date(day).setMinutes(work.start)
  const to = Math.min(at, new Date(day).setMinutes(work.end))
  const hours = `${clock(work.start)}–${clock(work.end)}`

  return [
    ...SPANS.map(({ label, title, ms }) => ({ label, title, from: at - ms, to: at })),
    { label: hours, title: `${isToday ? 'Hoje' : 'Ontem'}, ${hours}`, from, to },
    { label: '24h', title: 'Últimas 24 horas', from: at - DAY, to: at },
  ]
}

// The shortest stretch of history a pace is estimated from.
const MIN_PACE_MS = 30 * MINUTE
// How far back a window's pace looks, and so how much of its history is kept: an hour says
// little about a week.
const HISTORY: Record<string, number> = { five_hour: HOUR, seven_day: DAY }
const historyOf = (kind: string): number => HISTORY[kind] ?? HOUR
// Turns older than an hour are kept in entries this far apart, a day of them.
const OLD_ENTRY_MS = 10 * MINUTE
const STORE_KEY = 'windows'
// Its own key: a session still running the mod as it was reads windows alone and keeps it whole.
const SPEND_KEY = 'spend'
// A reading is a whole number, so the turns never fill in more than the point it is in.
const MAX_FRACTION = 0.9
// What a token costs beside an uncached input one, as the API prices them.
const OUTPUT_WEIGHT = 5
const CACHE_WRITE_WEIGHT = 1.25
const CACHE_READ_WEIGHT = 0.1
const EARLY_MS = 30 * MINUTE
const WEEKLY_POINTS_A_DAY = 15

// Claude in a panic holding up a stop sign, on a 26 by 13 pixel grid with a pixel of room around
// it to move in: he trembles and stomps, waves the sign, flails the other arm, and sweats.
const PANIC_W = 45
const PANIC_H = 24
const PANIC_ALT = 'ritmo acima do limite'
const PANIC_SVG = [
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="-1 -1 28 15" shape-rendering="crispEdges">',
  '<style>',
  '.sign{transform-origin:4px 13px;animation:wave .5s ease-in-out infinite}',
  '.body{animation:shake .16s steps(1) infinite}',
  '.la{animation:stomp .32s steps(1) infinite}.lb{animation:stomp .32s steps(1) infinite -.16s}',
  '.arm{transform-origin:22px 5px;animation:flail .32s steps(1) infinite}',
  '.eyes{animation:dart .64s steps(1) infinite}',
  '.s1{animation:drip .8s linear infinite}.s2{animation:drip .8s linear infinite -.4s}',
  '@keyframes wave{0%,100%{transform:rotate(-9deg)}50%{transform:rotate(7deg)}}',
  '@keyframes shake{50%{transform:translateX(.5px)}}',
  '@keyframes stomp{50%{transform:translateY(-1px)}}',
  '@keyframes flail{50%{transform:rotate(35deg)}}',
  '@keyframes dart{25%{transform:translateX(-1px)}75%{transform:translateX(1px)}}',
  '@keyframes drip{0%{transform:translateY(-1px);opacity:1}100%{transform:translateY(4px);opacity:0}}',
  '@media (prefers-reduced-motion: reduce){*{animation:none!important}}',
  '</style>',
  '<rect x="5" y="8" width="5" height="1" fill="#D97757"/>',
  '<g class="sign">',
  '<rect x="3.5" y="7" width="1" height="6" fill="#8A8A8A"/>',
  '<polygon points="2,0 6,0 8,2 8,5 6,7 2,7 0,5 0,2" fill="#D92D20"/>',
  '<polygon points="2.4,1 5.6,1 7,2.4 7,4.6 5.6,6 2.4,6 1,4.6 1,2.4" fill="none" stroke="#FFFFFF" stroke-width="0.5"/>',
  '<rect x="3" y="7.5" width="2" height="2" fill="#D97757"/>',
  '</g>',
  '<g class="arm"><rect x="22" y="1" width="1" height="4" fill="#D97757"/><rect x="22" y="1" width="2" height="1" fill="#D97757"/></g>',
  '<g class="body">',
  '<g class="la"><rect x="11" y="10" width="1" height="2" fill="#D97757"/><rect x="18" y="10" width="1" height="2" fill="#D97757"/></g>',
  '<g class="lb"><rect x="13" y="10" width="1" height="2" fill="#D97757"/><rect x="20" y="10" width="1" height="2" fill="#D97757"/></g>',
  '<rect x="10" y="3" width="12" height="7" fill="#D97757"/>',
  '<rect x="12" y="4" width="3" height="3" fill="#FFFFFF"/><rect x="17" y="4" width="3" height="3" fill="#FFFFFF"/>',
  '<g class="eyes"><rect x="13" y="5" width="1" height="1" fill="#1F1E1D"/><rect x="18" y="5" width="1" height="1" fill="#1F1E1D"/></g>',
  '<rect x="15" y="8" width="2" height="2" fill="#1F1E1D"/>',
  '</g>',
  '<g class="s1"><rect x="24" y="5" width="1" height="2" fill="#4AA8E8"/></g>',
  '<g class="s2"><rect x="8" y="1" width="1" height="2" fill="#4AA8E8"/></g>',
  '</svg>',
].join('')

const windows = atom({ plugin: 'limits-left', key: 'windows' } as const, {} as Windows)
const now = atom({ plugin: 'limits-left', key: 'now' } as const, 0)
// Whether the cards are up in the band above the prompt: a press on either footer button
// flips it, and so does /limits.
const isOpen = atom({ plugin: 'limits-left', key: 'isOpen' } as const, false)
export const NO_SPEND: Spend = { total: 0, events: [], marks: {}, perPoint: {} }
const spend = atom({ plugin: 'limits-left', key: 'spend' } as const, NO_SPEND)
// What this session's cost ledger stood at when last measured; -1 until the first measurement,
// which sets where the counting starts.
const seenUsd = atom({ plugin: 'limits-left', key: 'seenUsd' } as const, -1)
// The desktop's button has no padding of its own and takes none: no-break spaces stand in.
const PAD = '\u00A0\u00A0'
const COMMAND = 'limits'

const round1 = (n: number): number => Math.round(n * 10) / 10

// Adds a reading, keeping one sample a minute, the two ends alone of a run of equal readings,
// and nothing older than the one that anchors the last `keep`.
export const record = (samples: readonly Sample[], t: number, used: number, keep: number = HOUR): Sample[] => {
  const last = samples.at(-1)
  if (last === undefined) return [{ t, used }]
  // The window reset: what came before says nothing about it.
  if (used < last.used - 1) return [{ t, used }]
  // Another session's newer reading is already in; a slightly older one adds nothing.
  if (used < last.used) return [...samples]

  const before = samples.at(-2)
  const isRun = before !== undefined && before.used === last.used && last.used === used
  const head = before !== undefined && (t - before.t < MINUTE || isRun) ? samples.slice(0, -1) : samples
  const firstInside = head.findIndex(s => s.t >= t - keep)
  const from = firstInside === -1 ? head.length - 1 : Math.max(0, firstInside - 1)

  return [...head.slice(from), { t, used }]
}

// What was used at `at`, read between the samples around it; undefined before the history starts.
const usedAt = (samples: readonly Sample[], at: number): number | undefined => {
  const after = samples.findIndex(s => s.t > at)
  if (after === 0) return undefined
  const prev = samples[after === -1 ? samples.length - 1 : after - 1]
  const next = after === -1 ? undefined : samples[after]
  if (prev === undefined) return undefined
  if (next === undefined) return prev.used

  return prev.used + ((next.used - prev.used) * (at - prev.t)) / (next.t - prev.t)
}

// Points of the window used between two times; undefined where the history does not reach.
const usedBetween = (samples: readonly Sample[], from: number, to: number): number | undefined => {
  const base = usedAt(samples, from)
  const last = usedAt(samples, to)

  return base === undefined || last === undefined ? undefined : Math.max(0, round1(last - base))
}

// Points of the window used in the `span` before `at`.
export const usedIn = (samples: readonly Sample[], at: number, span: number): number | undefined => {
  const last = samples.at(-1)
  const base = usedAt(samples, at - span)

  return last === undefined || base === undefined ? undefined : Math.max(0, round1(last.used - base))
}

const duration = (ms: number): string => {
  const minutes = Math.max(1, Math.round(ms / MINUTE))
  const d = Math.floor(minutes / 1440)
  const h = Math.floor((minutes % 1440) / 60)
  const m = minutes % 60
  if (d > 0) return `${d}d${h}h`

  return h > 0 ? `${h}h${String(m).padStart(2, '0')}` : `${m}min`
}

// Points of the window used per millisecond over its history, or over what there is of it;
// undefined while that is too little to say. Where the weight of a point is known the turns
// give it, since they move with every turn and a reading only a whole point at a time.
const pace = (kind: string, window: LimitWindow, at: number, held: Spend): number | undefined => {
  const perPoint = held.perPoint[kind]
  if (perPoint !== undefined && held.since !== undefined) {
    const span = Math.min(historyOf(kind), at - held.since)
    if (span >= MIN_PACE_MS) return spentIn(held, at, span).weight / perPoint / span
  }

  const { samples } = window
  const first = samples[0]
  const last = samples.at(-1)
  if (first === undefined || last === undefined) return undefined

  const span = Math.min(historyOf(kind), at - first.t)
  if (span < MIN_PACE_MS) return undefined

  // One point turning says when it turned, not how fast the window goes.
  const from = at - span
  const rises = samples.filter((s, i) => i > 0 && s.t > from && s.used > (samples[i - 1]?.used ?? s.used)).length
  if (rises === 1 && span < HOUR) return undefined

  return Math.max(0, last.used - (usedAt(samples, from) ?? last.used)) / span
}

const left = (window: LimitWindow): number => Math.max(0, 100 - (window.samples.at(-1)?.used ?? 0))

// Adds a turn to the count, keeping one entry a minute and the last hour of them.
export const spendTurn = (held: Spend, t: number, usage: ModelUsage): Spend => {
  // Shown without what the cache served: every step reads the whole conversation back from it.
  const tokens = usage.input_tokens + usage.output_tokens + usage.cache_creation_input_tokens
  const weight =
    usage.input_tokens +
    usage.output_tokens * OUTPUT_WEIGHT +
    usage.cache_creation_input_tokens * CACHE_WRITE_WEIGHT +
    usage.cache_read_input_tokens * CACHE_READ_WEIGHT
  const events = addSpent(held.events, { t, tokens, weight })
  const total = held.total + weight
  const hours = addHourly(held.hours ?? [], t, weight)

  return {
    ...held,
    since: held.since ?? t,
    total,
    own: (held.own ?? held.total) + weight,
    events,
    hours,
    hoursSince: held.hoursSince ?? t,
    perPoint: atLeastSinceMark(held, total),
  }
}

// How long the hours are kept: four of each day of the week.
const PROFILE_DAYS = 28
const hourOf = (t: number): number => Math.floor(t / HOUR) * HOUR

const addHourly = (hours: readonly Hourly[], t: number, weight: number): Hourly[] => {
  const hour = hourOf(t)
  const kept = hours.filter(h => h.t > t - PROFILE_DAYS * DAY)
  const last = kept.at(-1)

  return last !== undefined && last.t === hour ? [...kept.slice(0, -1), { t: hour, weight: last.weight + weight }] : [...kept, { t: hour, weight }]
}

// The person's week as their hours taught it: for each hour of a weekday and of a weekend day,
// in local time, the weight they spend in it on average. Each machine is averaged over the hours
// since it began counting them, an hour with nothing on record being an hour not used, and the
// machines add up. Undefined before any machine has a whole day on record.
export type Profile = { weekday: number[]; weekend: number[] }
type DayType = keyof Profile

const isWeekend = (t: number): boolean => {
  const day = new Date(t).getDay()

  return day === 0 || day === 6
}

// How many days of its own a kind of day needs before its average counts as much as the one of
// every day seen: one heavy Friday must not stand for every weekday to come.
const PRIOR_DAYS = 3

// One machine's averages: each hour of a kind of day is that kind's average, drawn toward the
// average of every day seen at that hour while it has few days of its own.
const machineWeek = (hours: readonly Hourly[], since: number, end: number): Profile => {
  const from = Math.max(hourOf(since) + HOUR, end - PROFILE_DAYS * DAY)
  const byHour = new Map(hours.filter(h => h.t >= from && h.t < end).map(h => [h.t, h.weight]))
  const sums: Record<DayType, number[]> = { weekday: new Array(24).fill(0), weekend: new Array(24).fill(0) }
  const counts: Record<DayType, number[]> = { weekday: new Array(24).fill(0), weekend: new Array(24).fill(0) }
  for (let t = from; t < end; t += HOUR) {
    const type: DayType = isWeekend(t) ? 'weekend' : 'weekday'
    const hour = new Date(t).getHours()
    sums[type][hour] = (sums[type][hour] ?? 0) + (byHour.get(t) ?? 0)
    counts[type][hour] = (counts[type][hour] ?? 0) + 1
  }
  const estimate = (type: DayType, other: DayType) =>
    sums[type].map((sum, hour) => {
      const count = counts[type][hour] ?? 0
      const seen = count + (counts[other][hour] ?? 0)
      if (seen === 0) return 0
      const pooled = (sum + (sums[other][hour] ?? 0)) / seen

      return (sum + PRIOR_DAYS * pooled) / (count + PRIOR_DAYS)
    })

  return { weekday: estimate('weekday', 'weekend'), weekend: estimate('weekend', 'weekday') }
}

export const profile = (held: Spend, at: number): Profile | undefined => {
  const end = hourOf(at)
  const machines = [
    { hours: held.hours ?? [], since: held.hoursSince },
    ...Object.values(held.peers ?? {}).map(peer => ({ hours: peer.hours ?? [], since: peer.since })),
  ].filter((m): m is { hours: Hourly[]; since: number } => m.since !== undefined)
  if (!machines.some(m => end - (hourOf(m.since) + HOUR) >= DAY)) return undefined

  const weeks = machines.map(m => machineWeek(m.hours, m.since, end))
  const add = (type: DayType) => new Array(24).fill(0).map((_, hour) => weeks.reduce((sum, week) => sum + (week[type][hour] ?? 0), 0))

  return { weekday: add('weekday'), weekend: add('weekend') }
}

// When the weekly window runs out, walking hour by hour from now to its reset: the pace of the
// last hour carries the hour now and fades over the next few, and the person's week does the
// rest. Undefined where it cannot say: no week learned yet, or no known weight of a point.
// How far past the reset the walk goes to say how long what is left would last.
const LASTS_HORIZON = 28 * DAY

export const runsOutAt = (kind: string, window: LimitWindow, at: number, held: Spend, isPastReset = false): { at: number } | 'never' | undefined => {
  const perPoint = held.perPoint[kind]
  const week = profile(held, at)
  if (perPoint === undefined || week === undefined) return undefined

  let leftWeight = Math.max(0, left(window) - (fraction(held, kind) ?? 0)) * perPoint
  const reset = resetsIn(window, at)
  const until = at + (isPastReset ? LASTS_HORIZON : Number.isNaN(reset) ? 7 * DAY : reset)
  const now = spentIn(held, at, HOUR).weight
  let t = at
  for (let ahead = 0; t < until; ahead++) {
    const next = Math.min(until, hourOf(t) + HOUR)
    const hour = new Date(t).getHours()
    const usual = (isWeekend(t) ? week.weekend : week.weekday)[hour] ?? 0
    const carried = 0.5 ** ahead
    const perHour = carried * now + (1 - carried) * usual
    const spent = (perHour * (next - t)) / HOUR
    // To the minute: the fading pace leaves fractions of a millisecond nobody reads.
    if (spent >= leftWeight) return { at: Math.round((t + (perHour === 0 ? 0 : (leftWeight / perHour) * HOUR)) / MINUTE) * MINUTE }
    leftWeight -= spent
    t = next
  }

  return 'never'
}

// Two entries as one, at the first one's time; the dollars only where either has them.
const joinSpent = (a: Spent, b: Spent): Spent => {
  const joined = { t: a.t, tokens: a.tokens + b.tokens, weight: a.weight + b.weight }

  return a.usd === undefined && b.usd === undefined ? joined : { ...joined, usd: (a.usd ?? 0) + (b.usd ?? 0) }
}

// Adds an entry, keeping the last hour a minute apart, for the cards' spans, and the rest of
// the day further apart.
const addSpent = (events: readonly Spent[], entry: Spent): Spent[] => {
  const recent = events
    .filter(event => event.t > entry.t - DAY)
    .reduce<Spent[]>((kept, event) => {
      const prev = kept.at(-1)
      if (prev === undefined || event.t > entry.t - HOUR || event.t - prev.t >= OLD_ENTRY_MS) return [...kept, event]

      return [...kept.slice(0, -1), joinSpent(prev, event)]
    }, [])
  const last = recent.at(-1)

  return last !== undefined && entry.t - last.t < MINUTE ? [...recent.slice(0, -1), joinSpent(last, entry)] : [...recent, entry]
}

// What a session's ledger grew by goes on the minute it was measured in, beside the tokens.
export const spendCost = (held: Spend, t: number, usd: number): Spend =>
  usd <= 0 ? held : { ...held, events: addSpent(held.events, { t, tokens: 0, weight: 0, usd }) }

// What the other machines did since the last sync goes on the count as this machine's turns
// do; a machine seen for the first time adds its last day to the spans and nothing to the total.
export const takePeers = (held: Spend, devices: Readonly<Record<string, Peer>>, self: string, at: number): Spend => {
  let total = held.total
  const peers: Record<string, Peer> = {}
  for (const [device, peer] of Object.entries(devices)) {
    if (device === self) continue
    const seen = held.peers?.[device]
    if (seen !== undefined) total += Math.max(0, peer.own - seen.own)
    peers[device] = {
      own: peer.own,
      events: peer.events.filter(event => event.t > at - DAY),
      hours: (peer.hours ?? []).filter(h => h.t > at - PROFILE_DAYS * DAY),
      ...(peer.since === undefined ? {} : { since: peer.since }),
    }
  }

  return { ...held, total, peers, perPoint: atLeastSinceMark(held, total) }
}

// Every machine's readings of the windows as one history, as `record` keeps it.
export const mergeWindows = (all: readonly Windows[]): Windows => {
  const merged: Windows = {}
  for (const kind of new Set(all.flatMap(windows => Object.keys(windows)))) {
    const held = all.flatMap(windows => (windows[kind] === undefined ? [] : [windows[kind]]))
    const samples = held
      .flatMap(window => window.samples)
      .sort((a, b) => a.t - b.t)
      .reduce<Sample[]>((kept, s) => record(kept, s.t, s.used, historyOf(kind)), [])
    // The reset is the one the newest reading came with.
    const newest = held.reduce((a, b) => ((b.samples.at(-1)?.t ?? 0) > (a.samples.at(-1)?.t ?? 0) ? b : a))
    merged[kind] = newest.resetsAt === undefined ? { samples } : { samples, resetsAt: newest.resetsAt }
  }

  return merged
}

// A point takes at least what went by since its reading turned and it has not turned again:
// the count misses usage outside the mod's sessions, so a point it measured can come out short,
// and the turns would then be read as several points where the reading moved one.
const atLeastSinceMark = (held: Spend, total: number): Record<string, number> =>
  Object.fromEntries(
    Object.entries(held.perPoint).map(([kind, perPoint]) => {
      const mark = held.marks[kind]

      return [kind, mark === undefined ? perPoint : Math.max(perPoint, total - mark)]
    }),
  )

// Otherwise the weekly window's readings say what a point takes better than any one point does: the
// weight every machine spent over the last day of readings, over the points they rose. A point
// seen turning by one machine was spent by all of them, so one machine's own turns alone made
// it look cheap. Needs six hours and four points of rise; the 5-hour window keeps an hour of
// readings, too little, and keeps the turns' measure.
const CALIBRATE_MS = 6 * HOUR
const CALIBRATE_POINTS = 4

// The surest measure: the weight every machine spent hour by hour since the weekly window began,
// over the points it stands at. Only where every machine that spent in the week was counting
// its hours from before the week began, and four points into it.
const weekPerPoint = (held: Spend, window: LimitWindow | undefined): number | undefined => {
  const used = window?.samples.at(-1)?.used
  const reset = window?.resetsAt === undefined ? Number.NaN : Date.parse(window.resetsAt)
  if (used === undefined || used < CALIBRATE_POINTS || Number.isNaN(reset)) return undefined
  const began = reset - 7 * DAY
  const machines = [
    { hours: held.hours ?? [], since: held.hoursSince },
    ...Object.values(held.peers ?? {}).map(peer => ({ hours: peer.hours ?? [], since: peer.since })),
  ]
  let weight = 0
  for (const machine of machines) {
    const spent = machine.hours.filter(h => h.t >= hourOf(began))
    if (spent.length === 0) continue
    if (machine.since === undefined || machine.since > began) return undefined
    weight += spent.reduce((sum, h) => sum + h.weight, 0)
  }

  return weight > 0 ? weight / used : undefined
}

export const calibrate = (held: Spend, windows: Windows, at: number): Spend => {
  const week = weekPerPoint(held, windows.seven_day)
  if (week !== undefined) {
    const known = held.perPoint.seven_day

    return known !== undefined && Math.abs(known - week) < known * 0.01 ? held : { ...held, perPoint: { ...held.perPoint, seven_day: week } }
  }
  const samples = windows.seven_day?.samples ?? []
  const first = samples[0]
  if (first === undefined || at - first.t < CALIBRATE_MS) return held
  const from = Math.max(first.t, at - DAY)
  const rose = usedBetween(samples, from, at)
  if (rose === undefined || rose < CALIBRATE_POINTS) return held
  const { weight } = spentBetween(held, from, at)
  if (weight <= 0) return held
  const perPoint = weight / rose
  const known = held.perPoint.seven_day

  return known !== undefined && Math.abs(known - perPoint) < known * 0.01 ? held : { ...held, perPoint: { ...held.perPoint, seven_day: perPoint } }
}

// A window's reading went from one whole number to another: up, the turns since the last
// time say what a point takes, and the count starts again; down, the window reset.
export const turnPoint = (held: Spend, kind: string, from: number, to: number): Spend => {
  const { [kind]: mark, ...otherMarks } = held.marks
  if (to < from) return { ...held, marks: otherMarks }
  if (to === from) return held

  const marks = { ...held.marks, [kind]: held.total }
  const measured = mark === undefined ? 0 : (held.total - mark) / (to - from)
  if (measured <= 0) return { ...held, marks }

  const known = held.perPoint[kind]

  return { ...held, marks, perPoint: { ...held.perPoint, [kind]: known === undefined ? measured : (known + measured) / 2 } }
}

// How far into its current point the turns since it began put a window; undefined until a
// point was seen from one end to the other.
export const fraction = (held: Spend, kind: string): number | undefined => {
  const mark = held.marks[kind]
  const perPoint = held.perPoint[kind]
  if (mark === undefined || perPoint === undefined) return undefined

  return Math.min(MAX_FRACTION, Math.floor(((held.total - mark) / perPoint) * 10) / 10)
}

const spentIn = (held: Spend, at: number, span: number): { tokens: number; weight: number } => spentBetween(held, at - span, at)

const allSpent = (held: Spend): Spent[] => [...held.events, ...Object.values(held.peers ?? {}).flatMap(peer => peer.events)]

const spentBetween = (held: Spend, from: number, to: number): { tokens: number; weight: number; usd: number } =>
  allSpent(held)
    .filter(event => event.t > from && event.t <= to)
    .reduce(
      (sum, event) => ({ tokens: sum.tokens + event.tokens, weight: sum.weight + event.weight, usd: sum.usd + (event.usd ?? 0) }),
      { tokens: 0, weight: 0, usd: 0 },
    )

// Dollars as the status line writes them: cents below a hundred, whole dollars above.
const dollars = (usd: number): string => (usd < 100 ? `$${usd.toFixed(2)}` : `$${Math.round(usd)}`)

const compact = (tokens: number): string => {
  if (tokens < 1000) return String(tokens)
  if (tokens < 100_000) return `${round1(tokens / 1000)}k`
  if (tokens < 1_000_000) return `${Math.round(tokens / 1000)}k`

  return `${round1(tokens / 1_000_000)}M`
}

const resetsIn = (window: LimitWindow, at: number): number =>
  window.resetsAt === undefined ? Number.NaN : Date.parse(window.resetsAt) - at

// What the pace of the last hour does to what is left: fine, or out before the reset.
// `lastsMs`, where it is known, is how long what is left would last at that pace, past the reset.
export type Outlook = { state: 'collecting' | 'out' } | { state: 'ok'; lastsMs?: number } | { state: 'runsOut'; inMs: number }

export const outlook = (kind: string, window: LimitWindow, at: number, held: Spend = NO_SPEND): Outlook => {
  if (left(window) === 0) return { state: 'out' }
  if (kind === 'seven_day') {
    const out = runsOutAt(kind, window, at, held)
    if (out === 'never') {
      const lasts = runsOutAt(kind, window, at, held, true)

      return lasts === undefined || lasts === 'never' ? { state: 'ok' } : { state: 'ok', lastsMs: lasts.at - at }
    }
    if (out !== undefined) return { state: 'runsOut', inMs: out.at - at }
  }
  const rate = pace(kind, window, at, held)
  if (rate === undefined) return { state: 'collecting' }
  if (left(window) === 0) return { state: 'out' }
  if (rate === 0) return { state: 'ok' }

  const lastsMs = left(window) / rate

  return lastsMs >= resetsIn(window, at) ? { state: 'ok', lastsMs } : { state: 'runsOut', inMs: lastsMs }
}

// Beside the check: how long what is left would last at this pace; nothing where it is not known.
export const lasting = (kind: string, window: LimitWindow, at: number, held: Spend = NO_SPEND): string => {
  const o = outlook(kind, window, at, held)

  return o.state === 'ok' && o.lastsMs !== undefined ? `dura ~${duration(o.lastsMs)}` : ''
}

export const forecast = (kind: string, window: LimitWindow, at: number, held: Spend = NO_SPEND): string => {
  const o = outlook(kind, window, at, held)
  if (o.state === 'ok') return '✓'
  if (o.state === 'collecting') return 'coletando dados'
  if (o.state === 'runsOut') return `esgota em ~${duration(o.inMs)}`

  return 'esgotado'
}

// The 5-hour window warns when it runs out more than half an hour before it resets; the weekly
// one when the person's week runs it out before it resets, or, before a week is learned, when a
// day at that pace takes more than 15 points and it runs out before it resets.
export const isOverPace = (kind: string, window: LimitWindow, at: number, held: Spend = NO_SPEND): boolean => {
  if (kind === 'seven_day') {
    const out = runsOutAt(kind, window, at, held)
    if (out !== undefined) return out !== 'never'
  }
  const rate = pace(kind, window, at, held)
  if (rate === undefined || rate === 0) return false

  const lastsMs = left(window) / rate
  const untilReset = resetsIn(window, at)
  // With no reset on record the pace alone decides.
  if (kind === 'seven_day') return rate * DAY > WEEKLY_POINTS_A_DAY && !(lastsMs >= untilReset)

  return lastsMs < untilReset - EARLY_MS
}

const TITLES: Record<string, string> = { five_hour: 'Limite de sessão · 5h', seven_day: 'Semanal · 7d' }
// How long the warning's toast stays up.
const WARNING_MS = 10_000

const SHORT_TITLES: Record<string, string> = { five_hour: '5h', seven_day: '7d' }

// What the toast says when a reading puts a window over its pace; the app puts the mod's name
// before it, so it is kept short.
export const warning = (kind: string, window: LimitWindow, at: number, held: Spend = NO_SPEND): string =>
  `${SHORT_TITLES[kind] ?? kind} acima do ritmo · ${forecast(kind, window, at, held)}`

const usedOf = (window: LimitWindow): number => round1(100 - left(window))

// What is used with the turns' fraction of the current point on it, marked as the estimate it is.
const usedLabel = (kind: string, window: LimitWindow, held: Spend): string => {
  const part = fraction(held, kind)

  return part === undefined ? `${usedOf(window)}%` : `~${round1(usedOf(window) + part)}%`
}

const resetLine = (window: LimitWindow, at: number): string => {
  const untilReset = resetsIn(window, at)

  return untilReset > 0 ? `Reinicia em ${duration(untilReset)}` : ''
}

// The ranges' rows, in their order: the points of the window and, once a turn is on record,
// the tokens (`~0.4% · 182k`). The points are the turns' estimate where a point's weight is
// known, the readings' otherwise: a dash where the history does not reach, and `<1%` where
// tokens went and the whole-number reading did not move.
export type Row = Range & { points: string; tokens?: string; cost?: string; figure: string }

const spanFigures = (kind: string, window: LimitWindow, at: number, held: Spend, work?: WorkHours): Row[] => {
  const hasCost = allSpent(held).some(event => event.usd !== undefined)

  return ranges(at, work).map(range => {
    const { tokens, weight, usd } = spentBetween(held, range.from, range.to)
    const perPoint = held.perPoint[kind]
    const used = range.to <= range.from ? 0 : usedBetween(window.samples, range.from, range.to)
    // The 5-hour window resets inside a working day or a day: no share of it there.
    const isBeyondWindow = kind === 'five_hour' && !SPANS.some(span => span.label === range.label)
    const points = isBeyondWindow
      ? '–'
      : perPoint !== undefined
        ? `~${round1(weight / perPoint)}%`
        : used === undefined
          ? '–'
          : used === 0 && tokens > 0
            ? '<1%'
            : `${used}%`

    // The tokens once a turn is on record, and the dollars once a ledger has reported any: none
    // at all reads as a host that keeps none.
    const counted = held.total === 0 ? undefined : compact(tokens)
    const cost = hasCost ? dollars(usd) : undefined

    return { ...range, points, tokens: counted, cost, figure: [points, counted, cost].filter(part => part !== undefined).join(' · ') }
  })
}

// One line of it all, for a reader that cannot see the card.
export const details = (kind: string, window: LimitWindow, at: number, held: Spend = NO_SPEND, work?: WorkHours): string =>
  [
    `${TITLES[kind] ?? kind}: ${usedLabel(kind, window, held)} usado`,
    resetLine(window, at),
    ...spanFigures(kind, window, at, held, work).map(row => `${row.label} ${row.figure}`),
    forecast(kind, window, at, held),
  ]
    .filter(part => part !== '')
    .join(' · ')


const isSpend = (value: unknown): value is Spend =>
  typeof value === 'object' &&
  value !== null &&
  typeof (value as Spend).total === 'number' &&
  Array.isArray((value as Spend).events) &&
  typeof (value as Spend).marks === 'object' &&
  typeof (value as Spend).perPoint === 'object'

const isWindows = (value: unknown): value is Windows =>
  typeof value === 'object' &&
  value !== null &&
  Object.values(value).every(w => typeof w === 'object' && w !== null && Array.isArray((w as LimitWindow).samples))

// A tree a plugin drew, as against the engine's own answer for an empty band.
const isDrawn = (element: RenderElement): boolean =>
  element.type === 'Box' && element.children !== undefined && element.children.length > 0

// A clock for the 5-hour window and a calendar for the weekly one. The footer draws text
// alone, so they are characters: on the desktop the emoji's outline form, which the text
// selector after it asks for, and plain glyphs on the terminal.
const ICONS: Record<string, { emoji: string; glyph: string }> = {
  five_hour: { emoji: '🕐︎', glyph: '◷' },
  seven_day: { emoji: '📅︎', glyph: '▦' },
}

type Shown = { kind: string; window: LimitWindow; left: number }

// The windows there is a reading of, in KINDS' order, and the time they are read at.
const gather = async ($: EngineInterface): Promise<{ shown: Shown[]; at: number; held: Spend }> => {
  const held = await read($, windows)
  const at = await read($, now)
  const spent = await read($, spend)
  // The reading is a whole point behind the app's own figure once the turns are past half of
  // the point it is in, so what is left counts them too, rounded as the app rounds what is used.
  const shown = KINDS.flatMap(kind => {
    const window = held[kind]
    if (window === undefined || window.samples.length === 0) return []

    return [{ kind, window, left: Math.max(0, 100 - Math.round(usedOf(window) + (fraction(spent, kind) ?? 0))) }]
  })

  return { shown, at, held: spent }
}

// One window in the footer: its icon, what is left of it, and a mark where it is over pace.
export const footerLabel = ({ kind, window, left }: Shown, at: number, isTerminal: boolean, held: Spend = NO_SPEND): string => {
  const icon = ICONS[kind]
  const mark = isOverPace(kind, window, at, held) ? (isTerminal ? ' ⚠' : ' 🛑') : ''

  return `${icon === undefined ? '' : `${isTerminal ? icon.glyph : icon.emoji} `}${left}%${mark}`
}

// What the store holds now, every session's readings and turns, and the time to read them at.
const refresh = async ($: EngineInterface): Promise<void> => {
  const stored = await $.store.get(STORE_KEY)
  const spent = await $.store.get(SPEND_KEY)
  const t = await $.clock.now()
  if (isWindows(stored)) await update($, windows, () => stored)
  if (isSpend(spent)) await update($, spend, () => spent)
  await update($, now, () => t)
}

// How often a machine syncs with the server, whichever of its sessions does it.
const SYNC_MS = 5 * MINUTE
const DEVICE_KEY = 'device'
const SYNCED_KEY = 'syncedAt'

export type SyncOptions = { url: string; token: string }

// The server and its key from the plugin's options; no sync until both are set.
export const syncOptions = (options: unknown): SyncOptions | undefined => {
  const set = (typeof options === 'object' && options !== null ? options : {}) as Record<string, unknown>
  const url = typeof set.syncUrl === 'string' ? set.syncUrl.trim().replace(/\/+$/, '') : ''
  const token = typeof set.syncToken === 'string' ? set.syncToken.trim() : ''

  return url === '' || token === '' ? undefined : { url, token }
}

const isDevices = (value: unknown): value is Record<string, DeviceState> =>
  typeof value === 'object' &&
  value !== null &&
  Object.values(value).every(
    device =>
      typeof device === 'object' &&
      device !== null &&
      typeof (device as DeviceState).own === 'number' &&
      Array.isArray((device as DeviceState).events) &&
      isWindows((device as DeviceState).windows),
  )

// Sends this machine's own turns and readings to the server and takes up the other machines'.
// The sessions of a machine share the store, so one of them does it every SYNC_MS.
export const sync = async ($: EngineInterface, remote: SyncOptions, isDue: boolean = false): Promise<void> => {
  const t = await $.clock.now()
  const last = await $.store.get(SYNCED_KEY)
  if (!isDue && typeof last === 'number' && t - last < SYNC_MS) return
  await $.store.set(SYNCED_KEY, t)

  const stored = await $.store.get(DEVICE_KEY)
  const device = typeof stored === 'string' ? stored : `${Math.random().toString(36).slice(2, 10)}${t.toString(36)}`
  if (device !== stored) await $.store.set(DEVICE_KEY, device)

  const sent = await $.store.get(SPEND_KEY)
  const sentWindows = await $.store.get(STORE_KEY)
  const mine: Spend = isSpend(sent) ? sent : NO_SPEND
  const state: DeviceState = {
    own: mine.own ?? mine.total,
    events: mine.events,
    windows: isWindows(sentWindows) ? sentWindows : {},
    hours: mine.hours ?? [],
    ...(mine.hoursSince === undefined ? {} : { since: mine.hoursSince }),
  }
  const response = await $.http.fetch(`${remote.url}/v1/sync`, {
    method: 'POST',
    headers: { authorization: `Bearer ${remote.token}`, 'content-type': 'application/json', 'user-agent': 'limits-left' },
    body: JSON.stringify({ device, ...state }),
  })
  if (!response.ok) throw new Error(`o servidor respondeu ${response.status}`)
  const answer = JSON.parse(response.text) as { devices?: unknown }
  if (!isDevices(answer.devices)) throw new Error('o servidor respondeu algo que não é a lista de máquinas')
  const others = Object.entries(answer.devices).filter(([id]) => id !== device)

  // Read again: a turn or a reading may have landed while the request was out.
  const spent = await $.store.get(SPEND_KEY)
  const held = await $.store.get(STORE_KEY)
  const before: Windows = isWindows(held) ? held : {}
  const merged = mergeWindows([before, ...others.map(([, other]) => other.windows)])
  let counted = takePeers(isSpend(spent) ? spent : NO_SPEND, Object.fromEntries(others), device, t)
  // A point another machine saw turn is a point turned here too.
  for (const kind of KINDS) {
    const from = before[kind]?.samples.at(-1)?.used
    const to = merged[kind]?.samples.at(-1)?.used
    if (from !== undefined && to !== undefined && to !== from) counted = turnPoint(counted, kind, from, to)
  }
  counted = calibrate(counted, merged, t)

  await $.store.set(STORE_KEY, merged)
  await $.store.set(SPEND_KEY, counted)
  await update($, windows, () => merged)
  await update($, spend, () => counted)
}

// The person's own notification where a terminal takes it; a toast where none does, as on the
// desktop, which has no terminal to write it to.
const warn = async ($: EngineInterface, text: string): Promise<void> => {
  const sent = await $.ui.notify(text).catch(() => undefined)
  if (sent?.isSent !== true) $.ui.toast(text, { timeoutMs: WARNING_MS })
}

// A figure such as `<1%` is text in the table's markup, not a tag.
const escapeXml = (text: string): string => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

const FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif"
const TABLE_CSS = `<style>
text{font-family:${FONT};font-size:12px;font-variant-numeric:tabular-nums}
.bg{fill:#fff;stroke:#deddd9}.t{fill:#1f1f1f}.s{fill:#6b6b68}.k{fill:#ecebe8}.ln{stroke:#e8e7e3}
.bar{fill:#2c7be5}.ok{stroke:#2e9e5b}.good{fill:#2e9e5b}.bad{fill:#d92d20}
@media (prefers-color-scheme: dark){.bg{fill:#262624;stroke:#3d3d3a}.t{fill:#ececec}.s{fill:#a8a8a4}.k{fill:#3a3a38}.ln{stroke:#383836}.ok{stroke:#4cc38a}.good{fill:#4cc38a}.bad{fill:#f97066}}
</style>`

// One window's column of the table.
export type TableWindow = {
  title: string
  used: string
  lasts: string
  usedShare: number
  reset: string
  points: string[]
  isOk: boolean
  isCollecting: boolean
  forecast: string
}

// Pixels of the table a pixel surface draws: its margin, the periods' titles, then a column per
// window and the tokens and dollars, each one's figures flush to its right.
const EDGE_PX = 14
const TITLE_PX = 118
const WINDOW_PX = 112
const TOKEN_PX = 64
const COST_PX = 70
const ROW_PX = 20

// One table, a column per window and, where `shared` has them, the tokens and dollars of each
// period, which are the account's and so one column for all.
export const tableSvg = (windows: readonly TableWindow[], titles: readonly string[], shared?: { tokens: string[]; cost?: string[] }): string => {
  const extra =
    shared === undefined
      ? []
      : [{ head: 'Tokens', width: TOKEN_PX, cells: shared.tokens }, ...(shared.cost === undefined ? [] : [{ head: 'Custo', width: COST_PX, cells: shared.cost }])]
  const width = EDGE_PX * 2 + TITLE_PX + windows.length * WINDOW_PX + extra.reduce((sum, c) => sum + c.width, 0)
  const windowRight = (i: number) => EDGE_PX + TITLE_PX + (i + 1) * WINDOW_PX
  const extraRight = (i: number) => windowRight(windows.length - 1) + extra.slice(0, i + 1).reduce((sum, c) => sum + c.width, 0)
  // The rule under the resets is each window's bar where it runs under that window's column.
  const ruleTopY = 58
  const rowsY = 80
  const ruleY = rowsY + titles.length * ROW_PX - 8
  const height = ruleY + 32
  const text = (cls: string, x: number, y: number, body: string, anchor = 'end', weight = '') =>
    `<text class="${cls}" x="${x}" y="${y}" text-anchor="${anchor}"${weight === '' ? '' : ` font-weight="${weight}"`}>${escapeXml(body)}</text>`

  const parts = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`,
    TABLE_CSS,
    `<rect class="bg" x=".5" y=".5" width="${width - 1}" height="${height - 1}" rx="10"/>`,
    text('s', EDGE_PX, 46, 'Reinicia em', 'start'),
    `<line class="ln" x1="${EDGE_PX}" y1="${ruleTopY}" x2="${width - EDGE_PX}" y2="${ruleTopY}"/>`,
    ...titles.map((title, r) => text('s', EDGE_PX, rowsY + r * ROW_PX, title, 'start')),
    `<line class="ln" x1="${EDGE_PX}" y1="${ruleY}" x2="${width - EDGE_PX}" y2="${ruleY}"/>`,
    text('s', EDGE_PX, ruleY + 19, 'No ritmo atual', 'start'),
  ]
  windows.forEach((w, i) => {
    const x = windowRight(i)
    const barWidth = WINDOW_PX - 16
    parts.push(
      `<text x="${x}" y="24" text-anchor="end"><tspan class="s">${escapeXml(w.title)}  </tspan><tspan class="t" font-weight="600">${escapeXml(w.used)}</tspan></text>`,
      text('s', x, 46, w.reset),
      `<rect class="k" x="${x - barWidth}" y="${ruleTopY - 1.5}" width="${barWidth}" height="3" rx="1.5"/>`,
      `<rect class="bar" x="${x - barWidth}" y="${ruleTopY - 1.5}" width="${round1((barWidth * Math.min(100, w.usedShare)) / 100)}" height="3" rx="1.5"/>`,
      ...w.points.map((point, r) => text('t', x, rowsY + r * ROW_PX, point)),
      ...(w.isOk
        ? [
            `<path class="ok" d="M${x - 12} ${ruleY + 14}l4 4 8-9" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>`,
            ...(w.lasts === '' ? [] : [text('good', x - 18, ruleY + 19, w.lasts)]),
          ]
        : [text(w.isCollecting ? 's' : 'bad', x, ruleY + 19, w.forecast)]),
    )
  })
  extra.forEach((column, i) => {
    const x = extraRight(i)
    parts.push(text('s', x, 46, column.head), ...column.cells.map((cell, r) => text('t', x, rowsY + r * ROW_PX, cell)))
  })
  parts.push('</svg>')

  return parts.join('')
}

// Cells of the table: the periods' titles, then a column per window, then what the turns took.
const TITLE_CELLS = 17
const WINDOW_CELLS = 16
const TOKEN_CELLS = 8
const COST_CELLS = 9
const BAR_CELLS = 12
// What the band keeps beside the table: the Close button and the gaps.
const BESIDE_CELLS = 12

// What is used of a window as a bar of BAR_CELLS, its filled part and the rest.
const bar = (used: number): [string, string] => {
  const filled = Math.max(0, Math.min(BAR_CELLS, Math.round((used / 100) * BAR_CELLS)))

  return ['━'.repeat(filled), '━'.repeat(BAR_CELLS - filled)]
}

// One table for the windows there is a reading of, the same on every surface: a column per
// window, and beside them the tokens and dollars of each period, which are the account's and
// so one column for all. A band too narrow for those two leaves them out; the periods' points
// stay. Him beside it while a window is over pace.
const drawCards = async ($: EngineInterface, e: RenderInput, work: WorkHours): Promise<RenderElement | undefined> => {
  const { shown, at, held } = await gather($)
  const first = shown[0]
  if (first === undefined) return undefined

  const ui = $.ui.resolve(e)
  const { Box, Button, Text } = ui
  const columns = (e.props as { bodyColumns?: number }).bodyColumns ?? Number.POSITIVE_INFINITY
  const windowsWide = TITLE_CELLS + shown.length * WINDOW_CELLS + 4
  const isWide = windowsWide + TOKEN_CELLS + COST_CELLS + BESIDE_CELLS <= columns
  const rowsOf = shown.map(({ kind, window }) => spanFigures(kind, window, at, held, work))
  const shared = rowsOf[0] ?? []
  const hasTokens = isWide && shared.some(row => row.tokens !== undefined)
  const hasCost = isWide && shared.some(row => row.cost !== undefined)
  const isAnyOverPace = shown.some(({ kind, window }) => isOverPace(kind, window, at, held))
  const hasPixels = e.surface !== 'terminal' && 'Svg' in ui

  const line = (key: string, title: string, cells: RenderElement[], extra: RenderElement[] = []) => (
    <Box key={key}>
      <Box width={TITLE_CELLS} flexShrink={0}>
        <Text dimColor wrap="truncate">
          {title}
        </Text>
      </Box>
      {cells}
      {extra}
    </Box>
  )
  const cell = (key: string, width: number, child: RenderElement) => (
    <Box key={key} width={width} flexShrink={0} justifyContent="flex-end">
      {child}
    </Box>
  )
  const shareCells = (row: Row | undefined, isHeading = false) => [
    ...(hasTokens ? [cell('tokens', TOKEN_CELLS, <Text tabular dimColor={isHeading}>{isHeading ? 'Tokens' : (row?.tokens ?? '')}</Text>)] : []),
    ...(hasCost ? [cell('cost', COST_CELLS, <Text tabular dimColor={isHeading}>{isHeading ? 'Custo' : (row?.cost ?? '')}</Text>)] : []),
  ]

  const table = hasPixels ? (
    <ui.Svg
      key="table"
      source={tableSvg(
        shown.map(({ kind, window }, w) => {
          const state = outlook(kind, window, at, held).state
          const untilReset = resetsIn(window, at)

          return {
            title: SHORT_TITLES[kind] ?? kind,
            used: usedLabel(kind, window, held),
            lasts: lasting(kind, window, at, held),
            usedShare: usedOf(window) + (fraction(held, kind) ?? 0),
            reset: untilReset > 0 ? duration(untilReset) : '–',
            points: (rowsOf[w] ?? []).map(row => row.points),
            isOk: state === 'ok',
            isCollecting: state === 'collecting',
            forecast: forecast(kind, window, at, held),
          }
        }),
        shared.map(row => row.title),
        hasTokens ? { tokens: shared.map(row => row.tokens ?? ''), ...(hasCost ? { cost: shared.map(row => row.cost ?? '') } : {}) } : undefined,
      )}
      alt={shown.map(({ kind, window }) => details(kind, window, at, held, work)).join('. ')}
    />
  ) : (
    <Box key="table" flexDirection="column" borderStyle="round" paddingX={1}>
      {line(
        'heading',
        '',
        shown.map(({ kind, window }) =>
          cell(
            kind,
            WINDOW_CELLS,
            <Text>
              <Text dimColor>{`${SHORT_TITLES[kind] ?? kind}  `}</Text>
              <Text bold tabular>
                {usedLabel(kind, window, held)}
              </Text>
            </Text>,
          ),
        ),
      )}
      {line(
        'bar',
        '',
        shown.map(({ kind, window }) => {
          const [filled, rest] = bar(usedOf(window) + (fraction(held, kind) ?? 0))

          return cell(
            kind,
            WINDOW_CELLS,
            <Text>
              <Text color="suggestion">{filled}</Text>
              <Text dimColor>{rest}</Text>
            </Text>,
          )
        }),
      )}
      {line(
        'reset',
        'Reinicia em',
        shown.map(({ kind, window }) => {
          const untilReset = resetsIn(window, at)

          return cell(kind, WINDOW_CELLS, <Text dimColor tabular>{untilReset > 0 ? duration(untilReset) : '–'}</Text>)
        }),
        shareCells(undefined, true),
      )}
      <Box key="gap-1" height={1} />
      {shared.map((row, i) =>
        line(
          `range-${row.label}`,
          row.title,
          shown.map(({ kind }, w) => cell(kind, WINDOW_CELLS, <Text tabular>{rowsOf[w]?.[i]?.points ?? ''}</Text>)),
          shareCells(row),
        ),
      )}
      <Box key="gap-2" height={1} />
      {line(
        'pace',
        'No ritmo atual',
        shown.map(({ kind, window }) => {
          const state = outlook(kind, window, at, held).state

          return cell(
            kind,
            WINDOW_CELLS,
            <Text color={state === 'ok' ? 'success' : state === 'collecting' ? undefined : 'error'} dimColor={state === 'collecting'}>
              {state === 'ok' ? [lasting(kind, window, at, held), '✓'].filter(part => part !== '').join(' ') : forecast(kind, window, at, held)}
            </Text>,
          )
        }),
      )}
    </Box>
  )

  return (
    <Box width="100%" flexWrap="wrap" alignItems="center" justifyContent="flex-end" gap={1}>
      {!isAnyOverPace ? null : hasPixels ? (
        <ui.Svg key="panic" source={PANIC_SVG} alt={PANIC_ALT} width={PANIC_W * 2} height={PANIC_H * 2} />
      ) : (
        <Text key="panic" color="warning">
          ⚠
        </Text>
      )}
      {table}
      <Button key="limits-close" label="Fechar" role="dismiss" onPress={() => update($, isOpen, () => false)} />
    </Box>
  )
}

// Said once a load: a server that is down is down for every tick after.
let hasSyncFailed = false

const syncNow = async ($: EngineInterface, remote: SyncOptions | undefined, isDue?: boolean): Promise<void> => {
  if (remote === undefined) return
  await sync($, remote, isDue).catch((error: unknown) => {
    if (hasSyncFailed) return
    hasSyncFailed = true
    $.ui.toast(`sincronização falhou: ${error instanceof Error ? error.message : String(error)}`, { timeoutMs: WARNING_MS })
  })
}

export const register: Register = (on, options) => {
  const remote = syncOptions(options)
  const work = workHours((options as Record<string, unknown> | undefined)?.workHours)

  on('session.start', async ($, e, next) => {
    const started = await next(e)
    const stored = await $.store.get(STORE_KEY)
    await update($, windows, () => (isWindows(stored) ? stored : {}))
    const spent = await $.store.get(SPEND_KEY)
    await update($, spend, () => (isSpend(spent) ? spent : NO_SPEND))
    const t = await $.clock.now()
    await update($, now, () => t)
    await $.command.register({
      name: COMMAND,
      description: 'Mostra ou esconde os cartões de uso das janelas de 5h e 7d acima do prompt',
    })
    // "The last 15 minutes" moves on while no reading arrives, and a session that makes no call
    // of its own takes up the readings the others put in the store.
    $.clock.every(MINUTE, () => {
      void refresh($).then(() => syncNow($, remote))
    })
    void syncNow($, remote, true)

    return started
  })

  on('session.measure', async ($, e, next) => {
    const t = await $.clock.now()
    // The store is shared by every session, so their readings add up to one history.
    const stored = await $.store.get(STORE_KEY)
    const held: Windows = isWindows(stored) ? stored : {}
    const fresh = e.rateLimits.filter((l: SessionRateLimit) => KINDS.some(kind => kind === l.kind))
    const merged: Windows = { ...held }
    const spent = await $.store.get(SPEND_KEY)
    const counted: Spend = isSpend(spent) ? spent : NO_SPEND
    let turned = counted
    const warnings: string[] = []
    // The ledger is this session's alone and only grows: what it grew by since the last
    // measurement is what this session's calls cost.
    const usd = e.cost?.usd
    if (usd !== undefined) {
      const seen = await read($, seenUsd)
      if (seen >= 0 && usd > seen) turned = spendCost(turned, t, usd - seen)
      await update($, seenUsd, () => usd)
    }

    for (const limit of fresh) {
      const known = held[limit.kind]
      const before = known?.samples.at(-1)?.used
      const samples = record(known?.samples ?? [], t, limit.percentUsed, historyOf(limit.kind))
      const window = limit.resetsAt === undefined ? { samples } : { samples, resetsAt: limit.resetsAt }
      merged[limit.kind] = window
      // Said once, by the reading that crosses the line: the store is shared, so the other
      // sessions find the window already over its pace and stay quiet.
      const wasOverPace = known !== undefined && isOverPace(limit.kind, known, t, counted)
      if (!wasOverPace && isOverPace(limit.kind, window, t, counted)) warnings.push(warning(limit.kind, window, t, counted))
      // A reading a little under the last is another session's older one, as `record` has it.
      const isOlder = before !== undefined && limit.percentUsed < before && limit.percentUsed >= before - 1
      if (before !== undefined && !isOlder) turned = turnPoint(turned, limit.kind, before, limit.percentUsed)
    }
    if (fresh.length > 0) turned = calibrate(turned, merged, t)

    if (fresh.length > 0) {
      await $.store.set(STORE_KEY, merged)
      await update($, windows, () => merged)
      await update($, now, () => t)
    }
    if (turned !== counted) {
      await $.store.set(SPEND_KEY, turned)
      await update($, spend, () => turned)
    }
    for (const text of warnings) void warn($, text)

    return next(e)
  })

  // Every turn's tokens, a subagent's run included, go on the count the sessions share.
  on('turn.complete', async ($, e, next) => {
    if (e.usage !== undefined) {
      const t = await $.clock.now()
      const spent = await $.store.get(SPEND_KEY)
      const counted = spendTurn(isSpend(spent) ? spent : NO_SPEND, t, e.usage)
      await $.store.set(SPEND_KEY, counted)
      await update($, spend, () => counted)
      await update($, now, () => t)
    }

    return next(e)
  })

  on('command.run', { command: COMMAND }, async $ => {
    const isShown = await update($, isOpen, shown => !shown)

    return { text: isShown ? 'Cartões de uso abertos acima do prompt.' : 'Cartões de uso fechados.' }
  })

  // The prompt footer, where the session's mode labels are. On the desktop each window is a
  // button, and either one puts both cards up or takes them down; the terminal's is one line.
  on('ui.render', { component: 'SessionMode' }, async ($, e, next) => {
    const { shown, at, held } = await gather($)
    if (shown.length === 0) return next(e)

    const { Box, Button, Text } = $.ui.resolve(e)
    const modes = e.props.modes.join(' & ')
    if (e.surface === 'terminal') {
      const line = shown.map(window => footerLabel(window, at, true, held)).join(' · ')

      return <Text dimColor>{modes === '' ? line : `${modes}  ${line}`}</Text>
    }

    return (
      <Box alignItems="center" gap={1}>
        {modes === '' ? null : <Text>{modes}</Text>}
        {shown.map(item => {
          const icon = ICONS[item.kind]?.emoji

          return (
            <Button
              key={`limits-${item.kind}`}
              label={footerLabel(item, at, false, held)}
              onPress={() => update($, isOpen, shown => !shown)}
            >
              {PAD}
              {icon === undefined ? null : <Text dimColor>{`${icon} `}</Text>}
              <Text tabular>{`${item.left}%`}</Text>
              {isOverPace(item.kind, item.window, at, held) ? <Text color="error"> 🛑</Text> : null}
              {PAD}
            </Button>
          )
        })}
      </Box>
    )
  })

  // The band above the prompt: the cards that are up, and nothing otherwise, since the app
  // frames the band for any tree, a hidden one included.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    // Another mod's band beneath this one keeps its rows; this one goes under them.
    const beneath = await next(e)
    const cards = e.props.hasSurvey || !(await read($, isOpen)) ? undefined : await drawCards($, e, work)
    if (cards === undefined) return beneath

    const { Box } = $.ui.resolve(e)

    return isDrawn(beneath) ? (
      <Box flexDirection="column">
        {beneath}
        {cards}
      </Box>
    ) : (
      cards
    )
  })
}
