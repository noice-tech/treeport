import { describe, expect, it } from 'vitest'
import { parseRendererUrl } from './renderer-url'

describe('desktop renderer URL', () => {
  it('accepts loopback HTTP URLs while rejecting other origins', () => {
    expect(
      parseRendererUrl('http://127.0.0.1:5173/path?query=1#hash').href
    ).toBe('http://127.0.0.1:5173/')
    expect(() =>
      parseRendererUrl('https://fix-ui.treeport.localhost/workspace')
    ).toThrow('TREEPORT_DESKTOP_URL must use HTTP on loopback')
    expect(() => parseRendererUrl('https://treeport.example.com')).toThrow(
      'TREEPORT_DESKTOP_URL must use HTTP on loopback'
    )
    expect(() => parseRendererUrl('not a URL')).toThrow(
      'TREEPORT_DESKTOP_URL must be a valid local URL'
    )
  })
})
