import { execFile } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { expect, it } from 'vitest'

const execute = promisify(execFile)

async function packFixture(root: string, version: string): Promise<string> {
  const packageDirectory = path.join(root, `package-${version}`)
  await fs.mkdir(path.join(packageDirectory, 'bin'), { recursive: true })
  await fs.writeFile(
    path.join(packageDirectory, 'package.json'),
    JSON.stringify({
      name: '@treeport/treeport',
      version,
      type: 'module',
      bin: { treeport: 'bin/treeport.mjs' }
    })
  )
  await fs.writeFile(
    path.join(packageDirectory, 'bin/treeport.mjs'),
    `#!/usr/bin/env node\nconsole.log(${JSON.stringify(version)})\n`,
    { mode: 0o755 }
  )
  const { stdout } = await execute('npm', ['pack', '--silent'], {
    cwd: packageDirectory
  })
  return path.join(packageDirectory, stdout.trim())
}

it('lets npm reinstall replace a failed managed update without touching user data', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'treeport-reinstall-'))
  const prefix = path.join(root, 'prefix')
  const dataDir = path.join(root, 'data')
  const entrypoint = path.join(prefix, 'bin/treeport')
  const currentLink = path.join(prefix, 'lib/treeport/current')
  const failedTarget = path.join(prefix, 'lib/treeport/versions/1.2.4')
  const environment = {
    ...process.env,
    HOME: path.join(root, 'home'),
    TREEPORT_DATA_DIR: dataDir,
    TREEPORT_RUNTIME_DIR: path.join(root, 'runtime')
  }

  try {
    const oldTarball = await packFixture(root, '1.2.3')
    const replacementTarball = await packFixture(root, '1.2.4')
    await execute(
      'npm',
      [
        'install',
        '--global',
        '--prefix',
        prefix,
        '--ignore-scripts',
        '--no-audit',
        '--no-fund',
        oldTarball
      ],
      { env: environment }
    )

    await fs.mkdir(path.join(failedTarget, 'bin'), { recursive: true })
    await fs.writeFile(
      path.join(failedTarget, 'bin/treeport.mjs'),
      '#!/usr/bin/env node\nprocess.exit(23)\n',
      { mode: 0o755 }
    )
    await fs.mkdir(path.dirname(currentLink), { recursive: true })
    await fs.symlink(failedTarget, currentLink)
    await fs.rm(entrypoint)
    await fs.writeFile(
      entrypoint,
      `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(
        path.join(currentLink, 'bin/treeport.mjs')
      )} "$@"\n`,
      { mode: 0o755 }
    )
    await fs.mkdir(dataDir, { recursive: true })
    const catalog = path.join(dataDir, 'treeport.db')
    await fs.writeFile(catalog, 'user catalog')

    await expect(
      execute(entrypoint, [], { env: environment })
    ).rejects.toThrow()

    await execute(
      'npm',
      [
        'install',
        '--global',
        '--prefix',
        prefix,
        '--ignore-scripts',
        '--no-audit',
        '--no-fund',
        replacementTarball
      ],
      { env: environment }
    )

    expect((await fs.lstat(entrypoint)).isSymbolicLink()).toBe(true)
    expect((await execute(entrypoint, [], { env: environment })).stdout).toBe(
      '1.2.4\n'
    )
    expect(await fs.readFile(catalog, 'utf8')).toBe('user catalog')
    expect(await fs.realpath(currentLink)).toBe(await fs.realpath(failedTarget))
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})
