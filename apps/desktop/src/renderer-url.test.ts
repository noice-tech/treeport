import { describe, expect, it } from 'vitest'
import { isLoopbackUrl, parseComputerUrl } from './renderer-url'

describe('desktop computer URL policy', () => {
  it('normalizes supported local and private HTTPS origins', () => {
    expect(
      parseComputerUrl('http://127.0.0.1:5173/path?query=1#hash').href
    ).toBe('http://127.0.0.1:5173/')
    expect(
      parseComputerUrl('https://treeport.example.com/workspace').href
    ).toBe('https://treeport.example.com/')
    expect(isLoopbackUrl(parseComputerUrl('https://[::1]:8733'))).toBe(true)
  })

  it('rejects insecure remote and ambiguous URLs', () => {
    expect(() => parseComputerUrl('http://treeport.example.com')).toThrow(
      'Remote computers must use HTTPS.'
    )
    expect(() => parseComputerUrl('https://user@example.com')).toThrow(
      'cannot include a username or password'
    )
    expect(() => parseComputerUrl('file:///tmp/treeport')).toThrow(
      'must use HTTP or HTTPS'
    )
    expect(() => parseComputerUrl('not a URL')).toThrow(
      'Enter a valid HTTP or HTTPS URL.'
    )
  })
})
