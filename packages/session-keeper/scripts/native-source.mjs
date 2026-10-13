import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// Associates target payloads with the locked native source/toolchain inputs.
// This is not an ABI, signing or runtime qualification certificate.
export async function nativeSourceFingerprint() {
  const directory = fileURLToPath(new URL('..', import.meta.url))
  const sources = (
    await fs.readdir(path.join(directory, 'native/src'), { recursive: true })
  )
    .filter((file) => file.endsWith('.rs'))
    .map((file) => `native/src/${file}`)
  const files = [
    'native/Cargo.toml',
    'native/Cargo.lock',
    '../../rust-toolchain.toml',
    ...sources
  ].sort()
  const hash = crypto.createHash('sha256')
  for (const file of files) {
    hash
      .update(file)
      .update('\0')
      .update(await fs.readFile(path.join(directory, file)))
      .update('\0')
  }
  return hash.digest('hex')
}
