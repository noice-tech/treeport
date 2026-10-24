import fs from 'node:fs/promises'
import path from 'node:path'

// Ordered by preference: high-resolution and vector icons stay crisp in the
// sidebar, while favicon.ico is often a blurry 16px bitmap.
const ICON_NAMES = [
  'apple-touch-icon.png',
  'apple-touch-icon-precomposed.png',
  'apple-icon.png',
  'favicon.svg',
  'icon.svg',
  'icon.png',
  'favicon.png',
  'favicon.ico'
]
const ICON_DIRECTORIES = [
  '',
  'public',
  'static',
  'app',
  'src/app',
  'web/public'
]
const MAX_MONOREPO_APPS = 16
const MAX_ICON_BYTES = 1024 * 1024

// Only probe conventional locations; never walk the tree, so the cost stays a
// few dozen readdir calls regardless of repository size.
export async function findProjectIcon(
  rootPath: string
): Promise<string | null> {
  const apps = await fs
    .readdir(path.join(rootPath, 'apps'), { withFileTypes: true })
    .catch(() => [])
  const roots = [
    rootPath,
    ...apps
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(rootPath, 'apps', entry.name))
      .sort()
      .slice(0, MAX_MONOREPO_APPS)
  ]
  const directories = roots.flatMap((root) =>
    ICON_DIRECTORIES.map((directory) => path.join(root, directory))
  )
  const listings = await Promise.all(
    directories.map((directory) =>
      fs.readdir(directory).catch((): string[] => [])
    )
  )

  for (const name of ICON_NAMES) {
    for (const [index, listing] of listings.entries()) {
      if (!listing.includes(name)) {
        continue
      }

      const iconPath = path.join(directories[index]!, name)
      const stats = await fs.stat(iconPath).catch(() => null)
      if (stats?.isFile() && stats.size <= MAX_ICON_BYTES) {
        return iconPath
      }
    }
  }
  return null
}
