import type { TerminalPresetDefinition } from '@treeport/shared'
import { formatCommandLine } from './command-line'

export function terminalPresetCommand(
  preset: TerminalPresetDefinition
): string {
  if (preset.shellCommand !== null) {
    return preset.shellCommand
  }

  return preset.executable
    ? formatCommandLine([preset.executable, ...preset.args])
    : ''
}

export function terminalPresetProvenance(
  preset: TerminalPresetDefinition
): string {
  if (preset.source.type === 'repository') {
    return preset.source.format === 'zed' ? 'Repository · Zed' : 'Repository'
  }

  if (preset.source.type === 'user') {
    return 'Global'
  }

  return `${preset.source.scope === 'project' ? 'Repository' : 'Global'} · ${preset.source.packageId}`
}
