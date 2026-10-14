import { atom, read, update } from 'claude-code'
import type { EngineInterface, ModelUsage, Register, RenderElement, RenderInput, SessionRateLimit } from 'claude-code'

import type { LimitWindow, Sample, Spend, Spent, Windows } from '../types'

// Left to right: the 5-hour window, then the weekly one.
const KINDS = ['five_hour', 'seven_day'] as const

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR
const SPANS = [
  { label: '15m', ms: 15 * MINUTE },
  { label: '30m', ms: 30 * MINUTE },
  { label: '1h', ms: HOUR },
] as const

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
  // The last hour a minute apart, for the cards' spans; the rest of the day further apart.
  const recent = held.events
    .filter(event => event.t > t - DAY)
    .reduce<Spent[]>((kept, event) => {
      const prev = kept.at(-1)
      if (prev === undefined || event.t > t - HOUR || event.t - prev.t >= OLD_ENTRY_MS) return [...kept, event]

      return [...kept.slice(0, -1), { t: prev.t, tokens: prev.tokens + event.tokens, weight: prev.weight + event.weight }]
    }, [])
  const last = recent.at(-1)
  const events =
    last !== undefined && t - last.t < MINUTE
      ? [...recent.slice(0, -1), { t: last.t, tokens: last.tokens + tokens, weight: last.weight + weight }]
      : [...recent, { t, tokens, weight }]

  const total = held.total + weight

  return { ...held, since: held.since ?? t, total, events, perPoint: atLeastSinceMark(held, total) }
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

const spentIn = (held: Spend, at: number, span: number): { tokens: number; weight: number } =>
  held.events
    .filter(event => event.t > at - span)
    .reduce((sum, event) => ({ tokens: sum.tokens + event.tokens, weight: sum.weight + event.weight }), { tokens: 0, weight: 0 })

const compact = (tokens: number): string => {
  if (tokens < 1000) return String(tokens)
  if (tokens < 100_000) return `${round1(tokens / 1000)}k`
  if (tokens < 1_000_000) return `${Math.round(tokens / 1000)}k`

  return `${round1(tokens / 1_000_000)}M`
}

const resetsIn = (window: LimitWindow, at: number): number =>
  window.resetsAt === undefined ? Number.NaN : Date.parse(window.resetsAt) - at

// What the pace of the last hour does to what is left: fine, or out before the reset.
export type Outlook = { state: 'collecting' | 'ok' | 'out' } | { state: 'runsOut'; inMs: number }

export const outlook = (kind: string, window: LimitWindow, at: number, held: Spend = NO_SPEND): Outlook => {
  const rate = pace(kind, window, at, held)
  if (rate === undefined) return { state: 'collecting' }
  if (left(window) === 0) return { state: 'out' }
  if (rate === 0) return { state: 'ok' }

  const lastsMs = left(window) / rate

  return lastsMs >= resetsIn(window, at) ? { state: 'ok' } : { state: 'runsOut', inMs: lastsMs }
}

export const forecast = (kind: string, window: LimitWindow, at: number, held: Spend = NO_SPEND): string => {
  const o = outlook(kind, window, at, held)
  if (o.state === 'ok') return '✓'
  if (o.state === 'collecting') return 'coletando dados'
  if (o.state === 'runsOut') return `esgota em ~${duration(o.inMs)}`

  return 'esgotado'
}

// The 5-hour window warns when it runs out more than half an hour before it resets; the weekly
// one when a day at that pace takes more than 15 points and it runs out before it resets.
export const isOverPace = (kind: string, window: LimitWindow, at: number, held: Spend = NO_SPEND): boolean => {
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
const SPAN_TITLES = ['Últimos 15 min', 'Últimos 30 min', 'Última hora'] as const

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

// The spans' figures, in SPANS' order: the points of the window and, once a turn is on record,
// the tokens (`~0.4% · 182k`). The points are the turns' estimate where a point's weight is
// known, the readings' otherwise: a dash where the history does not reach, and `<1%` where
// tokens went and the whole-number reading did not move.
const spanFigures = (kind: string, window: LimitWindow, at: number, held: Spend): string[] =>
  SPANS.map(({ ms }) => {
    const { tokens, weight } = spentIn(held, at, ms)
    const perPoint = held.perPoint[kind]
    const used = usedIn(window.samples, at, ms)
    const points =
      perPoint !== undefined
        ? `~${round1(weight / perPoint)}%`
        : used === undefined
          ? '–'
          : used === 0 && tokens > 0
            ? '<1%'
            : `${used}%`

    return held.total === 0 ? points : `${points} · ${compact(tokens)}`
  })

// One line of it all, for a reader that cannot see the card.
export const details = (kind: string, window: LimitWindow, at: number, held: Spend = NO_SPEND): string =>
  [
    `${TITLES[kind] ?? kind}: ${usedLabel(kind, window, held)} usado`,
    resetLine(window, at),
    ...spanFigures(kind, window, at, held).map((figure, i) => `${SPANS[i]?.label} ${figure}`),
    forecast(kind, window, at, held),
  ]
    .filter(part => part !== '')
    .join(' · ')

// A figure such as `<1%` is text in the card's markup, not a tag.
const escapeXml = (text: string): string => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

const CARD_W = 300
const CARD_H = 150
const FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif"
const CARD_CSS = `<style>
text{font-family:${FONT};font-size:12px}
.bg{fill:#fff;stroke:#deddd9}.t{fill:#1f1f1f}.s{fill:#6b6b68}.k{fill:#ecebe8}.ln{stroke:#e8e7e3}
.bar{fill:#2c7be5}.ok{stroke:#2e9e5b}.bad{fill:#d92d20}
@media (prefers-color-scheme: dark){.bg{fill:#262624;stroke:#3d3d3a}.t{fill:#ececec}.s{fill:#a8a8a4}.k{fill:#3a3a38}.ln{stroke:#383836}.ok{stroke:#4cc38a}.bad{fill:#f97066}}
</style>`

// The card a hover shows on a surface that draws pixels: the window as the app's own usage
// card has it, then what the last 15 minutes, 30 minutes and hour took, and where that leads.
export const cardSvg = (kind: string, window: LimitWindow, at: number, held: Spend = NO_SPEND): string => {
  const right = CARD_W - 14
  const o = outlook(kind, window, at, held)
  const used = Math.min(100, usedOf(window) + (fraction(held, kind) ?? 0))
  const rows = spanFigures(kind, window, at, held)
    .map((figure, i) => {
      const y = 68 + i * 20

      return `<text class="s" x="14" y="${y}">${SPAN_TITLES[i]}</text><text class="t" x="${right}" y="${y}" text-anchor="end">${escapeXml(figure)}</text>`
    })
    .join('')
  // Fine is a green check and nothing to read.
  const verdict =
    o.state === 'ok'
      ? `<path class="ok" d="M${right - 12} 131l4 4 8-9" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>`
      : `<text class="${o.state === 'collecting' ? 's' : 'bad'}" x="${right}" y="136" text-anchor="end">${forecast(kind, window, at, held)}</text>`

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${CARD_W}" height="${CARD_H}" viewBox="0 0 ${CARD_W} ${CARD_H}">`,
    CARD_CSS,
    `<rect class="bg" x=".5" y=".5" width="${CARD_W - 1}" height="${CARD_H - 1}" rx="10"/>`,
    `<text class="t" x="14" y="24" font-weight="600">${TITLES[kind] ?? kind}</text>`,
    `<text x="${right}" y="24" text-anchor="end"><tspan class="s">${resetLine(window, at)}  </tspan><tspan class="t">${usedLabel(kind, window, held)}</tspan></text>`,
    `<rect class="k" x="14" y="34" width="${CARD_W - 28}" height="4" rx="2"/>`,
    `<rect class="bar" x="14" y="34" width="${round1(((CARD_W - 28) * used) / 100)}" height="4" rx="2"/>`,
    rows,
    `<line class="ln" x1="14" y1="118" x2="${right}" y2="118"/>`,
    `<text class="s" x="14" y="136">No ritmo atual</text>`,
    verdict,
    '</svg>',
  ].join('')
}

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
  const shown = KINDS.flatMap(kind => {
    const window = held[kind]

    return window === undefined || window.samples.length === 0 ? [] : [{ kind, window, left: Math.round(left(window)) }]
  })

  return { shown, at, held: await read($, spend) }
}

// One window in the footer: its icon, what is left of it, and a mark where it is over pace.
export const footerLabel = ({ kind, window, left }: Shown, at: number, isTerminal: boolean, held: Spend = NO_SPEND): string => {
  const icon = ICONS[kind]
  const mark = isOverPace(kind, window, at, held) ? (isTerminal ? ' ⚠' : ' 🛑') : ''

  return `${icon === undefined ? '' : `${isTerminal ? icon.glyph : icon.emoji} `}${left}%${mark}`
}

// The person's own notification where a terminal takes it; a toast where none does, as on the
// desktop, which has no terminal to write it to.
const warn = async ($: EngineInterface, text: string): Promise<void> => {
  const sent = await $.ui.notify(text).catch(() => undefined)
  if (sent?.isSent !== true) $.ui.toast(text, { timeoutMs: WARNING_MS })
}

// The cards, one per window, with him beside them while a window is over pace. They keep to
// the band's right end, over the footer's buttons that put them up.
const drawCards = async ($: EngineInterface, e: RenderInput): Promise<RenderElement | undefined> => {
  const { shown, at, held } = await gather($)
  if (shown.length === 0) return undefined

  const ui = $.ui.resolve(e)
  const { Box, Button, Text } = ui
  // The terminal has no pixels to draw with: bordered boxes for the cards, a triangle for him.
  const hasPixels = e.surface !== 'terminal' && 'Svg' in ui
  const isAnyOverPace = shown.some(({ kind, window }) => isOverPace(kind, window, at, held))

  return (
    // A band too narrow for both cards in a row takes the second under the first.
    <Box width="100%" flexWrap="wrap" alignItems="center" justifyContent={hasPixels ? 'flex-end' : 'flex-start'} gap={1}>
      {!isAnyOverPace ? null : hasPixels ? (
        <ui.Svg source={PANIC_SVG} alt={PANIC_ALT} width={PANIC_W * 2} height={PANIC_H * 2} />
      ) : (
        <Text color="warning">⚠</Text>
      )}
      {shown.map(({ kind, window }) =>
        hasPixels ? (
          // No size of its own: the markup's 300 by 150, shrunk to fit a narrower band.
          <ui.Svg key={kind} source={cardSvg(kind, window, at, held)} alt={details(kind, window, at, held)} />
        ) : (
          <Box key={kind} flexDirection="column" width={40} borderStyle="round" paddingX={1}>
            <Box justifyContent="space-between">
              <Text bold>{TITLES[kind] ?? kind}</Text>
              <Text>{usedLabel(kind, window, held)}</Text>
            </Box>
            <Text dimColor>{resetLine(window, at)}</Text>
            {spanFigures(kind, window, at, held).map((figure, i) => (
              <Box justifyContent="space-between">
                <Text dimColor>{SPAN_TITLES[i]}</Text>
                <Text>{figure}</Text>
              </Box>
            ))}
            <Box justifyContent="space-between">
              <Text dimColor>No ritmo atual</Text>
              <Text color={outlook(kind, window, at, held).state === 'ok' ? 'success' : 'warning'}>{forecast(kind, window, at, held)}</Text>
            </Box>
          </Box>
        ),
      )}
      <Button key="limits-close" label="Fechar" role="dismiss" onPress={() => update($, isOpen, () => false)} />
    </Box>
  )
}

export const register: Register = on => {
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
    // "The last 15 minutes" moves on while no reading arrives.
    $.clock.every(MINUTE, () => {
      void $.clock.now().then(t => update($, now, () => t))
    })

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

    if (fresh.length > 0) {
      await $.store.set(STORE_KEY, merged)
      if (turned !== counted) await $.store.set(SPEND_KEY, turned)
      await update($, windows, () => merged)
      await update($, spend, () => turned)
      await update($, now, () => t)
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
              {`${item.left}%`}
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
    const cards = e.props.hasSurvey || !(await read($, isOpen)) ? undefined : await drawCards($, e)
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
