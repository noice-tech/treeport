const DURATION_UNITS = {
  ms: 1,
  s: 1_000,
  m: 60_000,
  h: 3_600_000
} as const

const MAX_DURATION_MS = 2_147_483_647

export function parseDurationMs(value: string): number {
  const match = /^(\d+)(ms|s|m|h)$/.exec(value)
  if (!match) {
    throw new Error(
      'Timeout must be a positive duration such as 500ms, 30s, 5m, or 1h'
    )
  }

  const amount = Number(match[1])
  const timeoutMs =
    amount * DURATION_UNITS[match[2] as keyof typeof DURATION_UNITS]
  if (
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs <= 0 ||
    timeoutMs > MAX_DURATION_MS
  ) {
    throw new Error('Timeout must be between 1ms and 2147483647ms')
  }

  return timeoutMs
}
