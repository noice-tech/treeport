import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'
import { filePathFromUrl } from './file-url.js'

describe('filePathFromUrl', () => {
  it('converts canonical absolute file URLs including spaces and Unicode', () => {
    const filePath = path.resolve('fixtures', 'résumé draft.txt')

    expect(filePathFromUrl(pathToFileURL(filePath).href)).toBe(filePath)
  })

  it('rejects non-local, ambiguous, and malformed file targets', () => {
    for (const value of [
      null,
      'https://example.test/file.txt',
      'file:relative.txt',
      'file:/tmp/file.txt',
      'file://server/share/file.txt',
      'file:///tmp/file.txt?download=1',
      'file:///tmp/file.txt#L10',
      'file:///tmp/a%2Fb.txt',
      'file:///tmp/a%5Cb.txt',
      'file:///tmp/a%00b.txt',
      'file:///tmp/a%zzb.txt'
    ]) {
      expect(filePathFromUrl(value)).toBeNull()
    }
  })
})
