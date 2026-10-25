import fs from 'node:fs/promises'
import path from 'node:path'
import * as Either from 'effect/Either'
import * as ParseResult from 'effect/ParseResult'
import * as Schema from 'effect/Schema'
import type {
  LauncherDefinition,
  LauncherDefinitionDiagnostic
} from '@treeport/shared'
import {
  repositoryLauncherSchema,
  repositoryLaunchersSettingsSchema
} from '@treeport/shared'

const CONFIG_PATH = path.join('.treeport', 'settings.json')

export async function loadRepositoryLaunchers(
  projectId: string,
  worktreePath: string
): Promise<{
  definitions: LauncherDefinition[]
  diagnostics: LauncherDefinitionDiagnostic[]
}> {
  const configPath = path.join(worktreePath, CONFIG_PATH)

  const content = await fs.readFile(configPath, 'utf8').catch((error) => {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return null
    }

    return error instanceof Error ? error : new Error(String(error))
  })

  if (content === null) {
    return { definitions: [], diagnostics: [] }
  }

  if (content instanceof Error) {
    return {
      definitions: [],
      diagnostics: [
        {
          path: CONFIG_PATH,
          itemId: null,
          message: `Could not read repository launchers: ${content.message}`
        }
      ]
    }
  }

  let value: unknown

  try {
    value = JSON.parse(content)
  } catch (error) {
    return {
      definitions: [],
      diagnostics: [
        {
          path: CONFIG_PATH,
          itemId: null,
          message: `Could not parse repository launchers: ${error instanceof Error ? error.message : String(error)}`
        }
      ]
    }
  }

  const file = Schema.decodeUnknownEither(repositoryLaunchersSettingsSchema)(
    value
  )

  if (Either.isLeft(file)) {
    return {
      definitions: [],
      diagnostics: [
        {
          path: CONFIG_PATH,
          itemId: null,
          message: `Invalid repository launchers: ${ParseResult.TreeFormatter.formatErrorSync(file.left)}`
        }
      ]
    }
  }

  const definitions: LauncherDefinition[] = []
  const diagnostics: LauncherDefinitionDiagnostic[] = []

  for (const launcherId of Object.keys(file.right.launchers).sort()) {
    const launcher = Schema.decodeUnknownEither(repositoryLauncherSchema)(
      file.right.launchers[launcherId]
    )

    if (Either.isLeft(launcher)) {
      diagnostics.push({
        path: CONFIG_PATH,
        itemId: launcherId,
        message: `Invalid repository launcher ${launcherId}: ${ParseResult.TreeFormatter.formatErrorSync(launcher.left)}`
      })
      continue
    }

    definitions.push({
      id: `repository:${projectId}:launcher:${launcherId}`,
      name: launcher.right.name,
      executable: launcher.right.executable,
      args: [...launcher.right.args],
      shellCommand: null,
      cwd: null,
      env: {},
      closeOnSuccess: launcher.right.closeOnSuccess,
      treeTitle: launcher.right.treeTitle,
      source: { type: 'repository', format: 'treeport' }
    })
  }

  return { definitions, diagnostics }
}
