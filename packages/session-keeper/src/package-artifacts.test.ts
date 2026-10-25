import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { checkSessionKeeperPackage } from '../scripts/check-package.mjs'
import { SESSION_KEEPER_MAX_PAYLOAD_BYTES } from './index'

const roots: string[] = []
const source = path.resolve(import.meta.dirname, '..')
const host = `${process.platform}-${process.arch}`
const platforms = ['darwin-arm64', 'darwin-x64', 'linux-arm64', 'linux-x64']

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true }))
  )
})

async function linkOrCopy(source: string, target: string) {
  await fs.link(source, target).catch((error) => {
    // Temporary storage may be on another filesystem in CI.
    if (error.code !== 'EXDEV') {
      throw error
    }

    return fs.copyFile(source, target)
  })
}

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tp-native-contract-'))
  roots.push(root)
  await linkOrCopy(
    path.join(source, 'package.json'),
    path.join(root, 'package.json')
  )
  await linkOrCopy(path.join(source, 'LICENSE'), path.join(root, 'LICENSE'))
  await fs.mkdir(path.join(root, 'dist'))
  await fs.symlink(
    path.join(source, 'node_modules'),
    path.join(root, 'node_modules'),
    'dir'
  )

  for (const file of [
    'index.js',
    'index.d.ts',
    'protocol.js',
    'protocol.d.ts'
  ]) {
    await linkOrCopy(
      path.join(source, 'dist', file),
      path.join(root, 'dist', file)
    )
  }

  await fs.mkdir(path.join(root, 'dist/native', host), { recursive: true })

  for (const file of ['treeport-session-keeper', 'THIRD_PARTY_NOTICES']) {
    await linkOrCopy(
      path.join(source, 'dist/native', host, file),
      path.join(root, 'dist/native', host, file)
    )
  }

  return root
}

it('accepts a real host development payload but refuses a host-only release package', async () => {
  const root = await fixture()
  await expect(checkSessionKeeperPackage(root)).resolves.toMatchObject({
    name: '@treeport/session-keeper'
  })
  const missing = platforms.find((platform) => platform !== host)!
  await expect(checkSessionKeeperPackage(root, true)).rejects.toThrow(missing)
})

it('rejects a real host executable relabeled as another target instead of accepting dummy all-target coverage', async () => {
  const root = await fixture()

  for (const platform of platforms.filter((platform) => platform !== host)) {
    await fs.mkdir(path.join(root, 'dist/native', platform), {
      recursive: true
    })

    for (const file of ['treeport-session-keeper', 'THIRD_PARTY_NOTICES']) {
      await linkOrCopy(
        path.join(root, 'dist/native', host, file),
        path.join(root, 'dist/native', platform, file)
      )
    }
  }

  await expect(checkSessionKeeperPackage(root, true)).rejects.toThrow(
    /Target (?:format|architecture) mismatch/
  )
})

it('refuses oversized release payloads before reading their bytes', async () => {
  const root = await fixture()

  const payload = path.join(
    root,
    'dist/native',
    host,
    'treeport-session-keeper'
  )

  // Replace the fixture's link before mutation; never alter build output.
  await fs.unlink(payload)
  const file = await fs.open(payload, 'wx')

  try {
    await file.truncate(SESSION_KEEPER_MAX_PAYLOAD_BYTES + 1)
  } finally {
    await file.close()
  }

  await expect(checkSessionKeeperPackage(root)).rejects.toThrow(
    'package size contract'
  )
})

it('rejects stale source associations and corrupt payload hashes', async () => {
  const root = await fixture()
  const notices = path.join(root, 'dist/native', host, 'THIRD_PARTY_NOTICES')
  const original = await fs.readFile(notices, 'utf8')
  // The immutable fixture shares an inode with build output until replacement.
  await fs.unlink(notices)
  await fs.writeFile(
    notices,
    original.replace(
      /Build source SHA256: [a-f0-9]{64}/,
      `Build source SHA256: ${'0'.repeat(64)}`
    )
  )
  await expect(checkSessionKeeperPackage(root)).rejects.toThrow(
    'Stale native source'
  )
  await fs.writeFile(
    notices,
    original.replace(
      /Binary SHA256: [a-f0-9]{64}/,
      `Binary SHA256: ${'0'.repeat(64)}`
    )
  )
  await expect(checkSessionKeeperPackage(root)).rejects.toThrow(
    'Native payload hash mismatch'
  )
})
