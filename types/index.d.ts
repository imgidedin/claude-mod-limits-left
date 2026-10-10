// One reading of a window: when it was taken (ms since the epoch) and how much was used (0 to 100).
export type Sample = { t: number; used: number }

export type LimitWindow = { samples: Sample[]; resetsAt?: string }

// Keyed by the rate limit's kind (`five_hour`, `seven_day`).
export type Windows = Record<string, LimitWindow>

// What the turns of one minute took: every token they moved, and the same weighted by price.
export type Spent = { t: number; tokens: number; weight: number }

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
}

declare module 'claude-code' {
  interface PluginState {
    'limits-left': { windows: Windows; now: number; isOpen: boolean; spend: Spend }
  }
}
