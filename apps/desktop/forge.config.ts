import { execFile } from 'node:child_process'
import { cp } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { FusesPlugin } from '@electron-forge/plugin-fuses'
import { VitePlugin } from '@electron-forge/plugin-vite'
import type { ForgeConfig } from '@electron-forge/shared-types'
import { FuseV1Options, FuseVersion } from '@electron/fuses'

const execute = promisify(execFile)

const packagerConfig: NonNullable<ForgeConfig['packagerConfig']> = {
  name: 'Treeport',
  appBundleId: 'tech.noice.treeport',
  appCategoryType: 'public.app-category.developer-tools',
  asar: true,
  extendInfo: {
    NSCameraUsageDescription:
      'Allow websites in Treeport Browser to use the camera when you approve.',
    NSLocationWhenInUseUsageDescription:
      'Allow websites in Treeport Browser to access your location when you approve.',
    NSMicrophoneUsageDescription:
      'Allow websites in Treeport Browser to use the microphone when you approve.'
  },
  icon: path.resolve('assets/Treeport.icns'),
  protocols: [
    {
      name: 'Treeport workspace',
      schemes: ['treeport']
    }
  ],
  osxSign: {
    identity: '-',
    identityValidation: false
  }
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
  hooks: {
    packageAfterCopy: async (_config, buildPath) => {
      await cp(
        path.dirname(fileURLToPath(import.meta.resolve('ws/package.json'))),
        path.join(buildPath, 'node_modules/ws'),
        { recursive: true }
      )
    },
    postPackage: async (_config, packageResult) => {
      if (packageResult.platform === 'darwin') {
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
