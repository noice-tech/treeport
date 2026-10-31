import kleur from 'kleur'

export type OutputTone = 'success' | 'warning' | 'failure' | 'neutral'

export function humanOutput(
  environment: NodeJS.ProcessEnv = process.env,
  isTTY = false,
  json = false
) {
  const force = environment.FORCE_COLOR

  const enabled =
    !json &&
    environment.NO_COLOR === undefined &&
    !environment.NODE_DISABLE_COLORS &&
    (force !== undefined
      ? force !== '0' && force !== 'false'
      : isTTY && environment.TERM !== 'dumb')

  const style = (format: (text: string) => string) => (text: string) => {
    if (!enabled || !text) {
      return text
    }

    // EXTERNAL: Kleur has one global switch. Scope it to a synchronous call so stdout,
    // stderr, and other consumers never inherit each other's color policy.
    const previous = kleur.enabled
    kleur.enabled = true

    try {
      return format(text)
    } finally {
      kleur.enabled = previous
    }
  }

  const heading = style(kleur.bold)
  const detail = style(kleur.dim)
  const action = style(kleur.cyan)

  const tones = {
    success: style(kleur.green),
    warning: style(kleur.yellow),
    failure: style(kleur.red),
    neutral: (text: string) => text
  }

  const indent = (text: string) =>
    text
      ? text
          .split('\n')
          .map((line) => `  ${line}`)
          .join('\n')
      : ''

  const summary = (text: string, tone: OutputTone = 'neutral') =>
    tones[tone](
      `${{ success: '✓ ', warning: '! ', failure: '✖ ', neutral: '' }[tone]}${text}`
    )

  const section = (title: string, text: string) =>
    `${heading(title)}\n${indent(text)}`

  const rows = (values: ([string, string | number] | null)[]) => {
    const entries = values.filter((entry) => entry !== null)
    const width = Math.max(0, ...entries.map(([label]) => label.length))

    return entries
      .map(
        ([label, value]) =>
          `  ${label.padEnd(width)}  ${String(value).replaceAll('\n', '\n' + ' '.repeat(width + 4))}`
      )
      .join('\n')
  }

  const next = (commands: string[]) =>
    commands.length
      ? section(
          'Next',
          commands
            .map((command, index) => (index === 0 ? action(command) : command))
            .join('\n')
        )
      : ''

  const blocks = (...parts: (string | null | false | undefined)[]) =>
    parts.filter(Boolean).join('\n\n')

  return {
    enabled,
    heading,
    detail,
    action,
    summary,
    section,
    rows,
    next,
    blocks,
    indent
  }
}

export type HumanOutput = ReturnType<typeof humanOutput>

export function stateName(state: string): string {
  const words = state.replaceAll('_', ' ')

  return words.charAt(0).toUpperCase() + words.slice(1)
}
