// One reading of a window: when it was taken (ms since the epoch) and how much was used (0 to 100).
export type Sample = { t: number; used: number }

export type LimitWindow = { samples: Sample[]; resetsAt?: string }

// Keyed by the rate limit's kind (`five_hour`, `seven_day`).
export type Windows = Record<string, LimitWindow>

// What the turns of one minute took: every token they moved, the same weighted by price, and
// what they cost in US dollars at list price, where the session keeps a ledger.
export type Spent = { t: number; tokens: number; weight: number; usd?: number }

// The turns' own count, which says where a window is between two whole points of its reading.
export type Spend = {
  // The weight of every turn on record; it only grows.
  total: number
  // When the count began; absent on one kept from before it was recorded.
  since?: number
  // The last day: one entry a minute for the last hour, further apart before it.
  events: Spent[]
  // By window kind: `total` when its reading last moved up a whole point.
  marks: Record<string, number>
  // By window kind: the weight one point of it took, as the points seen so far measured it.
  perPoint: Record<string, number>
  // The weight of this machine's own turns; `total` adds the other machines' to it. Absent on
  // a count kept from before the machines were synced, all of whose turns were this one's.
  own?: number
  // By device: the other machines as the last sync found them.
  peers?: Record<string, Peer>
  // This machine's own turns, hour by hour (`t` the hour's start), for four weeks: what the
  // forecast learns the person's week from.
  hours?: Hourly[]
  // When the hours began: an hour after it with nothing on record is an hour not used.
  hoursSince?: number
  // When the hours began to carry `points`: the forecast learns the week from these alone.
  pointsSince?: number
}

// The weight of one hour's turns, and the points of the weekly window it took, as the weight of
// a point stood when it was spent. A point's weight moves (another model, another limit), so the
// weight alone, read by today's point, says nothing of an hour of last week.
export type Hourly = { t: number; weight: number; points?: number }

// Another machine: the weight of its own turns, its last day of them, its hours, and since
// when it counted those and their points.
export type Peer = { own: number; events: Spent[]; hours?: Hourly[]; since?: number; pointsSince?: number }

// What a machine sends the sync server, and what the server keeps of each.
export type DeviceState = { own: number; events: Spent[]; windows: Windows; hours?: Hourly[]; since?: number; pointsSince?: number }

declare module 'claude-code' {
  interface PluginState {
    'limits-left': { windows: Windows; now: number; isOpen: boolean; spend: Spend; seenUsd: number }
  }
}
