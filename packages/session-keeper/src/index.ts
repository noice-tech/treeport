import crypto from 'node:crypto'
import fs, { type FileHandle } from 'node:fs/promises'
import { constants } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// Release artifacts and runtime reads share this bound. A corrupt or growing
// installation must not turn executable materialization into an unbounded read.
export const SESSION_KEEPER_MAX_PAYLOAD_BYTES = 64 * 1024 * 1024

export function getSessionKeeperPayload(): string {
  return fileURLToPath(
    new URL(
      `./native/${process.platform}-${process.arch}/treeport-session-keeper`,
      import.meta.url
    )
  )
}

async function readNativePayload(
  file: FileHandle,
  expectedSize: number | null
): Promise<Buffer> {
  const metadata = await file.stat()
  if (
    !metadata.isFile() ||
    !Number.isSafeInteger(metadata.size) ||
    metadata.size === 0 ||
    metadata.size > SESSION_KEEPER_MAX_PAYLOAD_BYTES ||
    (expectedSize !== null && metadata.size !== expectedSize)
  ) {
    throw new Error(
      'Session keeper file does not identify a bounded native payload'
    )
  }

  const bytes = Buffer.alloc(metadata.size)
  let offset = 0
  while (offset < bytes.length) {
    const { bytesRead } = await file.read(
      bytes,
      offset,
      Math.min(64 * 1024, bytes.length - offset),
      offset
    )
    if (bytesRead === 0) {
      throw new Error('Session keeper payload changed while reading')
    }

    offset += bytesRead
  }
  // Fixed positional reads never follow an append stream indefinitely. Check
  // its boundary and metadata before using bytes from a concurrently edited file.
  const tail = await file.read(Buffer.alloc(1), 0, 1, bytes.length)
  const after = await file.stat()
  if (
    tail.bytesRead !== 0 ||
    after.size !== metadata.size ||
    after.mtimeMs !== metadata.mtimeMs
  ) {
    throw new Error('Session keeper payload changed while reading')
  }

  return bytes
}

async function verifyCachedKeeper(
  binary: string,
  bytes: Buffer,
  hash: string,
  uid: number
): Promise<boolean> {
  const existing = await fs
    .open(
      binary,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
    )
    .catch((cause) => {
      // SAFETY: Node filesystem errors expose errno codes. Only absence permits
      // publication; inaccessible or invalid entries must never be replaced.
      if ((cause as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw cause
      }

      return null
    })
  if (existing === null) {
    return false
  }

  try {
    const metadata = await existing.stat()
    if (
      !metadata.isFile() ||
      metadata.size !== bytes.length ||
      metadata.uid !== uid ||
      (metadata.mode & 0o077) !== 0 ||
      (metadata.mode & 0o100) === 0 ||
      crypto
        .createHash('sha256')
        .update(await readNativePayload(existing, bytes.length))
        .digest('hex') !== hash
    ) {
      throw new Error(
        'Session keeper cache does not identify its native payload'
      )
    }

    return true
  } finally {
    await existing.close()
  }
}

/** npm tarballs normalize non-bin payloads to 0644. Materialize the selected
 * native payload in private runtime storage, without editing the installation
 * or replacing executable inodes belonging to already-running owners. */
export async function prepareSessionKeeper(
  payload: string,
  directory: string
): Promise<string> {
  // Reject known special files before opening them at all. The descriptor
  // checks and flags below also defend against replacement after this check.
  if (!(await fs.lstat(payload)).isFile()) {
    throw new Error(
      'Session keeper file does not identify a bounded native payload'
    )
  }

  const source = await fs.open(
    payload,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
  )
  let bytes: Buffer
  try {
    bytes = await readNativePayload(source, null)
  } finally {
    await source.close()
  }
  const hash = crypto.createHash('sha256').update(bytes).digest('hex')
  await fs.mkdir(directory, { recursive: true, mode: 0o700 })
  const parent = await fs.lstat(directory)
  if (
    !parent.isDirectory() ||
    parent.uid !== process.getuid?.() ||
    (parent.mode & 0o077) !== 0
  ) {
    throw new Error(
      'Session keeper cache must be private and owned by this user'
    )
  }

  const binary = path.join(directory, `keeper-${hash}`)
  if (await verifyCachedKeeper(binary, bytes, hash, parent.uid)) {
    return binary
  }

  const temporary = `${binary}-${crypto.randomUUID()}.tmp`
  try {
    const file = await fs.open(temporary, 'wx', 0o700)
    try {
      await file.writeFile(bytes)
      await file.sync()
    } finally {
      await file.close()
    }
    // Hard-link publication is exclusive. A racing launcher may have already
    // published this hash; verify its inode instead of replacing it via rename.
    const published = await fs
      .link(temporary, binary)
      .then(() => true)
      .catch((cause) => {
        // SAFETY: EEXIST is the only allowed publication race. Never overwrite a
        // concurrently created symlink/FIFO, wrong payload, or executable inode.
        if ((cause as NodeJS.ErrnoException).code !== 'EEXIST') {
          throw cause
        }

        return false
      })
    if (
      !published &&
      !(await verifyCachedKeeper(binary, bytes, hash, parent.uid))
    ) {
      throw new Error('Session keeper cache changed during publication')
    }
  } finally {
    await fs.rm(temporary, { force: true })
  }
  return binary
}
