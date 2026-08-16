const DURATION_UNITS = new Map([
  ['ms', 1],
  ['s', 1_000],
  ['m', 60_000],
  ['h', 3_600_000]
])

const MAX_DURATION_MS = 2_147_483_647

export function parseDurationMs(value: string): number {
  const match = /^(\d+)(ms|s|m|h)$/.exec(value)
  if (!match) {
    throw new Error(
      'Timeout must be a positive duration such as 500ms, 30s, 5m, or 1h'
    )
  }

  const amount = Number(match[1])
  const multiplier = DURATION_UNITS.get(match[2] ?? '')
  if (multiplier === undefined) {
    throw new Error('Timeout has an unsupported duration unit')
  }

  const timeoutMs = amount * multiplier
  if (
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs <= 0 ||
    timeoutMs > MAX_DURATION_MS
  ) {
    throw new Error('Timeout must be between 1ms and 2147483647ms')
  }

  return timeoutMs
}
