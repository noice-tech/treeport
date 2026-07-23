import { api } from '@electron-forge/core'

await api.start({ dir: process.cwd(), interactive: process.stdout.isTTY })
