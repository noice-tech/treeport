#!/usr/bin/env node
import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { execFile, spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { nativeSourceFingerprint } from './native-source.mjs'

const appRoot = fileURLToPath(new URL('..', import.meta.url))
const manifest = path.join(appRoot, 'native/Cargo.toml')

const targets = {
  'darwin-arm64': 'aarch64-apple-darwin',
  'darwin-x64': 'x86_64-apple-darwin',
  'linux-arm64': 'aarch64-unknown-linux-gnu',
  'linux-x64': 'x86_64-unknown-linux-gnu'
}

const platform = process.argv[2] ?? `${process.platform}-${process.arch}`
const target = targets[platform]

if (!target || process.argv.length > 3) {
  throw new Error('Expected one supported platform-architecture target')
}

const sourceFingerprint = await nativeSourceFingerprint()
const cargo = process.env.CARGO ?? 'cargo'

await new Promise((resolve, reject) => {
  const child = spawn(
    cargo,
    [
      'build',
      '--release',
      '--locked',
      '--target',
      target,
      '--manifest-path',
      manifest
    ],
    { stdio: 'inherit' }
  )

  child.once('error', reject)
  child.once('exit', (code, signal) => {
    if (code === 0) {
      resolve()
    } else {
      reject(new Error(`Native keeper build failed (${code ?? signal})`))
    }
  })
})

if ((await nativeSourceFingerprint()) !== sourceFingerprint) {
  throw new Error(
    'Native source changed during the build; refusing artifact publication'
  )
}

// Ship the license/copyright texts for the locked normal + build dependency
// closure and Rust's linked standard runtime, not just Cargo SPDX labels.
const execute = promisify(execFile)

const metadata = JSON.parse(
  (
    await execute(
      cargo,
      [
        'metadata',
        '--locked',
        '--format-version',
        '1',
        '--filter-platform',
        target,
        '--manifest-path',
        manifest
      ],
      { cwd: appRoot, maxBuffer: 16 * 1024 * 1024 }
    )
  ).stdout
)

const nodes = new Map(metadata.resolve.nodes.map((node) => [node.id, node]))
const included = new Set()
const pending = [metadata.resolve.root]

while (pending.length) {
  const id = pending.pop()

  if (included.has(id)) {
    continue
  }

  included.add(id)

  for (const dependency of nodes.get(id).deps) {
    if (dependency.dep_kinds.some((kind) => kind.kind !== 'dev')) {
      pending.push(dependency.pkg)
    }
  }
}

const notices = []

for (const dependency of metadata.packages
  .filter((pkg) => pkg.source !== null && included.has(pkg.id))
  .sort((a, b) =>
    `${a.name}@${a.version}`.localeCompare(`${b.name}@${b.version}`)
  )) {
  const source = path.dirname(dependency.manifest_path)

  const names = (await fs.readdir(source)).filter((name) =>
    /licen[cs]e|copying|copyright|notice/i.test(name)
  )

  if (dependency.license_file && !names.includes(dependency.license_file)) {
    names.push(dependency.license_file)
  }

  const texts = []

  for (const name of names.sort()) {
    const file = path.join(source, name)

    if ((await fs.stat(file)).isFile()) {
      texts.push(`${name}\n${await fs.readFile(file, 'utf8')}`)
    }
  }

  if (!texts.length || !dependency.license) {
    throw new Error(
      `Missing native dependency license texts: ${dependency.name}`
    )
  }

  notices.push(
    `${dependency.name} ${dependency.version}\n${dependency.license}\n${dependency.repository ?? dependency.source}\n\n${texts.join('\n\n')}`
  )
}

const sysroot = (
  await execute(process.env.RUSTC ?? 'rustc', ['--print', 'sysroot'], {
    cwd: appRoot
  })
).stdout.trim()

for (const name of ['LICENSE-APACHE', 'LICENSE-MIT', 'COPYRIGHT']) {
  notices.push(
    `Rust standard runtime: ${name}\n${await fs.readFile(path.join(sysroot, 'share/doc/rust', name), 'utf8')}`
  )
}

const directory = path.join(appRoot, 'dist/native', platform)

await fs.mkdir(directory, { recursive: true })

// Never truncate an executable inode: macOS caches its code signature, and
// an already-running owner must keep its original binary through a rebuild.
const binary = path.join(directory, 'treeport-session-keeper')
const temporary = `${binary}.${crypto.randomUUID()}.tmp`

await fs.copyFile(
  path.join(
    appRoot,
    'native/target',
    target,
    'release/treeport-session-keeper'
  ),
  temporary,
  fs.constants.COPYFILE_EXCL
)

await fs.chmod(temporary, 0o755)

const hash = crypto
  .createHash('sha256')
  .update(await fs.readFile(temporary))
  .digest('hex')

const licenses = path.join(directory, 'THIRD_PARTY_NOTICES')
const licenseTemporary = `${licenses}.${crypto.randomUUID()}.tmp`

await fs.writeFile(
  licenseTemporary,
  `Treeport session keeper: ${platform}\nBinary SHA256: ${hash}\nBuild source SHA256: ${sourceFingerprint}\n\n${notices.join('\n\n========================================\n\n')}\n`,
  { flag: 'wx', mode: 0o644 }
)

if ((await nativeSourceFingerprint()) !== sourceFingerprint) {
  await fs.rm(licenseTemporary, { force: true })
  await fs.rm(temporary, { force: true })
  throw new Error(
    'Native source changed before publication; retaining previous artifacts'
  )
}

await fs.rename(licenseTemporary, licenses)

await fs.rename(temporary, binary)
