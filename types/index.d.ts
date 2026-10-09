// One reading of a window: when it was taken (ms since the epoch) and how much was used (0 to 100).
export type Sample = { t: number; used: number }

export type LimitWindow = { samples: Sample[]; resetsAt?: string }

// Keyed by the rate limit's kind (`five_hour`, `seven_day`).
export type Windows = Record<string, LimitWindow>

declare module 'claude-code' {
  interface PluginState {
    'limits-left': { windows: Windows; now: number; isOpen: boolean }
  }
}
