import { expect, mock, test } from 'claude-code/testing'

import { NO_SPEND, calibrate, details, forecast, lasting, fraction, isOverPace, mergeWindows, profile, ranges, record, runsOutAt, spendTurn, takePeers, turnPoint, usedIn, workHours } from './register'

const MINUTE = 60_000
const EMPTY = { type: 'Box' } as const
// The engine's empty answer: a Box with nothing in it, whatever marks it carries.
// To the hundredth, for averages that come out as long fractions.
const near = (n: number | undefined) => Math.round((n ?? Number.NaN) * 100) / 100
const isBlank = (tree: { type: string; children?: unknown[] }) => tree.type === 'Box' && (tree.children ?? []).length === 0
const START = Date.parse('2026-10-08T12:00:00Z')
const BAND = {
  hasSurvey: false,
  isWorking: false,
  maxRows: 10,
  bodyColumns: 100,
  scroll: { offset: 0, bodyRows: 10 },
  view: {},
}

test('record keeps one sample a minute and the one that anchors the last hour', () => {
  let samples = record([], 0, 10)
  samples = record(samples, 10_000, 10.2)
  samples = record(samples, 20_000, 10.4)
  expect(samples).toEqual([
    { t: 0, used: 10 },
    { t: 20_000, used: 10.4 },
  ])

  samples = record(samples, 50 * MINUTE, 20)
  samples = record(samples, 90 * MINUTE, 30)
  samples = record(samples, 130 * MINUTE, 40)
  expect(samples.map(s => s.t)).toEqual([50 * MINUTE, 90 * MINUTE, 130 * MINUTE])
})

test('record starts over when the window resets and ignores a slightly older reading', () => {
  const samples = [
    { t: 0, used: 80 },
    { t: 5 * MINUTE, used: 90 },
  ]

  expect(record(samples, 6 * MINUTE, 2)).toEqual([{ t: 6 * MINUTE, used: 2 }])
  expect(record(samples, 6 * MINUTE, 89.9)).toEqual(samples)
})

test('usedIn reads between samples and says nothing past the history', () => {
  const samples = [
    { t: 0, used: 10 },
    { t: 40 * MINUTE, used: 30 },
    { t: 60 * MINUTE, used: 34 },
  ]

  expect(usedIn(samples, 60 * MINUTE, 15 * MINUTE)).toBe(3)
  expect(usedIn(samples, 60 * MINUTE, 30 * MINUTE)).toBe(9)
  expect(usedIn(samples, 60 * MINUTE, 60 * MINUTE)).toBe(24)
  expect(usedIn(samples, 60 * MINUTE, 61 * MINUTE)).toBe(undefined)
})

test('forecast projects the pace of the last hour onto what is left', () => {
  const samples = [
    { t: START, used: 10 },
    { t: START + 60 * MINUTE, used: 40 },
  ]
  const at = START + 60 * MINUTE

  // 30 points an hour, 60 left: two hours.
  expect(forecast('five_hour', { samples }, at)).toBe('esgota em ~2h00')
  expect(forecast('five_hour', { samples, resetsAt: new Date(at + 90 * MINUTE).toISOString() }, at)).toBe('✓')
  expect(forecast('five_hour', { samples: [{ t: START, used: 10 }] }, START + MINUTE)).toBe('coletando dados')
  expect(forecast('five_hour', { samples: [{ t: START, used: 10 }] }, at)).toBe('✓')
  expect(details('five_hour', { samples }, at)).toBe(
    'Limite de sessão · 5h: 40% usado · 15m 7.5% · 30m 15% · 1h 30% · 8h–18h – · 24h – · esgota em ~2h00',
  )
})

test('the table says the pace is fine with a check and nothing to read', async ($, on) => {
  const at = START + 60 * MINUTE
  const table = async (resetMinutes: number) => {
    const samples = [
      { t: START, used: 10 },
      { t: at, used: 40 },
    ]
    mock.store(on, { windows: { five_hour: { samples, resetsAt: new Date(at + resetMinutes * MINUTE).toISOString() } } })
    mock.clock(on, { now: at })
    on('session.start', (_, e) => e)
    on('command.register', () => ({ value: undefined }))
    on('ui.render', () => EMPTY)
    await $.session.start({ source: 'startup', cwd: '/tmp' } as never)
    await $.command.run({ command: 'limits', args: '' } as never)
    const band = await $.ui.mount({ plugin: 'limits-left', surface: 'desktop', component: 'AbovePrompt', props: BAND })

    return JSON.stringify(await band.drawn())
  }

  const fine = await table(90)
  // The time it would last, in green, and no check.
  expect(fine).toMatch(/class=\\"good\\"[^>]*>~/)
  expect(fine).not.toContain('class=\\"bad\\"')
  expect(fine).toContain('1h30')
  expect(fine).not.toContain('esgota')
})

test('the table says when the window runs out', async ($, on) => {
  const at = START + 60 * MINUTE
  const samples = [
    { t: START, used: 10 },
    { t: at, used: 40 },
  ]
  mock.store(on, { windows: { five_hour: { samples, resetsAt: new Date(at + 240 * MINUTE).toISOString() } } })
  mock.clock(on, { now: at })
  on('session.start', (_, e) => e)
  on('command.register', () => ({ value: undefined }))
  on('ui.render', () => EMPTY)
  await $.session.start({ source: 'startup', cwd: '/tmp' } as never)
  await $.command.run({ command: 'limits', args: '' } as never)
  const band = await $.ui.mount({ plugin: 'limits-left', surface: 'desktop', component: 'AbovePrompt', props: BAND })

  // Only the time, in red.
  const drawn = JSON.stringify(await band.drawn())
  expect(drawn).toMatch(/class=\\"bad\\"[^>]*>~2h00</)
})

test('a narrow band leaves out the tokens and the dollars and keeps the points', async ($, on) => {
  const at = START + 60 * MINUTE
  mock.store(on, {
    windows: { five_hour: { samples: [{ t: START, used: 10 }, { t: at, used: 40 }] }, seven_day: { samples: [{ t: at, used: 50 }] } },
    spend: { total: 1000, events: [{ t: at - MINUTE, tokens: 1000, weight: 1000, usd: 0.5 }], marks: {}, perPoint: {} },
  })
  mock.clock(on, { now: at })
  on('session.start', (_, e) => e)
  on('command.register', () => ({ value: undefined }))
  on('ui.render', () => EMPTY)
  await $.session.start({ source: 'startup', cwd: '/tmp' } as never)
  await $.command.run({ command: 'limits', args: '' } as never)

  const wide = await $.ui.mount({ plugin: 'limits-left', surface: 'desktop', component: 'AbovePrompt', props: BAND })
  expect(JSON.stringify(await wide.drawn())).toContain('>$0.50<')
  const narrow = await $.ui.mount({ plugin: 'limits-left', surface: 'desktop', component: 'AbovePrompt', props: { ...BAND, bodyColumns: 60 } })
  const drawn = JSON.stringify(await narrow.drawn())
  // Not drawn as columns; the description for a screen reader still says them.
  expect(drawn).not.toContain('>$0.50<')
  expect(drawn).not.toContain('>Tokens<')
  expect(drawn).toContain('>7d  </tspan>')
})

test('warns when the 5-hour window runs out more than half an hour before it resets', () => {
  // 30 points an hour, 60 left: out in two hours.
  const samples = [
    { t: START, used: 10 },
    { t: START + 60 * MINUTE, used: 40 },
  ]
  const at = START + 60 * MINUTE
  const resetsIn = (minutes: number) => ({ samples, resetsAt: new Date(at + minutes * MINUTE).toISOString() })

  expect(isOverPace('five_hour', resetsIn(180), at)).toBe(true)
  expect(isOverPace('five_hour', resetsIn(140), at)).toBe(false)
  expect(isOverPace('five_hour', resetsIn(90), at)).toBe(false)
  expect(isOverPace('five_hour', { samples }, at)).toBe(false)
  expect(isOverPace('five_hour', { samples: [{ t: START, used: 10 }] }, at)).toBe(false)
})

test('warns when a day at the weekly pace takes more than 15 points', () => {
  const at = START + 60 * MINUTE
  const paced = (used: number) => ({ samples: [{ t: START, used: 20 }, { t: at, used: 20 + used }] })

  // 0.7 points an hour is 16.8 a day; 0.6 is 14.4.
  expect(isOverPace('seven_day', paced(0.7), at)).toBe(true)
  expect(isOverPace('seven_day', paced(0.6), at)).toBe(false)

  // 79.3 left at 0.7 an hour lasts about 113 hours: no warning when the reset comes first.
  const resetsIn = (hours: number) => ({ ...paced(0.7), resetsAt: new Date(at + hours * 60 * MINUTE).toISOString() })
  expect(isOverPace('seven_day', resetsIn(19), at)).toBe(false)
  expect(isOverPace('seven_day', resetsIn(130), at)).toBe(true)
})

const measure = ($: { session: { measure: (input: never) => Promise<unknown> } }, limits: object[]) =>
  $.session.measure({ context: { window: 200000 }, rateLimits: limits, changed: ['rateLimits'] } as never)

for (const surface of ['terminal', 'desktop'] as const) {
  test(`draws what is left as one line of text in the prompt footer (${surface})`, async ($, on) => {
    const clock = mock.clock(on, { now: START })
    mock.store(on)
    on('session.measure', (_, e) => ({ changed: e.changed }))
    const resetsAt = (minutes: number) => new Date(clock.now() + minutes * MINUTE).toISOString()

    await measure($, [
      { kind: 'seven_day', percentUsed: 9 },
      { kind: 'five_hour', percentUsed: 10, resetsAt: resetsAt(300) },
    ])
    await clock.advance(60 * MINUTE)
    await measure($, [
      { kind: 'seven_day', percentUsed: 9 },
      { kind: 'five_hour', percentUsed: 40, resetsAt: resetsAt(240) },
    ])

    const footer = await $.ui.mount({ plugin: 'limits-left', surface, component: 'SessionMode', props: { modes: ['focus'] } })

    if (surface === 'terminal') {
      // No icons: the 5-hour window first, red as it is over its pace, the weekly one plain.
      const drawn = JSON.stringify(await footer.drawn())
      expect(drawn).toContain('focus  ')
      expect(drawn).toMatch(/"color":"error"[^}]*\},"children":\["60%"\]/)
      expect(drawn).toContain('"children":["91%"]')
      expect(drawn).not.toMatch(/[◷▦⚠🛑]/u)
    } else {
      // A button for each: the 5-hour one over its pace, so the accent one; the weekly one plain.
      expect(await footer.find({ key: 'limits-five_hour' })).toMatchObject({ type: 'Button', text: '  60%  ', props: { variant: 'primary' } })
      const weekly = await footer.find({ key: 'limits-seven_day' })
      expect(weekly).toMatchObject({ type: 'Button', text: '  91%  ' })
      expect(weekly?.props?.variant).toBe(undefined)
      expect(weekly?.props?.dimColor).toBe(undefined)
    }
  })

  test(`keeps the band empty until /limits puts the cards up (${surface})`, async ($, on) => {
    mock.clock(on, { now: START })
    mock.store(on)
    on('session.measure', (_, e) => ({ changed: e.changed }))
    on('ui.render', () => EMPTY)

    await measure($, [
      { kind: 'five_hour', percentUsed: 25 },
      { kind: 'seven_day', percentUsed: 9 },
    ])

    const band = await $.ui.mount({ plugin: 'limits-left', surface, component: 'AbovePrompt', props: BAND })
    expect(isBlank(await band.drawn())).toBe(true)

    expect(await $.command.run({ command: 'limits', args: '' } as never)).toMatchObject({ text: 'Cartões de uso abertos acima do prompt.' })
    await band.redraw()
    expect(JSON.stringify(await band.drawn())).toContain('No ritmo atual')

    await band.press({ key: 'limits-close' })
    await band.redraw()
    expect(isBlank(await band.drawn())).toBe(true)

    if (surface === 'desktop') {
      const footer = await $.ui.mount({ plugin: 'limits-left', surface, component: 'SessionMode', props: { modes: [] } })
      // Not over pace: the 5-hour button muted, the weekly one plain.
      expect(await footer.find({ key: 'limits-five_hour' })).toMatchObject({ props: { dimColor: true } })
      expect((await footer.find({ key: 'limits-seven_day' }))?.props?.dimColor).toBe(undefined)
      await footer.press({ key: 'limits-five_hour' })
      await band.redraw()
      expect(JSON.stringify(await band.drawn())).toContain('>5h  </tspan>')
      expect(JSON.stringify(await band.drawn())).toContain('>7d  </tspan>')

      await footer.press({ key: 'limits-seven_day' })
      await band.redraw()
      expect(isBlank(await band.drawn())).toBe(true)
    }
  })
}

test('keeps the history between sessions and the band beneath the cards', async ($, on) => {
  mock.clock(on, { now: START + 60 * MINUTE })
  mock.store(on, { windows: { five_hour: { samples: [{ t: START, used: 10 }] } } })
  on('session.measure', (_, e) => ({ changed: e.changed }))
  on('ui.render', () => ({ type: 'Box', children: [{ type: 'Text', children: ['another band'] }] }))

  await measure($, [{ kind: 'five_hour', percentUsed: 25 }])
  await $.command.run({ command: 'limits', args: '' } as never)

  const ui = await $.ui.mount({ plugin: 'limits-left', surface: 'terminal', component: 'AbovePrompt', props: BAND })
  const drawn = JSON.stringify(await ui.drawn())

  // 15 points in the hour on record, 75 left: five hours.
  expect(drawn).toContain('"~5h00"')
  expect(drawn).toContain('another band')
})

test('passes while there is no reading', async ($, on) => {
  mock.clock(on)
  mock.store(on)
  on('ui.render', () => EMPTY)

  const footer = await $.ui.mount({ plugin: 'limits-left', surface: 'terminal', component: 'SessionMode', props: { modes: [] } })

  expect(isBlank(await footer.drawn())).toBe(true)
})

const usage = (input: number, output = 0, cacheRead = 0) => ({
  input_tokens: input,
  output_tokens: output,
  cache_read_input_tokens: cacheRead,
  cache_creation_input_tokens: 0,
})

test('the turns say where a window is inside a point once a whole point was seen', () => {
  // The reading turns to 66, 1000 of weight go by, and it turns to 67: a point takes 1000.
  let spend = turnPoint(NO_SPEND, 'seven_day', 65, 66)
  expect(fraction(spend, 'seven_day')).toBe(undefined)

  spend = spendTurn(spend, START, usage(500, 100))
  spend = turnPoint(spend, 'seven_day', 66, 67)
  expect(spend.perPoint.seven_day).toBe(1000)
  expect(fraction(spend, 'seven_day')).toBe(0)

  spend = spendTurn(spend, START + 5 * MINUTE, usage(450))
  expect(fraction(spend, 'seven_day')).toBe(0.4)

  // Never past the point the reading is in, whatever went by outside this count.
  spend = spendTurn(spend, START + 6 * MINUTE, usage(5000))
  expect(fraction(spend, 'seven_day')).toBe(0.9)

  // The reading did not turn on 5450 of weight: a point takes at least that.
  expect(spend.perPoint.seven_day).toBe(5450)

  // A reset takes the mark and keeps what a point takes.
  spend = turnPoint(spend, 'seven_day', 67, 0)
  expect(fraction(spend, 'seven_day')).toBe(undefined)
  expect(spend.perPoint.seven_day).toBe(5450)
})

test('the last hour is not read as more points than the reading allows', () => {
  // Measured short (usage outside the mod went into it), a point seems to take 1000.
  let spend = turnPoint(NO_SPEND, 'seven_day', 50, 51)
  spend = spendTurn(spend, START, usage(1000))
  spend = turnPoint(spend, 'seven_day', 51, 52)
  expect(spend.perPoint.seven_day).toBe(1000)

  // 6000 more go by within the hour and the reading stays at 52.
  for (let i = 1; i <= 6; i++) spend = spendTurn(spend, START + i * 5 * MINUTE, usage(1000))
  const at = START + 30 * MINUTE
  const window = { samples: [{ t: START, used: 51 }, { t: START + MINUTE, used: 52 }, { t: at, used: 52 }] }

  // 7000 in the hour over a point of at least 6000: about one point, not seven.
  expect(details('seven_day', window, at, spend)).toContain('1h ~1.2%')
})

test('spendTurn keeps one entry a minute', () => {
  let spend = spendTurn(NO_SPEND, START, usage(100, 10, 1000))
  spend = spendTurn(spend, START + 10_000, usage(50))
  // The 1000 the cache served weigh a tenth and are not among the tokens shown.
  expect(spend.events).toEqual([{ t: START, tokens: 160, weight: 300 }])

  spend = spendTurn(spend, START + 61 * MINUTE, usage(1))
  expect(spend.events).toEqual([
    { t: START, tokens: 160, weight: 300 },
    { t: START + 61 * MINUTE, tokens: 1, weight: 1 },
  ])
  expect(spend.total).toBe(301)
})

test('the card shows the estimate and the tokens beside the points', () => {
  const window = { samples: [{ t: START, used: 66 }, { t: START + 40 * MINUTE, used: 66 }] }
  const at = START + 40 * MINUTE
  const uncalibrated = spendTurn(NO_SPEND, at - 5 * MINUTE, usage(200_000))

  // The whole-number reading did not move, and tokens went: under a point, not none.
  expect(details('seven_day', window, at, uncalibrated)).toBe(
    'Semanal · 7d: 66% usado · 15m <1% · 200k · 30m <1% · 200k · 1h – · 200k · 8h–18h – · 200k · 24h – · 200k · ✓',
  )

  const calibrated = { ...uncalibrated, marks: { seven_day: 0 }, perPoint: { seven_day: 500_000 } }
  expect(details('seven_day', window, at, calibrated)).toBe(
    'Semanal · 7d: ~66.4% usado · 15m ~0.4% · 200k · 30m ~0.4% · 200k · 1h ~0.4% · 200k · 8h–18h ~0.4% · 200k · 24h ~0.4% · 200k · ✓',
  )
})

test('a turn that ends goes on the count the sessions share', async ($, on) => {
  const clock = mock.clock(on, { now: START })
  mock.store(on)
  on('session.measure', (_, e) => ({ changed: e.changed }))
  on('ui.render', () => EMPTY)
  on('turn.complete', () => ({ text: '' }))
  const turn = (input: number) =>
    $.turn.complete({ answer: '', durationMs: 1, isAborted: false, turnId: 't', reason: 'answer', usage: { ...usage(input), model: 'm' } } as never)

  await measure($, [{ kind: 'seven_day', percentUsed: 65 }])
  await measure($, [{ kind: 'seven_day', percentUsed: 66 }])
  await turn(1000)
  await clock.advance(5 * MINUTE)
  await measure($, [{ kind: 'seven_day', percentUsed: 67 }])
  await turn(300)

  await $.command.run({ command: 'limits', args: '' } as never)
  const ui = await $.ui.mount({ plugin: 'limits-left', surface: 'terminal', component: 'AbovePrompt', props: BAND })
  const drawn = JSON.stringify(await ui.drawn())

  // A point took the 1000 between 66 and 67; the 300 since are three tenths of the next.
  expect(drawn).toContain('~67.3%')
  expect(drawn).toContain('"~1.3%"')
  expect(drawn).toContain('"1.3k"')
})

// The desktop has no terminal to notify through: the warning is a toast there.
for (const isSent of [false, true]) {
  test(`warns once when a reading puts a window over its pace (${isSent ? 'notified' : 'no terminal: a toast'})`, async ($, on) => {
    const clock = mock.clock(on, { now: START })
    mock.store(on)
    const notified: string[] = []
    const toasts: string[] = []
    on('session.measure', (_, e) => ({ changed: e.changed }))
    on('ui.notify', (_, e) => {
      notified.push(e.text)

      return { value: isSent ? { isSent: true, channel: 'kitty' } : { isSent: false, reason: 'no-surface' } }
    })
    on('ui.toast', (_, e) => {
      toasts.push(e.text)

      return { value: undefined }
    })
    const resetsAt = (minutes: number) => new Date(clock.now() + minutes * MINUTE).toISOString()
    const WARNING = '5h acima do ritmo · esgota em ~2h00'

    await measure($, [{ kind: 'five_hour', percentUsed: 10, resetsAt: resetsAt(300) }])
    expect(notified).toEqual([])

    // 30 points in the hour, 60 left: out in two hours, with four to the reset.
    await clock.advance(60 * MINUTE)
    await measure($, [{ kind: 'five_hour', percentUsed: 40, resetsAt: resetsAt(240) }])
    await clock.advance(0)
    expect(notified).toEqual([WARNING])
    expect(toasts).toEqual(isSent ? [] : [WARNING])

    // Still over it a minute later: nothing more to say.
    await clock.advance(MINUTE)
    await measure($, [{ kind: 'five_hour', percentUsed: 41, resetsAt: resetsAt(239) }])
    await clock.advance(0)
    expect(notified.length).toBe(1)
  })
}

test('says nothing of the pace on a short history or a single point turning', () => {
  const at = START + 40 * MINUTE
  const turned = (minutes: number) => [
    { t: at - minutes * MINUTE, used: 65 },
    { t: at - 2 * MINUTE, used: 66 },
    { t: at, used: 66 },
  ]

  // One point in twenty minutes is no pace, and neither is one in forty.
  expect(forecast('seven_day', { samples: turned(20) }, at)).toBe('coletando dados')
  expect(forecast('seven_day', { samples: turned(40) }, at)).toBe('coletando dados')
  expect(isOverPace('seven_day', { samples: turned(40) }, at)).toBe(false)

  // Nothing turning for half an hour is a pace: none.
  expect(forecast('seven_day', { samples: [{ t: at - 30 * MINUTE, used: 66 }, { t: at, used: 66 }] }, at)).toBe('✓')

  // Two points in forty minutes: 3 an hour, 34 left.
  const twice = [{ t: at - 40 * MINUTE, used: 64 }, { t: at - 20 * MINUTE, used: 65 }, { t: at, used: 66 }]
  expect(forecast('seven_day', { samples: twice }, at)).toBe('esgota em ~11h20')
})

test('the weekly window keeps a day of readings, a run of equal ones as its two ends', () => {
  const HOUR = 60 * MINUTE
  let samples = record([], START, 60, 24 * HOUR)
  for (let minute = 1; minute <= 180; minute++) samples = record(samples, START + minute * MINUTE, minute < 90 ? 60 : 61, 24 * HOUR)

  expect(samples).toEqual([
    { t: START, used: 60 },
    { t: START + 89 * MINUTE, used: 60 },
    { t: START + 90 * MINUTE, used: 61 },
    { t: START + 180 * MINUTE, used: 61 },
  ])

  // A point in three hours of a day's history: 8 a day, under the 15 that warn.
  expect(isOverPace('seven_day', { samples, resetsAt: new Date(START + 30 * HOUR).toISOString() }, START + 180 * MINUTE)).toBe(false)
  // Past the day, the run's first end alone anchors it.
  expect(record(samples, START + 26 * HOUR, 61, 24 * HOUR)).toEqual([
    { t: START + 90 * MINUTE, used: 61 },
    { t: START + 26 * HOUR, used: 61 },
  ])
})

test('the turns give the pace once the weight of a point is known', () => {
  const at = START + 60 * MINUTE
  // A point of the 5-hour window turned a minute ago and reads as a rush; the turns say
  // 2 points in the hour, which the 60 left outlast.
  const samples = [{ t: START, used: 39 }, { t: at - MINUTE, used: 40 }, { t: at, used: 40 }]
  const window = { samples, resetsAt: new Date(at + 200 * MINUTE).toISOString() }
  let spend = spendTurn(NO_SPEND, START, usage(0))
  spend = spendTurn(spend, START + 10 * MINUTE, usage(1000))
  spend = spendTurn(spend, at - 10 * MINUTE, usage(1000))
  spend = { ...spend, perPoint: { five_hour: 1000 } }

  expect(spend.since).toBe(START)
  expect(forecast('five_hour', window, at, spend)).toBe('✓')
  expect(forecast('five_hour', { ...window, samples: [{ t: START, used: 97 }, { t: at, used: 98 }] }, at, spend)).toBe('esgota em ~1h00')

  // Until the count is half an hour old the readings still give it.
  expect(forecast('five_hour', window, START + 20 * MINUTE, spend)).toBe('coletando dados')
})

test('spendTurn keeps a day of turns, those past the hour further apart', () => {
  let spend = NO_SPEND
  for (let minute = 0; minute <= 120; minute += 2) spend = spendTurn(spend, START + minute * MINUTE, usage(10))

  // Seven entries for the first hour, ten minutes apart, then one every two minutes.
  expect(spend.events.filter(event => event.t <= START + 60 * MINUTE).length).toBe(7)
  expect(spend.events.reduce((sum, event) => sum + event.tokens, 0)).toBe(610)
  expect(spendTurn(spend, START + 26 * 60 * MINUTE, usage(1)).events.length).toBe(1)
})

test('a session that makes no call takes up what another put in the store within a minute', async ($, on) => {
  const clock = mock.clock(on, { now: START })
  // The store as every session shares it: another one writes to it below.
  const stored: Record<string, unknown> = { windows: { seven_day: { samples: [{ t: START, used: 71 }] } } }
  on('store.get', (_, e) => ({ value: stored[e.key] }))
  on('store.set', (_, e) => {
    stored[e.key] = e.value

    return { value: undefined }
  })
  on('session.measure', (_, e) => ({ changed: e.changed }))
  on('session.start', (_, e) => e)
  on('command.register', () => ({ value: undefined }))
  await $.session.start({ source: 'startup', cwd: '/tmp' } as never)

  const footer = await $.ui.mount({ plugin: 'limits-left', surface: 'desktop', component: 'SessionMode', props: { modes: [] } })
  expect(await footer.find({ key: 'limits-seven_day' })).toMatchObject({ text: '  29%  ' })

  // Another session reads 73% and writes it to the store.
  stored.windows = { seven_day: { samples: [{ t: START, used: 71 }, { t: START + 30_000, used: 73 }] } }
  await clock.advance(MINUTE)
  await footer.redraw()
  expect(await footer.find({ key: 'limits-seven_day' })).toMatchObject({ text: '  27%  ' })
})

test('the footer counts the turns past half of the point the reading is in', async ($, on) => {
  mock.clock(on, { now: START })
  // Read at 72, and 600 of a point that takes 1000 gone by since it turned: 72.6, or 73 used.
  mock.store(on, {
    windows: { seven_day: { samples: [{ t: START, used: 72 }] } },
    spend: { total: 1600, events: [], marks: { seven_day: 1000 }, perPoint: { seven_day: 1000 } },
  })
  on('session.start', (_, e) => e)
  on('command.register', () => ({ value: undefined }))
  await $.session.start({ source: 'startup', cwd: '/tmp' } as never)

  const footer = await $.ui.mount({ plugin: 'limits-left', surface: 'desktop', component: 'SessionMode', props: { modes: [] } })
  expect(await footer.find({ key: 'limits-seven_day' })).toMatchObject({ text: '  27%  ' })
})

test('another machine adds what it did since the last sync, and nothing the first time', () => {
  let spend = spendTurn(NO_SPEND, START, usage(1000))
  expect(spend.own).toBe(1000)

  // Seen for the first time: its last day goes on the spans, its past not on the total.
  const work = { own: 50_000, events: [{ t: START, tokens: 300, weight: 300 }] }
  spend = takePeers(spend, { work, home: { own: 1, events: [] } }, 'home', START)
  expect(spend.total).toBe(1000)
  expect(spend.peers?.work?.events).toEqual(work.events)
  expect(spend.peers?.home).toBe(undefined)

  // 700 more there since: on the total, and never on what this machine sends as its own.
  spend = takePeers(spend, { work: { own: 50_700, events: [] } }, 'home', START + 5 * MINUTE)
  expect(spend.total).toBe(1700)
  expect(spend.own).toBe(1000)
  spend = spendTurn(spend, START + 6 * MINUTE, usage(100))
  expect(spend.own).toBe(1100)
  expect(spend.total).toBe(1800)
})

test('the machines readings make one history', () => {
  const home = { samples: [{ t: START, used: 70 }, { t: START + 10 * MINUTE, used: 71 }], resetsAt: 'a' }
  const work = { samples: [{ t: START + 5 * MINUTE, used: 70 }, { t: START + 20 * MINUTE, used: 72 }], resetsAt: 'b' }

  const merged = mergeWindows([{ seven_day: home }, { seven_day: work }])
  expect(merged.seven_day?.samples.at(-1)).toEqual({ t: START + 20 * MINUTE, used: 72 })
  expect(merged.seven_day?.samples.map(s => s.t)).toContain(START + 10 * MINUTE)
  // The newest reading's reset.
  expect(merged.seven_day?.resetsAt).toBe('b')
})

test('syncs with the server named in the options, as one machine', { options: { syncUrl: 'https://limits.test/', syncToken: 'k' } }, async ($, on) => {
  const clock = mock.clock(on, { now: START })
  mock.store(on, {
    device: 'home',
    windows: { seven_day: { samples: [{ t: START - MINUTE, used: 70 }] } },
    spend: { total: 1000, own: 1000, events: [], marks: { seven_day: 0 }, perPoint: { seven_day: 2000 } },
  })
  on('session.start', (_, e) => e)
  on('command.register', () => ({ value: undefined }))
  const sent: { url: string; auth?: string; body: { device: string; own: number } }[] = []
  let workOwn = 9000
  on('http.fetch', (_, e) => {
    sent.push({ url: e.url, auth: e.init?.headers?.authorization, body: JSON.parse(e.init?.body ?? '{}') })
    const work = { own: workOwn, events: [], windows: { seven_day: { samples: [{ t: clock.now(), used: 71 }] } } }

    return { value: { status: 200, ok: true, headers: {}, text: JSON.stringify({ devices: { home: sent.at(-1)?.body, work } }) } }
  })

  await $.session.start({ source: 'startup', cwd: '/tmp' } as never)
  await clock.advance(0)
  expect(sent[0]).toMatchObject({ url: 'https://limits.test/v1/sync', auth: 'Bearer k', body: { device: 'home', own: 1000 } })

  // The work machine's reading of 71 turned a point here; its 9000 so far are not counted.
  const footer = await $.ui.mount({ plugin: 'limits-left', surface: 'desktop', component: 'SessionMode', props: { modes: [] } })
  expect(await footer.find({ key: 'limits-seven_day' })).toMatchObject({ text: '  29%  ' })

  // Five minutes on, 1000 more there: the next sync counts them, and only one machine sends.
  workOwn = 10_000
  await clock.advance(5 * MINUTE)
  expect(sent.length).toBe(2)
  expect(sent[1]?.body.own).toBe(1000)
})

test('the working day reads as the option writes it, and falls back to 8 to 18', () => {
  expect(workHours('9-17')).toEqual({ start: 540, end: 1020 })
  expect(workHours(' 08:30 - 17:45 ')).toEqual({ start: 510, end: 1065 })
  expect(workHours('18-8')).toEqual({ start: 480, end: 1080 })
  expect(workHours('manhã')).toEqual({ start: 480, end: 1080 })
  expect(workHours(undefined)).toEqual({ start: 480, end: 1080 })
})

test('the working day is today once it began, cut at now, and yesterday before it', () => {
  const work = { start: 8 * 60, end: 18 * 60 }
  const at = (h: number, m = 0) => new Date(2026, 9, 15, h, m).getTime()

  const midday = ranges(at(13, 20), work)
  expect(midday.map(r => r.label)).toEqual(['15m', '30m', '1h', '8h–18h', '24h'])
  expect(midday[3]).toMatchObject({ title: 'Hoje, 8h–18h', from: at(8), to: at(13, 20) })
  expect(midday[4]).toMatchObject({ title: 'Últimas 24 horas', from: at(13, 20) - 24 * 60 * MINUTE })

  expect(ranges(at(21), work)[3]).toMatchObject({ title: 'Hoje, 8h–18h', from: at(8), to: at(18) })
  expect(ranges(at(7), work)[3]).toMatchObject({ title: 'Ontem, 8h–18h', from: new Date(2026, 9, 14, 8).getTime(), to: new Date(2026, 9, 14, 18).getTime() })
  expect(ranges(at(13), { start: 510, end: 1065 })[3]?.label).toBe('8h30–17h45')
})

test('the working day and the last 24 hours count the turns in them', () => {
  const day = (h: number) => new Date(2026, 9, 15, h).getTime()
  let spend = turnPoint(NO_SPEND, 'seven_day', 60, 61)
  spend = spendTurn(spend, day(7), usage(1000))
  spend = turnPoint(spend, 'seven_day', 61, 62)
  spend = spendTurn(spend, day(9), usage(500))
  spend = spendTurn(spend, day(19), usage(250))
  const window = { samples: [{ t: day(7), used: 61 }, { t: day(8), used: 62 }, { t: day(20), used: 62 }] }

  // A point takes 1000: 500 in the working day, 1750 in the last 24 hours.
  const line = details('seven_day', window, day(20), spend, { start: 8 * 60, end: 18 * 60 })
  expect(line).toContain('8h–18h ~0.5% · 500')
  expect(line).toContain('24h ~1.8% · 1.8k')
})

test('what the session cost goes beside the tokens, from the first measurement on', async ($, on) => {
  const clock = mock.clock(on, { now: START })
  mock.store(on, { windows: { seven_day: { samples: [{ t: START, used: 60 }] } } })
  on('session.measure', (_, e) => ({ changed: e.changed }))
  on('turn.complete', () => ({ text: '' }))
  on('ui.render', () => EMPTY)
  const cost = (usd: number) =>
    $.session.measure({ context: { window: 200000 }, rateLimits: [{ kind: 'seven_day', percentUsed: 60 }], cost: { usd }, changed: ['cost'] } as never)

  // The ledger already stood at $3 when the mod first saw it: that is not counted.
  await cost(3)
  await $.turn.complete({ answer: '', durationMs: 1, isAborted: false, turnId: 't', reason: 'answer', usage: { ...usage(1000), model: 'm' } } as never)
  await clock.advance(MINUTE)
  await cost(3.45)
  await $.command.run({ command: 'limits', args: '' } as never)

  const band = await $.ui.mount({ plugin: 'limits-left', surface: 'terminal', component: 'AbovePrompt', props: BAND })
  const drawn = JSON.stringify(await band.drawn())
  // Tokens and dollars in their own cells; the $3 the ledger stood at before is not there.
  expect(drawn).toContain('"1k"')
  expect(drawn).toContain('"$0.45"')
  expect(drawn).not.toContain('$3')
})

// A week of work from 9 to 18 on weekdays, 50 of weight an hour, from Monday 12 October 2026.
const local = (day: number, hour: number) => new Date(2026, 9, day, hour).getTime()
const workWeek = (untilDay: number, untilHour: number) => {
  const hours: { t: number; weight: number }[] = []
  for (let t = local(12, 0); t < local(untilDay, untilHour); t += 60 * MINUTE) {
    const d = new Date(t)
    if (d.getDay() >= 1 && d.getDay() <= 5 && d.getHours() >= 9 && d.getHours() < 18) hours.push({ t, weight: 50 })
  }

  return hours
}

test('the week is learned hour by hour, the weekend from what it saw of it', () => {
  const held = { ...NO_SPEND, hours: workWeek(19, 20), hoursSince: local(11, 23) }
  const week = profile(held, local(19, 20))
  // Six weekdays at 50 and two weekend days at 0 at 10h: every day seen averages 37.5, and the
  // weekdays, three days' worth of that average short of standing alone, come to 45.8; the
  // weekend's two idle days are not yet enough to read it as idle.
  expect(near(week?.weekday[10])).toBe(near(45.83))
  expect(near(week?.weekend[10])).toBe(near(22.5))
  expect(week?.weekday[20]).toBe(0)

  // Less than a day on record: nothing learned yet.
  expect(profile({ ...NO_SPEND, hours: [], hoursSince: local(19, 8) }, local(19, 20))).toBe(undefined)
})

test('a machine that began counting later is not read as idle before it began', () => {
  const work = { own: 0, events: [], hours: workWeek(19, 20), since: local(11, 23) }
  // Home began on Saturday and spends 20 an hour from 20 to 22, weekend or not.
  const evenings = [local(17, 20), local(17, 21), local(18, 20), local(18, 21)].map(t => ({ t, weight: 20 }))
  const held = { ...NO_SPEND, hours: evenings, hoursSince: local(16, 23), peers: { work } }

  const week = profile(held, local(19, 0))
  // Work: five weekdays at 50 and two idle weekend days, drawn toward their average.
  expect(near(week?.weekday[10])).toBe(near(44.64))
  // Home has seen no weekday yet, so its weekend stands for it.
  expect(week?.weekday[20]).toBe(20)
  expect(week?.weekend[21]).toBe(20)
})

test('the weekly forecast walks the person\'s week instead of using every hour of it', () => {
  const at = local(19, 20)
  const held = { ...NO_SPEND, hours: workWeek(19, 20), hoursSince: local(11, 23), perPoint: { seven_day: 100 } }
  // 10 points left, a point takes 100: 1000 of weight, about 412 a working day as the week is
  // learned so far, so Tuesday and Wednesday leave 175, three hours and 49 minutes of Thursday.
  const window = { samples: [{ t: at, used: 90 }], resetsAt: new Date(local(24, 20)).toISOString() }

  expect(runsOutAt('seven_day', window, at, held)).toEqual({ at: local(22, 12) + 49 * MINUTE })
  expect(forecast('seven_day', window, at, held)).toBe('esgota em ~2d16h')
  expect(isOverPace('seven_day', window, at, held)).toBe(true)

  // With the reset on Wednesday night it lasts.
  const sooner = { ...window, resetsAt: new Date(local(21, 23)).toISOString() }
  expect(runsOutAt('seven_day', sooner, at, held)).toBe('never')
  expect(forecast('seven_day', sooner, at, held)).toBe('✓')
  expect(isOverPace('seven_day', sooner, at, held)).toBe(false)
})

test('the weekly point takes what every machine spent over the points the readings rose', () => {
  const at = START + 12 * 60 * MINUTE
  const window = { samples: [{ t: START, used: 60 }, { t: START + 6 * 60 * MINUTE, used: 65 }, { t: at, used: 70 }] }
  // This machine learned a point as 100 from its own turns; home spent most of them.
  let held = { ...NO_SPEND, perPoint: { seven_day: 100 } }
  held = spendTurn(held, START + MINUTE, usage(1000))
  held = takePeers(held, { home: { own: 0, events: [{ t: START + 2 * MINUTE, tokens: 9000, weight: 9000 }] } }, 'work', at)

  // 10 000 over 10 points.
  expect(calibrate(held, { seven_day: window }, at).perPoint.seven_day).toBe(1000)
  // Under six hours of readings, or under four points of rise: left as it was.
  expect(calibrate(held, { seven_day: { samples: [{ t: at - MINUTE, used: 60 }, { t: at, used: 70 }] } }, at).perPoint.seven_day).toBe(100)
  expect(calibrate(held, { seven_day: { samples: [{ t: START, used: 68 }, { t: at, used: 70 }] } }, at).perPoint.seven_day).toBe(100)
})

test('one heavy day does not stand for every day of its kind', () => {
  // Counting began on Thursday night; Friday was heavy, 300 an hour from 9 to 18, and the
  // weekend and Monday morning were idle.
  const at = local(19, 9)
  const friday = [9, 10, 11, 12, 13, 14, 15, 16, 17].map(h => ({ t: local(16, h), weight: 300 }))
  const week = profile({ ...NO_SPEND, hours: friday, hoursSince: local(15, 22) }, at)

  // Every day seen at 10h: one Friday at 300, two weekend days and nothing else, 100; the one
  // weekday on record draws the weekdays only partway from that toward 300.
  expect(near(week?.weekday[10])).toBe(near((300 + 3 * 100) / 4))
})

test('the weekly point is weighed over the whole week once every machine counted it', () => {
  const reset = local(23, 18)
  const window = { samples: [{ t: local(19, 9), used: 21 }], resetsAt: new Date(reset).toISOString() }
  // The week began on Friday 16 at 18h; 2100 spent since, between two machines, and 500 before.
  const own = [{ t: local(16, 17), weight: 500 }, { t: local(16, 20), weight: 1100 }]
  const home = { own: 0, events: [], hours: [{ t: local(18, 21), weight: 1000 }], since: local(15, 20) }
  const held = { ...NO_SPEND, hours: own, hoursSince: local(15, 17), peers: { home }, perPoint: { seven_day: 37 } }

  expect(calibrate(held, { seven_day: window }, local(19, 9)).perPoint.seven_day).toBe(100)

  // A machine that spent in the week but began counting inside it: not this measure.
  const late = { ...held, peers: { home: { ...home, since: local(17, 9) } } }
  expect(calibrate(late, { seven_day: window }, local(19, 9)).perPoint.seven_day).toBe(37)
})

test('the 5-hour window has no share of a working day or a whole day', () => {
  const at = START + 60 * MINUTE
  const window = { samples: [{ t: START, used: 10 }, { t: at, used: 40 }] }
  const held = { ...spendTurn(NO_SPEND, at - MINUTE, usage(1000)), perPoint: { five_hour: 100, seven_day: 1000 } }

  expect(details('five_hour', window, at, held)).toContain('8h–18h – · 1k')
  expect(details('five_hour', window, at, held)).toContain('24h – · 1k')
  expect(details('seven_day', window, at, held)).toContain('24h ~1% · 1k')
})

test('beside the check, how long what is left would last at this pace', () => {
  // 30 points an hour, 60 left: two hours, with three to the reset.
  const samples = [
    { t: START, used: 10 },
    { t: START + 60 * MINUTE, used: 40 },
  ]
  const at = START + 60 * MINUTE
  const window = { samples, resetsAt: new Date(at + 180 * MINUTE).toISOString() }
  expect(forecast('five_hour', window, at)).toBe('esgota em ~2h00')
  expect(lasting('five_hour', window, at)).toBe('')

  const slow = { samples: [{ t: START, used: 10 }, { t: at, used: 20 }], resetsAt: new Date(at + 180 * MINUTE).toISOString() }
  expect(forecast('five_hour', slow, at)).toBe('✓')
  expect(lasting('five_hour', slow, at)).toBe('dura ~8h00')

  // The weekly window walks the person's week past the reset to say it: Thursday at 12h49.
  const week = { samples: [{ t: local(19, 20), used: 90 }], resetsAt: new Date(local(21, 23)).toISOString() }
  const held = { ...NO_SPEND, hours: workWeek(19, 20), hoursSince: local(11, 23), perPoint: { seven_day: 100 } }
  expect(lasting('seven_day', week, local(19, 20), held)).toBe('dura ~2d16h')
})
