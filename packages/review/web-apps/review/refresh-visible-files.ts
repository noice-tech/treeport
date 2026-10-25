interface RefreshableFile {
  readonly id: string
  readonly scope: 'committed' | 'uncommitted'
  readonly loadState: string
}

/** Poll mutable viewport patches, not every patch previously visited. */
export async function refreshVisibleFiles(
  files: readonly RefreshableFile[],
  visible: ReadonlySet<string>,
  collapsed: ReadonlySet<string>,
  load: (id: string, reload: boolean) => Promise<void>
): Promise<void> {
  const pending = files.filter(
    (file) =>
      visible.has(file.id) &&
      (file.loadState === 'idle' ||
        (!collapsed.has(file.id) && file.scope === 'uncommitted'))
  )

  let next = 0
  await Promise.all(
    Array.from({ length: Math.min(4, pending.length) }, async () => {
      while (next < pending.length) {
        const file = pending[next++]!
        await load(file.id, file.scope === 'uncommitted')
      }
    })
  )
}
