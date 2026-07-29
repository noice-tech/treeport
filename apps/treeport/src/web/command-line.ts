export type ParsedCommandLine =
  | { argv: string[]; error: null }
  | { argv: null; error: string }

export function parseCommandLine(input: string): ParsedCommandLine {
  const argv: string[] = []
  let value = ''
  let quote: 'single' | 'double' | null = null
  let started = false

  for (let index = 0; index < input.length; index += 1) {
    const character = input[index]!

    if (quote === 'single') {
      if (character === "'") {
        quote = null
      } else {
        value += character
      }

      continue
    }

    if (quote === 'double') {
      if (character === '"') {
        quote = null
      } else if (character === '\\') {
        index += 1
        if (index >= input.length) {
          return {
            argv: null,
            error: 'The command ends with an incomplete escape.'
          }
        }

        value += input[index]!
      } else {
        value += character
      }

      continue
    }

    if (/\s/.test(character)) {
      if (started) {
        argv.push(value)
        value = ''
        started = false
      }

      continue
    }

    started = true
    if (character === "'") {
      quote = 'single'
    } else if (character === '"') {
      quote = 'double'
    } else if (character === '\\') {
      index += 1
      if (index >= input.length) {
        return {
          argv: null,
          error: 'The command ends with an incomplete escape.'
        }
      }

      value += input[index]!
    } else {
      value += character
    }
  }

  if (quote) {
    return { argv: null, error: 'The command has an unclosed quote.' }
  }

  if (started) {
    argv.push(value)
  }

  if (argv.length === 0) {
    return { argv: null, error: 'Enter a command.' }
  }

  return { argv, error: null }
}

export function formatCommandLine(argv: string[]): string {
  return argv
    .map((value) => {
      if (value === '') {
        return '""'
      }

      if (!/[\s"'\\]/.test(value)) {
        return value
      }

      return `"${value.replace(/["\\]/g, '\\$&')}"`
    })
    .join(' ')
}
