import type { LauncherDefinition } from '#protocol/launcher'
import { formatCommandLine } from './command-line'

export function launcherCommand(launcher: LauncherDefinition): string {
  if (launcher.shellCommand !== null) {
    return launcher.shellCommand
  }

  return launcher.executable
    ? formatCommandLine([launcher.executable, ...launcher.args])
    : ''
}

export function launcherInputLabel(inputName: string): string {
  const words = inputName.replaceAll('_', ' ')

  return words.charAt(0).toUpperCase() + words.slice(1)
}

export function launcherProvenance(launcher: LauncherDefinition): string {
  if (launcher.source.type === 'repository') {
    return launcher.source.format === 'zed' ? 'Repository · Zed' : 'Repository'
  }

  if (launcher.source.type === 'user') {
    return 'Global'
  }

  return `${launcher.source.scope === 'project' ? 'Repository' : 'Global'} · ${launcher.source.packageId}`
}

export function launcherDisambiguator(
  launcher: LauncherDefinition,
  launchers: LauncherDefinition[]
): string | null {
  return launchers.some(
    (candidate) =>
      candidate.id !== launcher.id && candidate.name === launcher.name
  )
    ? launcherProvenance(launcher)
    : null
}
