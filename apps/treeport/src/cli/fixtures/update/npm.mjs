// Controlled npm boundary: no registry access or dependency installation.
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'

const root = process.env.UPDATE_CONTRACT_ROOT
const config = JSON.parse(
  await fs.readFile(path.join(root, 'config.json'), 'utf8')
)
const args = process.argv.slice(2)
await fs.appendFile(
  path.join(root, 'events.jsonl'),
  `${JSON.stringify({ command: 'npm', args })}\n`
)
switch (args[0]) {
  case 'prefix':
    console.log(path.join(root, 'prefix'))
    break
  case 'view':
    console.log(
      JSON.stringify({
        name: '@treeport/treeport',
        version: config.latest,
        dist: {
          tarball: 'https://registry.invalid/treeport.tgz',
          integrity: 'sha512-contract'
        }
      })
    )
    break
  case 'pack': {
    if (config.packFailure) {
      console.error('controlled pack failure')
      process.exit(1)
    }

    const destination = args[args.indexOf('--pack-destination') + 1]
    assert(
      destination.startsWith(`${root}${path.sep}`),
      'Pack must stay in the fixture'
    )
    await fs.writeFile(
      path.join(destination, 'release.tgz'),
      'controlled tarball'
    )
    console.log(
      JSON.stringify([
        {
          filename: 'release.tgz',
          integrity: config.badIntegrity ? 'sha512-wrong' : 'sha512-contract'
        }
      ])
    )
    break
  }
  case 'install': {
    const prefix = args[args.indexOf('--prefix') + 1]
    assert(
      prefix.startsWith(`${root}${path.sep}`),
      'Install must stay in the fixture'
    )
    const directory = path.join(prefix, 'lib/node_modules/@treeport/treeport')
    await fs.cp(path.join(root, 'candidate'), directory, { recursive: true })
    if (config.installFailure) {
      console.error('controlled install failure after partial write')
      process.exit(1)
    }

    break
  }
  default:
    throw new Error(`Unexpected npm command: ${args.join(' ')}`)
}
