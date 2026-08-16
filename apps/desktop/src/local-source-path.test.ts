import { describe, expect, it } from 'vitest'
import {
  localSourcePathSchema,
  resolveLocalSourcePath
} from './local-source-path'

describe('local terminal source path policy', () => {
  it('accepts absolute platform paths only for loopback Treeport connections', () => {
    const sourcePath = "/Users/example/Desktop/notes '$draft.txt"

    expect(resolveLocalSourcePath('http://127.0.0.1:8733', sourcePath)).toBe(
      sourcePath
    )
    expect(
      resolveLocalSourcePath('https://treeport.example.test', sourcePath)
    ).toBeNull()
    expect(localSourcePathSchema.safeParse('notes.txt').success).toBe(false)
    expect(localSourcePathSchema.safeParse('/tmp/line\nbreak').success).toBe(
      false
    )
  })
})
