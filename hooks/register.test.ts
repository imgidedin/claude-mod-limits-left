import { expect, mock, test } from 'claude-code/testing'

import { cardSvg, details, forecast, isOverPace, record, usedIn } from './register'

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
  expect(forecast({ samples }, at)).toBe('esgota em ~2h00')
  expect(forecast({ samples, resetsAt: new Date(at + 90 * MINUTE).toISOString() }, at)).toBe('✓')
  expect(forecast({ samples: [{ t: START, used: 10 }] }, START + MINUTE)).toBe('coletando dados')
  expect(forecast({ samples: [{ t: START, used: 10 }] }, at)).toBe('✓')
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
  mock.clock(on, { now: START + 30 * MINUTE })
  mock.store(on, { windows: { five_hour: { samples: [{ t: START, used: 10 }] } } })
  on('session.measure', (_, e) => ({ changed: e.changed }))
  on('ui.render', () => ({ type: 'Box', children: [{ type: 'Text', children: ['another band'] }] }))

  await measure($, [{ kind: 'five_hour', percentUsed: 25 }])
  await $.command.run({ command: 'limits', args: '' } as never)

  const ui = await $.ui.mount({ plugin: 'limits-left', surface: 'terminal', component: 'AbovePrompt', props: BAND })
  const drawn = JSON.stringify(await ui.drawn())

  // 15 points in the 30 minutes on record, 75 left: two and a half hours.
  expect(drawn).toContain('esgota em ~2h30')
  expect(drawn).toContain('another band')
})

test('passes while there is no reading', async ($, on) => {
  mock.clock(on)
  mock.store(on)
  on('ui.render', () => EMPTY)

  const footer = await $.ui.mount({ plugin: 'limits-left', surface: 'terminal', component: 'SessionMode', props: { modes: [] } })

  expect(await footer.drawn()).toEqual(EMPTY)
})
