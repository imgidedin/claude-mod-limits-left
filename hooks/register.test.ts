import { expect, mock, test } from 'claude-code/testing'

import { NO_SPEND, cardSvg, details, forecast, fraction, isOverPace, record, spendTurn, turnPoint, usedIn } from './register'

const MINUTE = 60_000
const EMPTY = { type: 'Box' } as const
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
    'Limite de sessão · 5h: 40% usado · 15m 7.5% · 30m 15% · 1h 30% · esgota em ~2h00',
  )
})

test('the card says the pace is fine with a check and nothing to read', () => {
  const samples = [
    { t: START, used: 10 },
    { t: START + 60 * MINUTE, used: 40 },
  ]
  const at = START + 60 * MINUTE
  const fine = cardSvg('five_hour', { samples, resetsAt: new Date(at + 90 * MINUTE).toISOString() }, at)
  const short = cardSvg('five_hour', { samples, resetsAt: new Date(at + 240 * MINUTE).toISOString() }, at)

  expect(fine).toContain('class="ok"')
  expect(fine).toContain('Reinicia em 1h30')
  expect(fine).not.toContain('esgota')
  expect(short).toContain('esgota em ~2h00')
  expect(short).not.toContain('class="ok"')
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
      expect(await footer.drawn()).toMatchObject({ type: 'Text', children: ['focus  ◷ 60% ⚠ · ▦ 91%'] })
    } else {
      expect(await footer.find({ key: 'limits-five_hour' })).toMatchObject({ type: 'Button', text: '  🕐︎ 60% 🛑  ' })
      expect(await footer.find({ key: 'limits-seven_day' })).toMatchObject({ type: 'Button', text: '  📅︎ 91%  ' })
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
    expect(await band.drawn()).toEqual(EMPTY)

    expect(await $.command.run({ command: 'limits', args: '' } as never)).toMatchObject({ text: 'Cartões de uso abertos acima do prompt.' })
    await band.redraw()
    expect(JSON.stringify(await band.drawn())).toContain('No ritmo atual')

    await band.press({ key: 'limits-close' })
    await band.redraw()
    expect(await band.drawn()).toEqual(EMPTY)

    if (surface === 'desktop') {
      const footer = await $.ui.mount({ plugin: 'limits-left', surface, component: 'SessionMode', props: { modes: [] } })
      await footer.press({ key: 'limits-five_hour' })
      await band.redraw()
      expect(JSON.stringify(await band.drawn())).toContain('Limite de sess')
      expect(JSON.stringify(await band.drawn())).toContain('Semanal')

      await footer.press({ key: 'limits-seven_day' })
      await band.redraw()
      expect(await band.drawn()).toEqual(EMPTY)
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
  expect(drawn).toContain('esgota em ~5h00')
  expect(drawn).toContain('another band')
})

test('passes while there is no reading', async ($, on) => {
  mock.clock(on)
  mock.store(on)
  on('ui.render', () => EMPTY)

  const footer = await $.ui.mount({ plugin: 'limits-left', surface: 'terminal', component: 'SessionMode', props: { modes: [] } })

  expect(await footer.drawn()).toEqual(EMPTY)
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

  // A reset takes the mark and keeps what a point takes.
  spend = turnPoint(spend, 'seven_day', 67, 0)
  expect(fraction(spend, 'seven_day')).toBe(undefined)
  expect(spend.perPoint.seven_day).toBe(1000)
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
    'Semanal · 7d: 66% usado · 15m <1% · 200k · 30m <1% · 200k · 1h – · 200k · ✓',
  )

  const calibrated = { ...uncalibrated, marks: { seven_day: 0 }, perPoint: { seven_day: 500_000 } }
  expect(details('seven_day', window, at, calibrated)).toBe(
    'Semanal · 7d: ~66.4% usado · 15m ~0.4% · 200k · 30m ~0.4% · 200k · 1h ~0.4% · 200k · ✓',
  )
  expect(cardSvg('seven_day', window, at, calibrated)).toContain('~66.4%')
  // The card is markup: a bare `<` in a figure would leave it undrawn.
  expect(cardSvg('seven_day', window, at, uncalibrated)).toContain('&lt;1% · 200k')
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
  expect(drawn).toContain('~1.3% · 1.3k')
})

test('toasts once when a reading puts a window over its pace', async ($, on) => {
  const clock = mock.clock(on, { now: START })
  mock.store(on)
  const toasts: string[] = []
  on('session.measure', (_, e) => ({ changed: e.changed }))
  on('ui.toast', (_, e) => {
    toasts.push(e.text)

    return { value: undefined }
  })
  const resetsAt = (minutes: number) => new Date(clock.now() + minutes * MINUTE).toISOString()

  await measure($, [{ kind: 'five_hour', percentUsed: 10, resetsAt: resetsAt(300) }])
  expect(toasts).toEqual([])

  // 30 points in the hour, 60 left: out in two hours, with four to the reset.
  await clock.advance(60 * MINUTE)
  await measure($, [{ kind: 'five_hour', percentUsed: 40, resetsAt: resetsAt(240) }])
  expect(toasts).toEqual(['5h acima do ritmo · esgota em ~2h00'])

  // Still over it a minute later: nothing more to say.
  await clock.advance(MINUTE)
  await measure($, [{ kind: 'five_hour', percentUsed: 41, resetsAt: resetsAt(239) }])
  expect(toasts.length).toBe(1)
})

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
