import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'
import { filePathFromUrl } from './file-url'
import {
  localSourcePathSchema,
  resolveLocalSourcePath
} from './local-source-path'
import { isLoopbackUrl, parseComputerUrl } from './renderer-url'
import { parseWorkspaceLink } from './workspace-link'

function link(target: string): string {
  const value = new URL('treeport://open')
  value.searchParams.set('url', target)
  return value.href
}

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

describe('desktop workspace links', () => {
  it('accepts exact worktree routes on supported computers', () => {
    expect(
      parseWorkspaceLink(
        link(
          'http://127.0.0.1:8733/projects/project%20one/worktrees/worktree%26two'
        )
      )
    ).toEqual({
      origin: 'http://127.0.0.1:8733',
      url: 'http://127.0.0.1:8733/projects/project%20one/worktrees/worktree%26two'
    })
    expect(
      parseWorkspaceLink(
        link(
          'https://treeport.example.test/projects/project/worktrees/worktree'
        )
      )
    ).toEqual({
      origin: 'https://treeport.example.test',
      url: 'https://treeport.example.test/projects/project/worktrees/worktree'
    })
  })

  it('rejects malformed links, unsafe computers, and other routes', () => {
    const rejected = [
      'https://treeport.example.test',
      'treeport://other?url=http%3A%2F%2F127.0.0.1%3A8733%2Fprojects%2Fp%2Fworktrees%2Fw',
      'treeport://open/?url=http%3A%2F%2F127.0.0.1%3A8733%2Fprojects%2Fp%2Fworktrees%2Fw',
      'treeport://open?url=not-a-url',
      'treeport://open?url=http%3A%2F%2F127.0.0.1%3A8733%2Fprojects%2Fp%2Fworktrees%2Fw&url=http%3A%2F%2F127.0.0.1%3A8733%2Fprojects%2Fp%2Fworktrees%2Fw',
      link('http://treeport.example.test/projects/p/worktrees/w'),
      link('https://user@treeport.example.test/projects/p/worktrees/w'),
      link('http://127.0.0.1:8733/'),
      link('http://127.0.0.1:8733/projects/p'),
      link('http://127.0.0.1:8733/projects/p/worktrees/w/terminals/t'),
      link('http://127.0.0.1:8733/projects/p/worktrees/w?panel=one'),
      link('http://127.0.0.1:8733/projects/p/worktrees/w#terminal'),
      link('http://127.0.0.1:8733/projects/%2F/worktrees/w'),
      'treeport://open?url=http%3A%2F%2F127.0.0.1%3A8733%2Fprojects%2F%25ZZ%2Fworktrees%2Fw'
    ]
    for (const value of rejected) {
      expect(parseWorkspaceLink(value)).toBeNull()
    }
  })
})
