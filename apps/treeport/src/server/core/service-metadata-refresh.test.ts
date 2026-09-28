import fs from 'node:fs/promises'
import path from 'node:path'
import * as Effect from 'effect/Effect'
import { expect, it } from 'vitest'
import { ProjectSnapshotOperations } from './services/domain-services'
import { fixture } from './service.integration-fixture'

it('keeps metadata reads Git-free, refreshes dirty state in the background, and discovers external trees', async () => {
  const { main, runner, service } = await fixture()
  const project = await service.registerProject(main)
  const tree = project.worktrees[0]!
  const gitReads = () =>
    runner.calls.filter(
      (call) =>
        call.args[0] === 'status' ||
        (call.args[0] === 'worktree' && call.args[1] === 'list')
    ).length

  const before = gitReads()
  for (let i = 0; i < 4; i++) {
    await service.listProjects()
    await service.getProjectSnapshot(project.id)
    await service.getWorktreeSnapshot(tree.id)
  }
  expect(gitReads()).toBe(before)

  const external = path.join(path.dirname(main), 'external-checkout')
  await fs.mkdir(external)
  runner.worktrees.push({
    path: external,
    gitWorktreeKey: path.join(main, '.git', 'worktrees', 'external-checkout'),
    head: 'external-head',
    branch: 'external'
  })
  expect((await service.getProjectSnapshot(project.id)).worktrees).toHaveLength(
    1
  )
  runner.dirtyPaths.add(tree.path)
  // Explicitly execute the daemon's bounded unit of work instead of waiting
  // for its timer; the first turn reconciles, the next scans a tree.
  const refresh = () =>
    service.runEffect(
      Effect.flatMap(ProjectSnapshotOperations, (snapshots) =>
        snapshots.refreshGitState()
      )
    )
  await refresh()
  expect((await service.getProjectSnapshot(project.id)).worktrees).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ path: await fs.realpath(external) })
    ])
  )
  await refresh()
  expect((await service.getWorktreeSnapshot(tree.id)).dirty).toMatchObject({
    dirty: true,
    untracked: 1
  })
  const afterRefresh = gitReads()
  await service.listProjects()
  expect(gitReads()).toBe(afterRefresh)
})
