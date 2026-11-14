export function extractJsonOutput(args: string[]): boolean {
  const separator = args.indexOf('--')

  const index = args.findIndex(
    (value, valueIndex) =>
      value === '--json' && (separator === -1 || valueIndex < separator)
  )

  if (index === -1) {
    return false
  }

  args.splice(index, 1)

  return true
}

export function extractComputer(args: string[]): string | null {
  const separator = args.indexOf('--')

  const index = args.findIndex(
    (value, valueIndex) =>
      (value === '--computer' || value.startsWith('--computer=')) &&
      (separator === -1 || valueIndex < separator)
  )

  if (index === -1) {
    return null
  }

  if (args[index]!.startsWith('--computer=')) {
    return args.splice(index, 1)[0]!.slice('--computer='.length).trim()
  }

  const value = args[index + 1]

  const hasValue =
    value !== undefined && value !== '--' && !value.startsWith('-')

  args.splice(index, hasValue ? 2 : 1)

  return hasValue ? value.trim() : ''
}
