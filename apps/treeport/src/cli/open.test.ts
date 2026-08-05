import { describe, expect, it } from 'vitest'
import { openWorkspace, type LaunchCommand } from './open'

const workspaceUrl =
  'http://127.0.0.1:8733/projects/project%20one/worktrees/worktree%26two'

describe('workspace launcher', () => {
  it('prefers the macOS desktop app and falls back to each platform browser', async () => {
    const desktopCalls: Array<{ executable: string; args: string[] }> = []
    const desktop = await openWorkspace(workspaceUrl, {
      platform: 'darwin',
      launch: async (executable, args) => {
        desktopCalls.push({ executable, args })
        return { code: 0, stderr: '' }
      }
    })

    expect(desktop).toEqual({ client: 'desktop' })
    expect(desktopCalls).toHaveLength(1)
    expect(desktopCalls[0]).toMatchObject({
      executable: 'open',
      args: ['-b', 'tech.noice.treeport', expect.stringMatching(/^treeport:/)]
    })
    expect(new URL(desktopCalls[0]!.args[2]!).searchParams.get('url')).toBe(
      workspaceUrl
    )

    const fallbackCalls: Array<{ executable: string; args: string[] }> = []
    const fallback = await openWorkspace(workspaceUrl, {
      platform: 'darwin',
      launch: async (executable, args) => {
        fallbackCalls.push({ executable, args })
        return fallbackCalls.length === 1
          ? { code: 1, stderr: 'Application not found' }
          : { code: 0, stderr: '' }
      }
    })
    expect(fallback).toEqual({ client: 'browser' })
    expect(fallbackCalls[1]).toEqual({
      executable: 'open',
      args: [workspaceUrl]
    })

    const linuxCalls: Array<{ executable: string; args: string[] }> = []
    expect(
      await openWorkspace(workspaceUrl, {
        platform: 'linux',
        launch: async (executable, args) => {
          linuxCalls.push({ executable, args })
          return { code: 0, stderr: '' }
        }
      })
    ).toEqual({ client: 'browser' })
    expect(linuxCalls).toEqual([
      { executable: 'xdg-open', args: [workspaceUrl] }
    ])

    const insecureRemoteCalls: Array<{
      executable: string
      args: string[]
    }> = []
    await openWorkspace(
      'http://treeport.example.test/projects/project/worktrees/worktree',
      {
        platform: 'darwin',
        launch: async (executable, args) => {
          insecureRemoteCalls.push({ executable, args })
          return { code: 0, stderr: '' }
        }
      }
    )
    expect(insecureRemoteCalls).toEqual([
      {
        executable: 'open',
        args: [
          'http://treeport.example.test/projects/project/worktrees/worktree'
        ]
      }
    ])
  })

  it('returns the direct URL when no browser can be opened', async () => {
    const launch: LaunchCommand = async () => ({
      code: null,
      stderr: 'command not found'
    })

    await expect(
      openWorkspace(workspaceUrl, { platform: 'linux', launch })
    ).rejects.toEqual(
      expect.objectContaining({
        message: expect.stringContaining(
          `Open this URL manually: ${workspaceUrl}`
        )
      })
    )
  })
})
