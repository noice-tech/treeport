import { describe, expect, it } from 'vitest'
import { formatCommandLine, parseCommandLine } from './command-line.js'

describe('terminal preset command lines', () => {
  it('turns a command into literal argv without shell expansion', () => {
    expect(
      parseCommandLine("diff main --mode split '$HOME' 'semi;colon'")
    ).toEqual({
      argv: ['diff', 'main', '--mode', 'split', '$HOME', 'semi;colon'],
      error: null
    })
  })

  it('supports quoted, escaped, and empty arguments', () => {
    expect(
      parseCommandLine('tool "two words" escaped\\ value "" "a\\\"b"')
    ).toEqual({
      argv: ['tool', 'two words', 'escaped value', '', 'a"b'],
      error: null
    })
  })

  it('reports incomplete input', () => {
    expect(parseCommandLine('tool "unfinished')).toEqual({
      argv: null,
      error: 'The command has an unclosed quote.'
    })
    expect(parseCommandLine('tool trailing\\')).toEqual({
      argv: null,
      error: 'The command ends with an incomplete escape.'
    })
  })

  it('formats every argv value for an exact round trip', () => {
    const argv = [
      '/Applications/My Tool/bin/tool',
      'two words',
      '',
      '$HOME',
      'semi;colon',
      'a"b',
      "single'quote",
      'back\\slash',
      '世界'
    ]
    expect(parseCommandLine(formatCommandLine(argv))).toEqual({
      argv,
      error: null
    })
  })
})
