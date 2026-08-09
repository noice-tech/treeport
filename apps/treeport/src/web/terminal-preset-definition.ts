import type { TerminalPresetDefinition } from '@treeport/shared'

export function terminalPresetProvenance(
  preset: TerminalPresetDefinition
): string {
  if (preset.source.type === 'repository') {
    return 'Repository'
  }

  if (preset.source.type === 'user') {
    return 'Global'
  }

  return `${preset.source.scope === 'project' ? 'Repository' : 'Global'} · ${preset.source.packageId}`
}
