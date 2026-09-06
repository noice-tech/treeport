import { stripVTControlCharacters } from 'node:util'
import kleur from 'kleur'
import { describe, expect, it } from 'vitest'
import { humanOutput } from './output.js'

describe('human output color boundary', () => {
  it.each([
    { environment: {}, tty: true, json: false, color: true },
    { environment: {}, tty: false, json: false, color: false },
    { environment: { NO_COLOR: '' }, tty: true, json: false, color: false },
    {
      environment: { NO_COLOR: '1', FORCE_COLOR: '1' },
      tty: true,
      json: false,
      color: false
    },
    { environment: { FORCE_COLOR: '0' }, tty: true, json: false, color: false },
    {
      environment: { FORCE_COLOR: 'false' },
      tty: true,
      json: false,
      color: false
    },
    ...['', '1', '2', '3', 'true'].map((force) => ({
      environment: { FORCE_COLOR: force },
      tty: false,
      json: false,
      color: true
    })),
    { environment: { TERM: 'dumb' }, tty: true, json: false, color: false },
    {
      environment: { TERM: 'dumb', FORCE_COLOR: '1' },
      tty: false,
      json: false,
      color: true
    },
    { environment: { FORCE_COLOR: '1' }, tty: true, json: true, color: false }
  ])(
    'formats without changing color policy for other consumers: %j',
    ({ environment, tty, json, color }) => {
      const previous = kleur.enabled
      const output = humanOutput(environment, tty, json)
      const text = output.blocks(
        output.heading('Treeport'),
        output.summary('Healthy', 'success'),
        output.summary('Action required', 'warning'),
        output.summary('Failed', 'failure'),
        output.detail('Secondary detail'),
        output.next(['treeport start'])
      )
      expect(text.includes('\u001b')).toBe(color)
      expect(stripVTControlCharacters(text)).toBe(
        'Treeport\n\n✓ Healthy\n\n! Action required\n\n✖ Failed\n\nSecondary detail\n\nNext\n  treeport start'
      )
      if (color) {
        for (const code of [1, 2, 31, 32, 33, 36]) {
          expect(text).toContain(`\u001b[${code}m`)
        }
      }

      expect(kleur.enabled).toBe(previous)
    }
  )
})
