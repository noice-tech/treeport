#!/usr/bin/env node
import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const packageRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..'
)

const repositoryRoot = path.resolve(packageRoot, '../..')
const native = path.join(packageRoot, 'native')
const output = path.join(native, 'target/release/treeport-session-keeper')
const stamp = `${output}.source`

const sources = [
  path.join(repositoryRoot, 'rust-toolchain.toml'),
  path.join(native, 'Cargo.toml'),
  path.join(native, 'Cargo.lock'),
  ...(
    await fs.readdir(path.join(native, 'src'), {
      recursive: true,
      withFileTypes: true
    })
  )
    .filter((entry) => entry.isFile())
    .map((entry) => path.join(entry.parentPath, entry.name))
]
  .map((file) => ({
    file,
    name: path.relative(repositoryRoot, file).split(path.sep).join('/')
  }))
  .sort((left, right) => (left.name < right.name ? -1 : 1))

const hash = crypto.createHash('sha256')

for (const { file, name } of sources) {
  hash.update(`${name}\0`)
  hash.update(await fs.readFile(file))
  hash.update('\0')
}

const key = hash.digest('hex').slice(0, 16)

if (process.argv[2] === '--print-key') {
  console.log(key)
  process.exit(0)
}

const fromSource = process.env.TREEPORT_BUILD_KEEPER === '1'

const built =
  !fromSource &&
  (await fs.readFile(stamp, 'utf8').catch(() => null)) === key &&
  (await fs.access(output).then(
    () => true,
    () => false
  ))

if (built) {
  process.exit(0)
}

const release = `session-keeper-${key}`
const asset = `treeport-session-keeper-${process.platform}-${process.arch}`
let unavailable = 'TREEPORT_BUILD_KEEPER=1 requested a source build'

if (!fromSource) {
  const base = `https://github.com/noice-tech/treeport/releases/download/${release}`

  const [binary, checksums] = await Promise.all(
    [asset, 'SHA256SUMS'].map((name) =>
      fetch(`${base}/${name}`, { signal: AbortSignal.timeout(60_000) }).then(
        async (response) =>
          response.ok
            ? { bytes: Buffer.from(await response.arrayBuffer()), error: null }
            : {
                bytes: null,
                error:
                  response.status === 404
                    ? `no prebuilt binary is published for ${release} (${asset})`
                    : `downloading ${name} failed with HTTP ${response.status}`
              },
        (error) => ({
          bytes: null,
          error: `downloading ${name} failed: ${error.cause?.message ?? error.message}`
        })
      )
    )
  )

  if (binary.bytes && checksums.bytes) {
    const expected = checksums.bytes
      .toString('utf8')
      .split('\n')
      .map((line) => line.trim().split(/\s+\*?/))
      .find(([, name]) => name === asset)?.[0]

    const actual = crypto
      .createHash('sha256')
      .update(binary.bytes)
      .digest('hex')

    if (actual !== expected) {
      console.error(
        `Prebuilt session keeper ${release} (${asset}) does not match its published SHA256SUMS. Refusing to install it.`
      )
      process.exit(1)
    }

    const temporary = `${output}.download-${process.pid}`
    await fs.mkdir(path.dirname(output), { recursive: true })
    await fs.writeFile(temporary, binary.bytes, { mode: 0o755 })

    if (spawnSync(temporary, ['--version'], { stdio: 'ignore' }).status === 0) {
      await fs.rename(temporary, output)
      await fs.writeFile(stamp, key)
      console.log(`Installed prebuilt session keeper ${release} (${asset}).`)
      process.exit(0)
    }

    await fs.rm(temporary, { force: true })
  }

  unavailable =
    binary.error ??
    checksums.error ??
    `the prebuilt binary for ${release} (${asset}) does not run on this system`
}

if (spawnSync('cargo', ['--version'], { stdio: 'ignore' }).error) {
  console.error(
    [
      'Treeport could not prepare its session keeper:',
      `  - ${unavailable}`,
      '  - Rust is not installed, so it cannot be built locally.',
      '',
      'If you changed packages/session-keeper/native, install Rust from https://rustup.rs and retry.',
      'Otherwise, check your network connection and retry. Binaries for newly merged keeper changes are published a few minutes after the merge.'
    ].join('\n')
  )
  process.exit(1)
}

if (!fromSource) {
  console.log(`Building session keeper with cargo: ${unavailable}.`)
}

const cargo = spawnSync(
  'cargo',
  [
    'build',
    '--release',
    '--locked',
    '--manifest-path',
    path.join(native, 'Cargo.toml'),
    '--target-dir',
    path.join(native, 'target')
  ],
  { cwd: packageRoot, stdio: 'inherit' }
)

if (cargo.status !== 0) {
  process.exit(cargo.status ?? 1)
}

await fs.writeFile(stamp, key)
