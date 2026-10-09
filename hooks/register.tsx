import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderElement, RenderInput, SessionRateLimit } from 'claude-code'

import type { LimitWindow, Sample, Windows } from '../types'

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
const MIN_PACE_MS = 5 * MINUTE
const STORE_KEY = 'windows'
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
// The desktop's button has no padding of its own and takes none: no-break spaces stand in.
const PAD = '\u00A0\u00A0'
const COMMAND = 'limits'

const round1 = (n: number): number => Math.round(n * 10) / 10

// Adds a reading, keeping one sample a minute and nothing older than the one that anchors the last hour.
export const record = (samples: readonly Sample[], t: number, used: number): Sample[] => {
  const last = samples.at(-1)
  if (last === undefined) return [{ t, used }]
  // The window reset: what came before says nothing about it.
  if (used < last.used - 1) return [{ t, used }]
  // Another session's newer reading is already in; a slightly older one adds nothing.
  if (used < last.used) return [...samples]

  const before = samples.at(-2)
  const head = before !== undefined && t - before.t < MINUTE ? samples.slice(0, -1) : samples
  const firstInside = head.findIndex(s => s.t >= t - HOUR)
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

// Points of the window used per millisecond over the last hour, or over what history there is.
const pace = (samples: readonly Sample[], at: number): number | undefined => {
  const first = samples[0]
  const last = samples.at(-1)
  if (first === undefined || last === undefined) return undefined

  const span = Math.min(HOUR, at - first.t)
  if (span < MIN_PACE_MS) return undefined

  return Math.max(0, last.used - (usedAt(samples, at - span) ?? last.used)) / span
}

const left = (window: LimitWindow): number => Math.max(0, 100 - (window.samples.at(-1)?.used ?? 0))

const resetsIn = (window: LimitWindow, at: number): number =>
  window.resetsAt === undefined ? Number.NaN : Date.parse(window.resetsAt) - at

// What the pace of the last hour does to what is left: fine, or out before the reset.
export type Outlook = { state: 'collecting' | 'ok' | 'out' } | { state: 'runsOut'; inMs: number }

export const outlook = (window: LimitWindow, at: number): Outlook => {
  const rate = pace(window.samples, at)
  if (rate === undefined) return { state: 'collecting' }
  if (left(window) === 0) return { state: 'out' }
  if (rate === 0) return { state: 'ok' }

  const lastsMs = left(window) / rate

  return lastsMs >= resetsIn(window, at) ? { state: 'ok' } : { state: 'runsOut', inMs: lastsMs }
}

export const forecast = (window: LimitWindow, at: number): string => {
  const o = outlook(window, at)
  if (o.state === 'ok') return '✓'
  if (o.state === 'collecting') return 'coletando dados'
  if (o.state === 'runsOut') return `esgota em ~${duration(o.inMs)}`

  return 'esgotado'
}

// The 5-hour window warns when it runs out more than half an hour before it resets; the weekly
// one when a day at that pace takes more than 15 points and it runs out before it resets.
export const isOverPace = (kind: string, window: LimitWindow, at: number): boolean => {
  const rate = pace(window.samples, at)
  if (rate === undefined || rate === 0) return false

  const lastsMs = left(window) / rate
  const untilReset = resetsIn(window, at)
  // With no reset on record the pace alone decides.
  if (kind === 'seven_day') return rate * DAY > WEEKLY_POINTS_A_DAY && !(lastsMs >= untilReset)

  return lastsMs < untilReset - EARLY_MS
}

const TITLES: Record<string, string> = { five_hour: 'Limite de sessão · 5h', seven_day: 'Semanal · 7d' }
const SPAN_TITLES = ['Últimos 15 min', 'Últimos 30 min', 'Última hora'] as const

const usedOf = (window: LimitWindow): number => round1(100 - left(window))

const resetLine = (window: LimitWindow, at: number): string => {
  const untilReset = resetsIn(window, at)

  return untilReset > 0 ? `Reinicia em ${duration(untilReset)}` : ''
}

// The spans' figures, in SPANS' order: `1.2%`, or a dash where the history does not reach.
const spanFigures = (window: LimitWindow, at: number): string[] =>
  SPANS.map(({ ms }) => {
    const used = usedIn(window.samples, at, ms)

    return used === undefined ? '–' : `${used}%`
  })

// One line of it all, for a reader that cannot see the card.
export const details = (kind: string, window: LimitWindow, at: number): string =>
  [
    `${TITLES[kind] ?? kind}: ${usedOf(window)}% usado`,
    resetLine(window, at),
    ...spanFigures(window, at).map((figure, i) => `${SPANS[i]?.label} ${figure}`),
    forecast(window, at),
  ]
    .filter(part => part !== '')
    .join(' · ')

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
export const cardSvg = (kind: string, window: LimitWindow, at: number): string => {
  const right = CARD_W - 14
  const o = outlook(window, at)
  const rows = spanFigures(window, at)
    .map((figure, i) => {
      const y = 68 + i * 20

      return `<text class="s" x="14" y="${y}">${SPAN_TITLES[i]}</text><text class="t" x="${right}" y="${y}" text-anchor="end">${figure}</text>`
    })
    .join('')
  // Fine is a green check and nothing to read.
  const verdict =
    o.state === 'ok'
      ? `<path class="ok" d="M${right - 12} 131l4 4 8-9" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>`
      : `<text class="${o.state === 'collecting' ? 's' : 'bad'}" x="${right}" y="136" text-anchor="end">${forecast(window, at)}</text>`

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${CARD_W}" height="${CARD_H}" viewBox="0 0 ${CARD_W} ${CARD_H}">`,
    CARD_CSS,
    `<rect class="bg" x=".5" y=".5" width="${CARD_W - 1}" height="${CARD_H - 1}" rx="10"/>`,
    `<text class="t" x="14" y="24" font-weight="600">${TITLES[kind] ?? kind}</text>`,
    `<text x="${right}" y="24" text-anchor="end"><tspan class="s">${resetLine(window, at)}  </tspan><tspan class="t">${usedOf(window)}%</tspan></text>`,
    `<rect class="k" x="14" y="34" width="${CARD_W - 28}" height="4" rx="2"/>`,
    `<rect class="bar" x="14" y="34" width="${round1(((CARD_W - 28) * usedOf(window)) / 100)}" height="4" rx="2"/>`,
    rows,
    `<line class="ln" x1="14" y1="118" x2="${right}" y2="118"/>`,
    `<text class="s" x="14" y="136">No ritmo atual</text>`,
    verdict,
    '</svg>',
  ].join('')
}

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
const gather = async ($: EngineInterface): Promise<{ shown: Shown[]; at: number }> => {
  const held = await read($, windows)
  const at = await read($, now)
  const shown = KINDS.flatMap(kind => {
    const window = held[kind]

    return window === undefined || window.samples.length === 0 ? [] : [{ kind, window, left: Math.round(left(window)) }]
  })

  return { shown, at }
}

// One window in the footer: its icon, what is left of it, and a mark where it is over pace.
export const footerLabel = ({ kind, window, left }: Shown, at: number, isTerminal: boolean): string => {
  const icon = ICONS[kind]
  const mark = isOverPace(kind, window, at) ? (isTerminal ? ' ⚠' : ' 🛑') : ''

  return `${icon === undefined ? '' : `${isTerminal ? icon.glyph : icon.emoji} `}${left}%${mark}`
}

// The cards, one per window, with him beside them while a window is over pace. They keep to
// the band's right end, over the footer's buttons that put them up.
const drawCards = async ($: EngineInterface, e: RenderInput): Promise<RenderElement | undefined> => {
  const { shown, at } = await gather($)
  if (shown.length === 0) return undefined

  const ui = $.ui.resolve(e)
  const { Box, Button, Text } = ui
  // The terminal has no pixels to draw with: bordered boxes for the cards, a triangle for him.
  const hasPixels = e.surface !== 'terminal' && 'Svg' in ui
  const isAnyOverPace = shown.some(({ kind, window }) => isOverPace(kind, window, at))

  return (
    <Box width="100%" alignItems="center" justifyContent={hasPixels ? 'flex-end' : 'flex-start'} gap={1}>
      {!isAnyOverPace ? null : hasPixels ? (
        <ui.Svg source={PANIC_SVG} alt={PANIC_ALT} width={PANIC_W * 2} height={PANIC_H * 2} />
      ) : (
        <Text color="warning">⚠</Text>
      )}
      {shown.map(({ kind, window }) =>
        hasPixels ? (
          <ui.Svg key={kind} source={cardSvg(kind, window, at)} alt={details(kind, window, at)} width={CARD_W} height={CARD_H} />
        ) : (
          <Box key={kind} flexDirection="column" width={40} borderStyle="round" paddingX={1}>
            <Box justifyContent="space-between">
              <Text bold>{TITLES[kind] ?? kind}</Text>
              <Text>{usedOf(window)}%</Text>
            </Box>
            <Text dimColor>{resetLine(window, at)}</Text>
            {spanFigures(window, at).map((figure, i) => (
              <Box justifyContent="space-between">
                <Text dimColor>{SPAN_TITLES[i]}</Text>
                <Text>{figure}</Text>
              </Box>
            ))}
            <Box justifyContent="space-between">
              <Text dimColor>No ritmo atual</Text>
              <Text color={outlook(window, at).state === 'ok' ? 'success' : 'warning'}>{forecast(window, at)}</Text>
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

    for (const limit of fresh) {
      const samples = record(held[limit.kind]?.samples ?? [], t, limit.percentUsed)
      merged[limit.kind] = limit.resetsAt === undefined ? { samples } : { samples, resetsAt: limit.resetsAt }
    }

    if (fresh.length > 0) {
      await $.store.set(STORE_KEY, merged)
      await update($, windows, () => merged)
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
    const { shown, at } = await gather($)
    if (shown.length === 0) return next(e)

    const { Box, Button, Text } = $.ui.resolve(e)
    const modes = e.props.modes.join(' & ')
    if (e.surface === 'terminal') {
      const line = shown.map(window => footerLabel(window, at, true)).join(' · ')

      return <Text dimColor>{modes === '' ? line : `${modes}  ${line}`}</Text>
    }

    return (
      <Box alignItems="center" gap={1}>
        {modes === '' ? null : <Text>{modes}</Text>}
        {shown.map(window => (
          <Button
            key={`limits-${window.kind}`}
            label={`${PAD}${footerLabel(window, at, false)}${PAD}`}
            onPress={() => update($, isOpen, shown => !shown)}
          />
        ))}
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
