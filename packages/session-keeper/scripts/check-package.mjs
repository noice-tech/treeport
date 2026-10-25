#!/usr/bin/env node
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { execFile } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { nativeSourceFingerprint } from './native-source.mjs'

const execute = promisify(execFile)
const directory = fileURLToPath(new URL('..', import.meta.url))

export async function checkSessionKeeperPackage(
  packageDirectory,
  allTargets = false
) {
  const manifest = JSON.parse(
    await fs.readFile(path.join(packageDirectory, 'package.json'), 'utf8')
  )

  assert.equal(manifest.name, '@treeport/session-keeper')
  assert.equal(manifest.main, 'dist/index.js')
  assert.equal(manifest.types, 'dist/index.d.ts')
  assert.deepEqual(manifest.exports, {
    '.': { types: './dist/index.d.ts', default: './dist/index.js' }
  })
  assert.deepEqual(Object.keys(manifest.dependencies ?? {}), ['zod'])
  assert.equal(manifest.scripts.install, undefined)
  assert.equal(manifest.scripts.postinstall, undefined)

  const keeper = path.join(
    packageDirectory,
    `dist/native/${process.platform}-${process.arch}/treeport-session-keeper`
  )

  for (const file of [
    'dist/index.js',
    'dist/index.d.ts',
    'dist/protocol.js',
    'dist/protocol.d.ts',
    'LICENSE',
    path.relative(packageDirectory, keeper)
  ]) {
    assert(
      (await fs.stat(path.join(packageDirectory, file))).size > 0,
      `Empty required file: ${file}`
    )
  }

  const {
    getSessionKeeperPayload,
    prepareSessionKeeper,
    SESSION_KEEPER_MAX_PAYLOAD_BYTES
  } = await import(
    pathToFileURL(path.join(packageDirectory, 'dist/index.js')).href
  )

  assert.equal(SESSION_KEEPER_MAX_PAYLOAD_BYTES, 64 * 1024 * 1024)

  const platforms = allTargets
    ? ['darwin-arm64', 'darwin-x64', 'linux-arm64', 'linux-x64']
    : [`${process.platform}-${process.arch}`]

  const expectedSource = await nativeSourceFingerprint()

  for (const platform of platforms) {
    const payload = path.join(
      packageDirectory,
      'dist/native',
      platform,
      'treeport-session-keeper'
    )

    const metadata = await fs.lstat(payload)
    assert(
      metadata.isFile(),
      `Native payload is not a regular file: ${platform}`
    )
    assert(
      metadata.size >= 64 && metadata.size <= SESSION_KEEPER_MAX_PAYLOAD_BYTES,
      `Native payload exceeds the package size contract or is truncated: ${platform}`
    )
    const bytes = await fs.readFile(payload)
    assert.equal(
      bytes.length,
      metadata.size,
      `Native payload changed: ${platform}`
    )

    if (platform.startsWith('darwin-')) {
      assert(
        bytes.readUInt32LE(0) === 0xfeedfacf && bytes.readUInt32LE(12) === 2,
        `Target format mismatch: ${platform}`
      )
      assert.equal(
        bytes.readUInt32LE(4),
        platform.endsWith('arm64') ? 0x0100000c : 0x01000007,
        `Target architecture mismatch: ${platform}`
      )
    } else {
      assert(
        bytes.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46])) &&
          bytes[4] === 2 &&
          bytes[5] === 1 &&
          bytes[6] === 1 &&
          bytes.readUInt32LE(20) === 1 &&
          [2, 3].includes(bytes.readUInt16LE(16)) &&
          bytes.readBigUInt64LE(24) !== 0n,
        `Target format mismatch: ${platform}`
      )
      assert.equal(
        bytes.readUInt16LE(18),
        platform.endsWith('arm64') ? 183 : 62,
        `Target architecture mismatch: ${platform}`
      )
    }

    const notices = await fs.readFile(
      path.join(path.dirname(payload), 'THIRD_PARTY_NOTICES'),
      'utf8'
    )

    assert(
      notices.startsWith(`Treeport session keeper: ${platform}\n`),
      `Target notices mismatch: ${platform}`
    )
    const hash = crypto.createHash('sha256').update(bytes).digest('hex')
    assert(
      notices.includes(`Binary SHA256: ${hash}\n`),
      `Native payload hash mismatch: ${platform}`
    )
    assert(
      notices.includes(`Build source SHA256: ${expectedSource}\n`),
      `Stale native source: ${platform}`
    )

    for (const name of ['portable-pty', 'tokio', 'Rust standard runtime']) {
      assert(
        notices.includes(name),
        `Missing native notices: ${platform}: ${name}`
      )
    }
  }

  assert.equal(
    await fs.realpath(getSessionKeeperPayload()),
    await fs.realpath(keeper)
  )
  const fixture = await fs.mkdtemp(path.join(os.tmpdir(), 'tp-native-package-'))

  try {
    const executable = await prepareSessionKeeper(
      keeper,
      path.join(fixture, 'cache')
    )

    const inode = (await fs.stat(executable)).ino
    assert.equal(
      await prepareSessionKeeper(keeper, path.join(fixture, 'cache')),
      executable
    )
    assert.equal((await fs.stat(executable)).ino, inode)
    assert.match(
      (await execute(executable, ['--version'], { maxBuffer: 1024 })).stdout,
      /^treeport-session-keeper \d+\.\d+\.\d+ protocol=1\n$/
    )
  } finally {
    await fs.rm(fixture, { recursive: true, force: true })
  }

  const files = await fs.readdir(path.join(packageDirectory, 'dist'), {
    recursive: true
  })

  assert.deepEqual(
    files.filter((file) =>
      /(?:^|\/)(?:target|src|scripts|tests?|fixtures)(?:\/|$)|\.(?:rs|map|tsbuildinfo)$|\.test\./.test(
        file
      )
    ),
    [],
    'Native publish output contains sources, tests or build metadata'
  )

  return manifest
}

if (path.resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
  if (!process.argv.includes('--packed')) {
    const manifest = await checkSessionKeeperPackage(
      directory,
      process.argv.includes('--all-targets')
    )

    console.log(
      `Native build output checks passed for ${manifest.name}@${manifest.version}`
    )
  } else {
    const temporary = await fs.mkdtemp(
      path.join(os.tmpdir(), 'tp-native-pack-')
    )

    try {
      const manifest = JSON.parse(
        await fs.readFile(path.join(directory, 'package.json'), 'utf8')
      )

      await execute(
        'pnpm',
        [
          '--config.ignore-scripts=true',
          'pack',
          '--pack-destination',
          temporary
        ],
        { cwd: directory }
      )

      const tarball = path.join(
        temporary,
        `treeport-session-keeper-${manifest.version}.tgz`
      )

      await execute('tar', ['-xzf', tarball, '-C', temporary])

      const packedManifest = JSON.parse(
        await fs.readFile(path.join(temporary, 'package/package.json'), 'utf8')
      )

      await fs.writeFile(
        path.join(temporary, 'package.json'),
        JSON.stringify({
          private: true,
          dependencies: packedManifest.dependencies
        })
      )
      await execute(
        'pnpm',
        ['install', '--offline', '--ignore-scripts', '--prod'],
        { cwd: temporary }
      )

      const packaged = await checkSessionKeeperPackage(
        path.join(temporary, 'package'),
        process.argv.includes('--all-targets')
      )

      const allFiles = await fs.readdir(path.join(temporary, 'package'), {
        recursive: true
      })

      assert.deepEqual(
        allFiles.filter(
          (file) =>
            /(?:^|\/)(?:native|src|scripts|target)(?:\/|$)/.test(file) &&
            !file.startsWith('dist/')
        ),
        []
      )
      assert.equal(packaged.version, manifest.version)
      console.log(
        `Packed native artifact checks passed for ${packaged.name}@${packaged.version}`
      )
    } finally {
      await fs.rm(temporary, { recursive: true, force: true })
    }
  }
}
