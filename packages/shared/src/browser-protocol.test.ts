import { describe, expect, it } from 'vitest'
import {
  browserAgentCommandSchema,
  parseBrowserAuth,
  parseBrowserClientMessage
} from './browser-protocol.js'

describe('hosted browser protocol', () => {
  it('accepts bounded navigation and input commands and rejects privileged URLs', () => {
    expect(
      parseBrowserClientMessage({
        type: 'navigate',
        url: 'http://localhost:5173/compositions?name=Demo#preview'
      })
    ).toEqual({
      type: 'navigate',
      url: 'http://localhost:5173/compositions?name=Demo#preview'
    })
    expect(
      parseBrowserClientMessage({
        type: 'pointer',
        phase: 'down',
        x: 400,
        y: 250,
        button: 'left'
      })
    ).toEqual({
      type: 'pointer',
      phase: 'down',
      x: 400,
      y: 250,
      button: 'left'
    })

    expect(
      parseBrowserClientMessage({ type: 'navigate', url: 'file:///etc/passwd' })
    ).toBeNull()
    expect(
      parseBrowserClientMessage({
        type: 'navigate',
        url: 'http://user:password@localhost/'
      })
    ).toBeNull()
    expect(
      parseBrowserClientMessage({
        type: 'resize',
        width: 100_000,
        height: 100_000
      })
    ).toBeNull()
  })

  it('limits agent commands to fixed arguments and HTTP navigation', () => {
    expect(
      browserAgentCommandSchema.safeParse({
        command: 'goto',
        args: ['http://localhost:5173/preview']
      }).success
    ).toBe(true)
    expect(
      browserAgentCommandSchema.safeParse({
        command: 'goto',
        args: ['file:///etc/passwd']
      }).success
    ).toBe(false)
    expect(
      browserAgentCommandSchema.safeParse({
        command: 'screenshot',
        args: ['--filename=/tmp/output.png']
      }).success
    ).toBe(false)
  })

  it('requires a bounded opaque ticket', () => {
    const ticket = 'a'.repeat(43)
    expect(parseBrowserAuth({ ticket, protocolVersion: 1 })).toEqual({
      ticket,
      protocolVersion: 1
    })
    expect(parseBrowserAuth({ ticket: 'short', protocolVersion: 1 })).toBeNull()
    expect(parseBrowserAuth({ ticket, protocolVersion: 2 })).toBeNull()
    expect(
      parseBrowserAuth({ ticket, protocolVersion: 1, panelId: 'another-panel' })
    ).toBeNull()
  })
})
