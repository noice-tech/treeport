import { execFile } from 'node:child_process'
import { cp, rename, rm } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { FusesPlugin } from '@electron-forge/plugin-fuses'
import { VitePlugin } from '@electron-forge/plugin-vite'
import type { ForgeConfig, ForgeMakeResult } from '@electron-forge/shared-types'
import { FuseV1Options, FuseVersion } from '@electron/fuses'
import { notarize } from '@electron/notarize'

const execute = promisify(execFile)
const releaseBuild = process.env.TREEPORT_DESKTOP_RELEASE === '1'
const releaseEnvironment = {
  signingIdentity: process.env.TREEPORT_MAC_SIGNING_IDENTITY?.trim(),
  appleApiKey: process.env.APPLE_API_KEY_PATH?.trim(),
  appleApiKeyId: process.env.APPLE_API_KEY_ID?.trim(),
  appleApiIssuer: process.env.APPLE_API_ISSUER?.trim()
}

if (releaseBuild) {
  const missing = Object.entries(releaseEnvironment)
    .filter(([, value]) => !value)
    .map(([name]) => name)
  if (missing.length > 0) {
    throw new Error(
      `A desktop release build requires signing and notarization credentials. Missing: ${missing.join(', ')}`
    )
  }
}

const notarizationCredentials = {
  appleApiKey: releaseEnvironment.appleApiKey ?? '',
  appleApiKeyId: releaseEnvironment.appleApiKeyId ?? '',
  appleApiIssuer: releaseEnvironment.appleApiIssuer ?? ''
}

const packagerConfig: NonNullable<ForgeConfig['packagerConfig']> = {
  name: 'Treeport',
  appBundleId: 'tech.noice.treeport',
  appCategoryType: 'public.app-category.developer-tools',
  asar: true,
  icon: path.resolve('assets/Treeport.icns'),
  protocols: [
    {
      name: 'Treeport workspace',
      schemes: ['treeport']
    }
  ],
  osxSign: releaseBuild
    ? {
        identity: releaseEnvironment.signingIdentity!
      }
    : {
        identity: '-',
        identityValidation: false
      }
}
if (releaseBuild) {
  packagerConfig.osxNotarize = notarizationCredentials
}

const config: ForgeConfig = {
  rebuildConfig: {
    onlyModules: []
  },
  packagerConfig,
  makers: [
    {
      name: '@electron-forge/maker-dmg',
      config: {
        icon: path.resolve('assets/Treeport.icns'),
        format: 'ULFO'
      },
      platforms: ['darwin']
    },
    {
      name: '@electron-forge/maker-zip',
      config: {},
      platforms: ['darwin']
    }
  ],
  publishers: releaseBuild
    ? [
        {
          name: '@electron-forge/publisher-github',
          config: {
            repository: {
              owner: 'noice-tech',
              name: 'treeport'
            },
            tagPrefix: 'v',
            draft: true,
            prerelease: false,
            generateReleaseNotes: true,
            force: true
          }
        }
      ]
    : [],
  hooks: {
    packageAfterCopy: async (_config, buildPath) => {
      await cp(
        path.dirname(fileURLToPath(import.meta.resolve('ws/package.json'))),
        path.join(buildPath, 'node_modules/ws'),
        { recursive: true }
      )
    },
    postPackage: async (_config, packageResult) => {
      if (!releaseBuild && packageResult.platform === 'darwin') {
        for (const outputPath of packageResult.outputPaths) {
          await execute('codesign', [
            '--force',
            '--deep',
            '--sign',
            '-',
            path.join(outputPath, 'Treeport.app')
          ])
        }
      }
    },
    postMake: async (_config, makeResults: ForgeMakeResult[]) => {
      for (const result of makeResults) {
        if (releaseBuild && result.arch !== 'universal') {
          throw new Error(
            `Desktop releases must be universal; Forge produced ${result.arch}`
          )
        }

        const normalizedArtifacts: string[] = []
        for (const artifact of result.artifacts) {
          const extension = path.extname(artifact)
          if (extension !== '.dmg' && extension !== '.zip') {
            normalizedArtifacts.push(artifact)
            continue
          }

          if (releaseBuild && extension === '.dmg') {
            await execute('codesign', [
              '--force',
              '--timestamp',
              '--sign',
              releaseEnvironment.signingIdentity!,
              artifact
            ])
            await notarize({
              appPath: artifact,
              ...notarizationCredentials
            })
          }

          const normalizedPath = path.join(
            path.dirname(artifact),
            `Treeport-${result.packageJSON.version}-${result.platform}-${result.arch}${extension}`
          )
          if (normalizedPath !== artifact) {
            await rm(normalizedPath, { force: true })
            await rename(artifact, normalizedPath)
          }

          normalizedArtifacts.push(normalizedPath)
        }
        result.artifacts = normalizedArtifacts
      }

      return makeResults
    }
  },
  plugins: [
    new VitePlugin({
      build: [
        {
          entry: 'src/main.ts',
          config: 'vite.main.config.ts',
          target: 'main'
        },
        {
          entry: 'src/preload.ts',
          config: 'vite.preload.config.ts',
          target: 'preload'
        }
      ],
      renderer: [
        {
          name: 'main_window',
          config: 'vite.renderer.config.ts'
        }
      ]
    }),
    new FusesPlugin({
      version: FuseVersion.V1,
      [FuseV1Options.RunAsNode]: false,
      [FuseV1Options.EnableCookieEncryption]: true,
      [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
      [FuseV1Options.EnableNodeCliInspectArguments]: false,
      [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
      [FuseV1Options.OnlyLoadAppFromAsar]: true
    })
  ]
}

export default config
