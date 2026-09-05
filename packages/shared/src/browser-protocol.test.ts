import { describe, expect, it } from 'vitest'
import {
  BROWSER_MAX_FRAME_BYTES,
  browserAgentCommandSchema as browserAgentCommandEffectSchema,
  browserFrameSchema as browserFrameEffectSchema,
  browserOwnerAuthSchema as browserOwnerAuthEffectSchema,
  browserOwnerClientMessageSchema as browserOwnerClientMessageEffectSchema,
  browserOwnerServerMessageSchema as browserOwnerServerMessageEffectSchema,
  BROWSER_PROTOCOL_VERSION,
  parseBrowserAuth,
  parseBrowserClientMessage,
  encodeBrowserFrame,
  decodeBrowserFrame
} from './browser-protocol.js'
import { testSchema } from './schema.test-support.js'

const browserAgentCommandSchema = testSchema(browserAgentCommandEffectSchema)
const browserFrameSchema = testSchema(browserFrameEffectSchema)
const browserOwnerAuthSchema = testSchema(browserOwnerAuthEffectSchema)
const browserOwnerClientMessageSchema = testSchema(
  browserOwnerClientMessageEffectSchema
)
const browserOwnerServerMessageSchema = testSchema(
  browserOwnerServerMessageEffectSchema
)

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
      parseBrowserClientMessage({
        type: 'find',
        text: 'Browser target',
        forward: true,
        findNext: false
      })
    ).toEqual({
      type: 'find',
      text: 'Browser target',
      forward: true,
      findNext: false
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

  it('round-trips video dependencies and rejects invalid or oversized frames', () => {
    const frame = {
      sequence: 1,
      mimeType: 'video/vp8' as const,
      keyframe: true,
      timestamp: 1,
      width: 1,
      height: 1
    }
    const keyframe = { ...frame, data: Uint8Array.from([1, 2, 3]) }
    const delta = {
      ...keyframe,
      sequence: 2,
      keyframe: false,
      timestamp: 33_334
    }
    expect(decodeBrowserFrame(encodeBrowserFrame(keyframe))).toMatchObject(
      keyframe
    )
    expect(decodeBrowserFrame(encodeBrowserFrame(delta))).toMatchObject(delta)
    expect(
      decodeBrowserFrame(encodeBrowserFrame(delta).subarray(0, -1))
    ).toBeNull()
    expect(
      decodeBrowserFrame(encodeBrowserFrame({ ...delta, width: 100_000 }))
    ).toBeNull()
    expect(
      decodeBrowserFrame(encodeBrowserFrame({ ...delta, timestamp: Infinity }))
    ).toBeNull()
    expect(
      browserFrameSchema.safeParse({ ...frame, data: new Uint8Array([1]) })
        .success
    ).toBe(true)
    expect(
      browserFrameSchema.parse({
        ...frame,
        data: Uint8Array.from([1, 2, 3]).buffer
      }).data
    ).toEqual(Uint8Array.from([1, 2, 3]))
    expect(
      browserFrameSchema.safeParse({
        ...frame,
        data: new Uint8Array(BROWSER_MAX_FRAME_BYTES + 1)
      }).success
    ).toBe(false)
  })

  it('requires a bounded opaque ticket', () => {
    const ticket = 'a'.repeat(43)
    expect(
      parseBrowserAuth({ ticket, protocolVersion: BROWSER_PROTOCOL_VERSION })
    ).toEqual({
      ticket,
      protocolVersion: BROWSER_PROTOCOL_VERSION
    })
    expect(parseBrowserAuth({ ticket: 'short', protocolVersion: 1 })).toBeNull()
    expect(parseBrowserAuth({ ticket, protocolVersion: 1 })).toBeNull()
    expect(
      parseBrowserAuth({
        ticket,
        protocolVersion: BROWSER_PROTOCOL_VERSION,
        panelId: 'another-panel'
      })
    ).toBeNull()

    expect(
      browserOwnerAuthSchema.safeParse({
        ticket,
        challenge: 'c'.repeat(43),
        protocolVersion: BROWSER_PROTOCOL_VERSION,
        endpoint: 'http://127.0.0.1:43210/private/'
      }).success
    ).toBe(true)
    expect(
      browserOwnerAuthSchema.safeParse({
        ticket,
        challenge: 'c'.repeat(43),
        protocolVersion: BROWSER_PROTOCOL_VERSION,
        endpoint: 'http://localhost:43210/private/'
      }).success
    ).toBe(false)
    const readyState = {
      url: 'https://example.com/ready',
      title: 'Ready page',
      loading: false,
      canGoBack: false,
      canGoForward: false,
      viewport: { width: 800, height: 600 }
    }
    expect(
      browserOwnerClientMessageSchema.safeParse({
        type: 'ready',
        generation: 1,
        revision: 1,
        state: readyState
      }).success
    ).toBe(true)
    expect(
      browserOwnerClientMessageSchema.safeParse({
        type: 'state',
        generation: 0,
        revision: 1,
        state: readyState
      }).success
    ).toBe(false)
    expect(
      browserOwnerServerMessageSchema.safeParse({
        type: 'claimGranted',
        panelId: 'panel-browser',
        generation: 1,
        resumed: true,
        state: readyState
      }).success
    ).toBe(true)
    expect(
      browserOwnerClientMessageSchema.safeParse({
        type: 'takeControl',
        generation: 1
      }).success
    ).toBe(true)
    expect(
      browserOwnerClientMessageSchema.safeParse({
        type: 'released',
        generation: 1
      }).success
    ).toBe(true)
    expect(
      browserOwnerServerMessageSchema.safeParse({
        type: 'runtimeControl',
        generation: 1,
        requestId: 'remote-control',
        controller: 'other',
        retainPaint: true
      }).success
    ).toBe(true)
  })
})
