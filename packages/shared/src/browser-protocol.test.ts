import { describe, expect, it } from 'vitest'
import {
  browserAgentCommandSchema as browserAgentCommandEffectSchema,
  browserOwnerAuthSchema as browserOwnerAuthEffectSchema,
  browserOwnerClientMessageSchema as browserOwnerClientMessageEffectSchema,
  browserOwnerServerMessageSchema as browserOwnerServerMessageEffectSchema,
  browserControllerDescription,
  parseBrowserAuth,
  parseBrowserClientMessage,
  parseBrowserServerMessage
} from './browser-protocol.js'
import { testSchema } from './schema.test-support.js'

const browserAgentCommandSchema = testSchema(browserAgentCommandEffectSchema)
const browserOwnerAuthSchema = testSchema(browserOwnerAuthEffectSchema)
const browserOwnerClientMessageSchema = testSchema(
  browserOwnerClientMessageEffectSchema
)
const browserOwnerServerMessageSchema = testSchema(
  browserOwnerServerMessageEffectSchema
)

describe('hosted browser protocol', () => {
  it('accepts bounded navigation and input commands and rejects unsupported URLs', () => {
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

    const wheel = {
      type: 'wheel',
      x: 100,
      y: 200,
      deltaX: 0,
      deltaY: -40,
      modifiers: 2
    }
    expect(parseBrowserClientMessage(wheel)).toEqual(wheel)
    expect(
      parseBrowserClientMessage({ ...wheel, modifiers: 15 })
    ).not.toBeNull()
    expect(parseBrowserClientMessage({ ...wheel, modifiers: 16 })).toBeNull()
    expect(parseBrowserClientMessage({ ...wheel, x: Infinity })).toBeNull()

    const key = { type: 'key', phase: 'down', key: 'k', modifiers: 4 }
    expect(parseBrowserClientMessage(key)).toEqual(key)
    expect(parseBrowserClientMessage({ ...key, modifiers: 15 })).not.toBeNull()
    expect(parseBrowserClientMessage({ ...key, modifiers: -1 })).toBeNull()
    expect(parseBrowserClientMessage({ ...key, modifiers: 16 })).toBeNull()

    const touch = {
      type: 'touch',
      phase: 'start',
      points: [
        { id: 1, x: 100, y: 200 },
        { id: 2, x: 300, y: 200 }
      ]
    }
    expect(parseBrowserClientMessage(touch)).toEqual(touch)
    expect(
      parseBrowserClientMessage({ ...touch, phase: 'move' })
    ).not.toBeNull()
    expect(
      parseBrowserClientMessage({
        ...touch,
        phase: 'end',
        points: [touch.points[0]]
      })
    ).not.toBeNull()
    expect(
      parseBrowserClientMessage({ ...touch, phase: 'cancel', points: [] })
    ).not.toBeNull()
    for (const invalid of [
      { ...touch, points: [] },
      { ...touch, phase: 'cancel' },
      { ...touch, points: [touch.points[0], touch.points[0]] },
      { ...touch, points: [{ id: 1, x: Infinity, y: 0 }] },
      { ...touch, points: [{ id: -1, x: 0, y: 0 }] },
      {
        ...touch,
        points: Array.from({ length: 11 }, (_, id) => ({ id, x: 0, y: 0 }))
      }
    ]) {
      expect(parseBrowserClientMessage(invalid)).toBeNull()
    }

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

    for (const url of [
      'file:///tmp/preview%20draft.html?view=1#section',
      'file://localhost/tmp/preview.html',
      'file:///C:/Users/example/preview.html',
      'chrome://gpu',
      'chrome://gpu/',
      'chrome://settings/appearance',
      'chrome://version'
    ]) {
      expect(parseBrowserClientMessage({ type: 'navigate', url })).toEqual({
        type: 'navigate',
        url
      })
    }
    for (const url of [
      'file://server/share/preview.html',
      'file://user:password@localhost/tmp/preview.html',
      'javascript:alert(1)',
      'data:text/html,preview',
      'ftp://example.com/preview.html',
      'chrome:gpu',
      'chrome:///gpu',
      'chrome://gpu:1234',
      'chrome://user:password@gpu',
      'chrome-extension://example/page.html'
    ]) {
      expect(parseBrowserClientMessage({ type: 'navigate', url })).toBeNull()
    }
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

  it('limits agent commands to fixed arguments and supported navigation', () => {
    expect(
      browserAgentCommandSchema.safeParse({
        command: 'goto',
        args: ['http://localhost:5173/preview']
      }).success
    ).toBe(true)
    for (const url of ['file:///tmp/preview.html', 'chrome://gpu']) {
      expect(
        browserAgentCommandSchema.safeParse({
          command: 'goto',
          args: [url]
        }).success
      ).toBe(true)
    }
    expect(
      browserAgentCommandSchema.safeParse({
        command: 'screenshot',
        args: ['--filename=/tmp/output.png']
      }).success
    ).toBe(false)
  })

  it('accepts bounded video signaling and rejects the retired frame protocol', () => {
    const offer = { type: 'videoOffer', requestId: 'request', sdp: 'v=0' }
    expect(parseBrowserClientMessage(offer)).toEqual(offer)
    expect(parseBrowserClientMessage({ ...offer, sdp: '' })).toBeNull()
    expect(
      parseBrowserClientMessage({ ...offer, sdp: 'x'.repeat(65_537) })
    ).toBeNull()
    expect(
      parseBrowserClientMessage({ type: 'frameAck', sequence: 1 })
    ).toBeNull()
    expect(
      parseBrowserClientMessage({ type: 'requestVideoKeyframe' })
    ).toBeNull()
    const answer = { ...offer, type: 'videoAnswer' }
    expect(parseBrowserServerMessage(answer)).toEqual(answer)
    expect(parseBrowserServerMessage({ type: 'videoReady' })).not.toBeNull()
    const account = {
      source: 'tailscale',
      login: 'alice@example.test',
      name: 'Alice',
      profilePicture: null
    } as const
    const details = {
      kind: 'viewer',
      account,
      sameAccount: true,
      sameDevice: true
    } as const
    expect(browserControllerDescription(details)).toBe(
      'Another window on this device controls this browser.'
    )
    expect(
      browserControllerDescription({ ...details, sameDevice: false })
    ).toBe('Another window or device on your account controls this browser.')
    expect(
      browserControllerDescription({
        ...details,
        sameAccount: false,
        sameDevice: false
      })
    ).toBe('Alice controls this browser.')
    expect(
      browserControllerDescription({
        kind: 'local',
        account: null,
        sameAccount: false,
        sameDevice: false
      })
    ).toBe('A desktop window on the server controls this browser.')
    expect(browserControllerDescription(null)).toBe(
      'Another window or device controls this browser.'
    )
  })

  it('requires a bounded opaque ticket', () => {
    const ticket = 'a'.repeat(43)
    expect(parseBrowserAuth({ ticket })).toEqual({ ticket })
    expect(parseBrowserAuth({ ticket: 'short' })).toBeNull()
    expect(
      parseBrowserAuth({
        ticket,
        panelId: 'another-panel'
      })
    ).toBeNull()

    expect(
      browserOwnerAuthSchema.safeParse({
        ticket,
        challenge: 'c'.repeat(43),
        endpoint: 'http://127.0.0.1:43210/private/'
      }).success
    ).toBe(true)
    expect(
      browserOwnerAuthSchema.safeParse({
        ticket,
        challenge: 'c'.repeat(43),
        endpoint: 'http://localhost:43210/private/'
      }).success
    ).toBe(false)
    const readyState = {
      url: 'file:///tmp/preview.html',
      title: 'Ready page',
      faviconUrl: null,
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
        viewport: { width: 375, height: 812 },
        retainPaint: true,
        agentActive: false
      }).success
    ).toBe(true)
  })
})
