import { describe, expect, it } from 'vitest'
import { parseWorkspaceLink } from './workspace-link'

function link(target: string): string {
  const value = new URL('treeport://open')
  value.searchParams.set('url', target)
  return value.href
}

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
