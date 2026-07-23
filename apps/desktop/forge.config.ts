import type { ForgeConfig } from '@electron-forge/shared-types'

const config: ForgeConfig = {
  rebuildConfig: {
    onlyModules: []
  },
  packagerConfig: {
    name: 'TaskTTY'
  },
  makers: []
}

export default config
