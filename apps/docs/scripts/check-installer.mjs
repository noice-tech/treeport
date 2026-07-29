#!/usr/bin/env node
import { execFile } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'

const execute = promisify(execFile)

const docsDirectory = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..'
)
const repositoryRoot = path.resolve(docsDirectory, '../..')
const [manifest, packageManifest, installer] = await Promise.all([
  fs
    .readFile(path.join(docsDirectory, 'public/install-manifest.json'), 'utf8')
    .then(JSON.parse),
  fs
    .readFile(path.join(repositoryRoot, 'apps/treeport/package.json'), 'utf8')
    .then(JSON.parse),
  fs.readFile(path.join(docsDirectory, 'public/install.sh'), 'utf8')
])

if (
  manifest.package !== packageManifest.name ||
  manifest.treeportVersion !== packageManifest.version
) {
  throw new Error('Installer manifest and npm package identity/version differ')
}

if (!installer.includes(`TREEPORT_VERSION:-${manifest.treeportVersion}`)) {
  throw new Error('Installer and manifest Treeport versions differ')
}

if (packageManifest.engines?.node !== '>=24') {
  throw new Error('The published package must require Node.js 24 or newer')
}

if (
  !packageManifest.os?.includes('darwin') ||
  !packageManifest.os?.includes('linux')
) {
  throw new Error('The published package must support macOS and Linux')
}

const temporaryDirectory = await fs.mkdtemp(
  path.join(os.tmpdir(), 'treeport-installer-check-')
)
try {
  await Promise.all([
    fs.writeFile(
      path.join(temporaryDirectory, 'uname'),
      '#!/bin/sh\ncase "$1" in\n  -s) echo "${TREEPORT_TEST_OS:-Linux}" ;;\n  -m) echo x86_64 ;;\nesac\n',
      { mode: 0o755 }
    ),
    fs.writeFile(path.join(temporaryDirectory, 'git'), '#!/bin/sh\nexit 0\n', {
      mode: 0o755
    })
  ])

  async function runInstaller(operatingSystem = 'Linux') {
    return execute('/bin/sh', [path.join(docsDirectory, 'public/install.sh')], {
      env: {
        HOME: temporaryDirectory,
        PATH: temporaryDirectory,
        TREEPORT_TEST_OS: operatingSystem
      }
    }).then(
      () => ({ succeeded: true, stderr: '' }),
      (error) => ({ succeeded: false, stderr: String(error.stderr) })
    )
  }

  let result = await runInstaller('FreeBSD')
  if (
    result.succeeded ||
    !result.stderr.includes('installer supports macOS and Linux')
  ) {
    throw new Error('Installer must reject unsupported operating systems')
  }

  result = await runInstaller()
  if (
    result.succeeded ||
    !result.stderr.includes('Node.js 24 or newer is required')
  ) {
    throw new Error('Installer must accept Linux and check its Node.js version')
  }

  await fs.writeFile(
    path.join(temporaryDirectory, 'node'),
    '#!/bin/sh\necho v23.11.0\n',
    { mode: 0o755 }
  )
  result = await runInstaller()
  if (result.succeeded || !result.stderr.includes('found v23.11.0')) {
    throw new Error('Installer must reject Node.js versions older than 24')
  }

  await Promise.all([
    fs.writeFile(
      path.join(temporaryDirectory, 'node'),
      '#!/bin/sh\necho v24.0.0\n',
      { mode: 0o755 }
    ),
    fs.writeFile(path.join(temporaryDirectory, 'npm'), '#!/bin/sh\nexit 0\n', {
      mode: 0o755
    })
  ])
  result = await runInstaller()
  if (
    result.succeeded ||
    !result.stderr.includes('Install it with your preferred package manager')
  ) {
    throw new Error(
      'Installer must handle systems without a recognized package manager or tmux'
    )
  }

  await fs.writeFile(
    path.join(temporaryDirectory, 'apt-get'),
    '#!/bin/sh\nexit 0\n',
    { mode: 0o755 }
  )
  result = await runInstaller()
  if (result.succeeded || !result.stderr.includes('Install it with APT')) {
    throw new Error('Installer must offer an available Linux package manager')
  }

  const installRoot = path.join(temporaryDirectory, 'curl-install')
  const binDirectory = path.join(temporaryDirectory, 'bin')
  const dataHome = path.join(temporaryDirectory, 'xdg-data')
  const runtimeHome = path.join(temporaryDirectory, 'xdg-runtime')
  const dataDirectory = path.join(dataHome, 'treeport')
  const runtimeDirectory = path.join(runtimeHome, 'treeport')
  await Promise.all([
    fs.mkdir(path.join(installRoot, 'current'), { recursive: true }),
    fs.mkdir(binDirectory, { recursive: true }),
    fs.mkdir(dataDirectory, { recursive: true }),
    fs.mkdir(runtimeDirectory, { recursive: true })
  ])
  await Promise.all([
    fs.writeFile(path.join(installRoot, 'current/install.json'), '{}\n'),
    fs.writeFile(path.join(dataDirectory, 'treeport.db'), ''),
    fs.writeFile(path.join(runtimeDirectory, 'daemon.json'), ''),
    fs.writeFile(path.join(binDirectory, 'treeport'), '#!/bin/sh\nexit 0\n', {
      mode: 0o755
    })
  ])

  const uninstalled = await execute(
    '/bin/sh',
    [path.join(docsDirectory, 'public/uninstall.sh')],
    {
      env: {
        ...process.env,
        HOME: temporaryDirectory,
        TREEPORT_INSTALL_ROOT: installRoot,
        TREEPORT_BIN_DIR: binDirectory,
        TREEPORT_PURGE: '1',
        TREEPORT_DATA_DIR: '',
        TREEPORT_RUNTIME_DIR: '',
        XDG_DATA_HOME: dataHome,
        XDG_RUNTIME_DIR: runtimeHome
      }
    }
  )
  if (
    !uninstalled.stdout.includes('Removed Treeport application data.') ||
    !uninstalled.stdout.includes('Uninstalled Treeport.')
  ) {
    throw new Error('Uninstaller must report a complete purge')
  }

  for (const removedPath of [installRoot, dataDirectory, runtimeDirectory]) {
    const stillExists = await fs
      .access(removedPath)
      .then(() => true)
      .catch(() => false)
    if (stillExists) {
      throw new Error(`Uninstaller did not remove ${removedPath}`)
    }
  }
} finally {
  await fs.rm(temporaryDirectory, { recursive: true, force: true })
}

console.log(
  `Installer checks passed for ${manifest.package}@${manifest.treeportVersion}`
)
