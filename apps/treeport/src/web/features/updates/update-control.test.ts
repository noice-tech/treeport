import { describe, expect, it } from 'vitest'
import { backendUpdateEnabled } from './update-control'

describe('backend update client policy', () => {
  it('keeps browser updates available and prevents remote Electron updates', () => {
    expect(backendUpdateEnabled(false, 'treeport.example.ts.net')).toBe(true)
    expect(backendUpdateEnabled(true, 'localhost')).toBe(true)
    expect(backendUpdateEnabled(true, '127.0.0.1')).toBe(true)
    expect(backendUpdateEnabled(true, 'treeport.example.ts.net')).toBe(false)
  })
})
