import { execFile } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { pathToFileURL } from 'node:url'
import { afterEach, expect, it } from 'vitest'
import { prepareSessionKeeper, SESSION_KEEPER_MAX_PAYLOAD_BYTES } from './index'

const execute = promisify(execFile)

const roots: string[] = []

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true }))
  )
})

it('materializes read-only packed payloads without replacing old executable inodes', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tp-native-cache-'))
  roots.push(root)
  const payload = path.join(root, 'payload')
  const cache = path.join(root, 'cache')
  await fs.writeFile(payload, 'first-build', { mode: 0o400 })
  const first = await prepareSessionKeeper(payload, cache)
  const inode = (await fs.stat(first)).ino
  expect((await fs.stat(first)).mode & 0o777).toBe(0o700)
  expect((await fs.stat(payload)).mode & 0o777).toBe(0o400)
  expect(await prepareSessionKeeper(payload, cache)).toBe(first)
  expect((await fs.stat(first)).ino).toBe(inode)
  await fs.chmod(payload, 0o600)
  await fs.writeFile(payload, 'second-build')
  const second = await prepareSessionKeeper(payload, cache)
  expect(second).not.toBe(first)
  expect(await fs.readFile(first, 'utf8')).toBe('first-build')
  expect((await fs.stat(first)).ino).toBe(inode)
  expect(await fs.readFile(second, 'utf8')).toBe('second-build')
})

it('refuses insecure directories, symlinks, and corrupted cached binaries', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tp-native-cache-'))
  roots.push(root)
  const payload = path.join(root, 'payload')
  const cache = path.join(root, 'cache')
  await fs.writeFile(payload, 'trusted-build')
  await fs.mkdir(cache, { mode: 0o755 })
  await expect(prepareSessionKeeper(payload, cache)).rejects.toThrow('private')
  await fs.chmod(cache, 0o700)
  const hash = crypto.createHash('sha256').update('trusted-build').digest('hex')
  const binary = path.join(cache, `keeper-${hash}`)
  await fs.symlink(payload, binary)
  await expect(prepareSessionKeeper(payload, cache)).rejects.toMatchObject({
    code: 'ELOOP'
  })
  await fs.unlink(binary)
  await fs.writeFile(binary, 'corrupted', { mode: 0o700 })
  await expect(prepareSessionKeeper(payload, cache)).rejects.toThrow(
    'does not identify'
  )
  expect(await fs.readFile(binary, 'utf8')).toBe('corrupted')
})

it('refuses a FIFO cache entry promptly without removing or replacing it', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tp-native-cache-'))
  roots.push(root)
  const payload = path.join(root, 'payload')
  const cache = path.join(root, 'cache')
  await fs.writeFile(payload, 'trusted-build')
  await fs.mkdir(cache, { mode: 0o700 })
  const hash = crypto.createHash('sha256').update('trusted-build').digest('hex')
  const binary = path.join(cache, `keeper-${hash}`)
  await execute('mkfifo', [binary])
  await expect(prepareSessionKeeper(payload, cache)).rejects.toThrow(
    'does not identify'
  )
  expect((await fs.lstat(binary)).isFIFO()).toBe(true)
  expect(await fs.readdir(cache)).toEqual([path.basename(binary)])
})

it.each(['empty', 'directory', 'symlink', 'oversized'] as const)(
  'refuses a %s source payload before allocating cache artifacts',
  async (kind) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tp-native-cache-'))
    roots.push(root)
    const payload = path.join(root, 'payload')
    const cache = path.join(root, 'cache')

    if (kind === 'directory') {
      await fs.mkdir(payload)
    } else if (kind === 'symlink') {
      const outside = path.join(root, 'outside')
      await fs.writeFile(outside, 'untouched')
      await fs.symlink(outside, payload)
    } else {
      const file = await fs.open(payload, 'wx', 0o600)

      try {
        if (kind === 'oversized') {
          // Sparse, owned fixture: no large allocation needed to exercise the
          // metadata refusal before any payload bytes can be read.
          await file.truncate(SESSION_KEEPER_MAX_PAYLOAD_BYTES + 1)
        }
      } finally {
        await file.close()
      }
    }

    await expect(prepareSessionKeeper(payload, cache)).rejects.toThrow(
      'bounded'
    )

    if (kind === 'symlink') {
      expect(await fs.readFile(path.join(root, 'outside'), 'utf8')).toBe(
        'untouched'
      )
    }

    await expect(fs.lstat(cache)).rejects.toMatchObject({ code: 'ENOENT' })

    if (kind === 'oversized') {
      expect((await fs.stat(payload)).size).toBe(
        SESSION_KEEPER_MAX_PAYLOAD_BYTES + 1
      )
    }
  }
)

it('refuses a FIFO source payload in an isolated, deadline-bounded launcher', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tp-native-cache-'))
  roots.push(root)
  const payload = path.join(root, 'payload')
  const cache = path.join(root, 'cache')
  await execute('mkfifo', [payload])

  const module = pathToFileURL(
    path.resolve(import.meta.dirname, '../dist/index.js')
  ).href

  // A regression may block the filesystem worker in open/read. Confine that
  // probe to our own child launcher, rather than hanging the test runner's pool.
  const result = await execute(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `import { prepareSessionKeeper } from ${JSON.stringify(module)};
     await prepareSessionKeeper(process.argv[1], process.argv[2]).then(
       () => { throw new Error('FIFO source was accepted') },
       error => { if (!/bounded/.test(error.message)) throw error; console.log('refused') }
     );`,
      payload,
      cache
    ],
    { timeout: 2000, maxBuffer: 1024 }
  )

  expect(result.stdout.trim()).toBe('refused')
  expect((await fs.lstat(payload)).isFIFO()).toBe(true)
  await expect(fs.lstat(cache)).rejects.toMatchObject({ code: 'ENOENT' })
})

it('refuses an oversized cached inode without truncating or replacing it', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tp-native-cache-'))
  roots.push(root)
  const payload = path.join(root, 'payload')
  const cache = path.join(root, 'cache')
  await fs.writeFile(payload, 'trusted-build')
  await fs.mkdir(cache, { mode: 0o700 })
  const hash = crypto.createHash('sha256').update('trusted-build').digest('hex')
  const binary = path.join(cache, `keeper-${hash}`)
  const file = await fs.open(binary, 'wx', 0o700)

  try {
    await file.truncate(SESSION_KEEPER_MAX_PAYLOAD_BYTES + 1)
  } finally {
    await file.close()
  }

  const before = await fs.stat(binary)
  await expect(prepareSessionKeeper(payload, cache)).rejects.toThrow(
    'does not identify'
  )
  const after = await fs.stat(binary)
  expect(after.ino).toBe(before.ino)
  expect(after.size).toBe(before.size)
  expect(await fs.readdir(cache)).toEqual([path.basename(binary)])
})

it('publishes one immutable cache inode for concurrent launchers and leaves no temporary files', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tp-native-cache-'))
  roots.push(root)
  const payload = path.join(root, 'payload')
  const cache = path.join(root, 'cache')
  const bytes = Buffer.alloc(1024 * 1024, 7)
  await fs.writeFile(payload, bytes, { mode: 0o400 })

  const winners = await Promise.all(
    Array.from({ length: 16 }, async () => {
      const binary = await prepareSessionKeeper(payload, cache)

      return { binary, inode: (await fs.stat(binary)).ino }
    })
  )

  expect(new Set(winners.map((value) => value.binary)).size).toBe(1)
  expect(new Set(winners.map((value) => value.inode)).size).toBe(1)
  const winner = winners[0]!
  expect((await fs.stat(winner.binary)).mode & 0o777).toBe(0o700)
  expect(await fs.readFile(winner.binary)).toEqual(bytes)
  expect(await fs.readdir(cache)).toEqual([path.basename(winner.binary)])
})
