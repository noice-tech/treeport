import { execFileSync } from 'node:child_process'
import { mkdtemp, mkdir, rename, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import sharp from 'sharp'

// Run on macOS with `pnpm --filter @treeport/desktop generate:icon`.
// Commit the SVG and ICNS together. Packaging uses the ICNS without rebuilding it.
if (process.platform !== 'darwin') {
  throw new Error('Icon export requires macOS and its iconutil command.')
}

const assets = fileURLToPath(new URL('../assets/', import.meta.url))
const temporary = await mkdtemp(path.join(tmpdir(), 'treeport-icon-'))

try {
  const iconset = path.join(temporary, 'Treeport.iconset')
  await mkdir(iconset)

  // Supersample the vector, including its shadow, before downsampling each slot.
  // Keep the transparent canvas: trimming it makes the Dock icon too large.
  const master = await sharp(path.join(assets, 'treeport-icon.svg'), {
    density: 288
  })
    .png()
    .toBuffer()

  for (const size of [16, 32, 128, 256, 512]) {
    for (const scale of [1, 2]) {
      const filename = `icon_${size}x${size}${scale === 2 ? '@2x' : ''}.png`
      await sharp(master)
        .resize(size * scale, size * scale)
        .png()
        .toFile(path.join(iconset, filename))
    }
  }

  const output = path.join(temporary, 'Treeport.icns')
  execFileSync('iconutil', ['--convert', 'icns', iconset, '--output', output], {
    stdio: 'inherit'
  })
  await rename(output, path.join(assets, 'Treeport.icns'))
  console.log('Generated apps/desktop/assets/Treeport.icns (16–1024 px).')
} finally {
  await rm(temporary, { recursive: true, force: true })
}
