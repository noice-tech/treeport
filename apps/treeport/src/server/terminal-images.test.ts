import xtermHeadless from '@xterm/headless'
import { SerializeAddon } from '@xterm/addon-serialize'
import { expect, it } from 'vitest'
import { TerminalImages } from '../terminal-images'

const png =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aD1sAAAAASUVORK5CYII='
const transmit = `\x1b_Ga=T,f=100,i=42,c=4,r=2,C=1,q=2;${png}\x1b\\`

function createTerminal() {
  const terminal = new xtermHeadless.Terminal({
    cols: 80,
    rows: 24,
    allowProposedApi: true
  })
  const images = new TerminalImages(true)
  const serializer = new SerializeAddon()
  // SAFETY: These addons use the shared headless terminal boundary.
  terminal.loadAddon(images as never)
  // SAFETY: SerializeAddon supports both pinned xterm implementations.
  terminal.loadAddon(serializer as never)
  const write = (data: string) =>
    new Promise<void>((resolve) => terminal.write(data, resolve))
  return { terminal, images, serializer, write }
}

it('retains uploads across placement deletion and snapshots canonical tiles without replaying queries', async () => {
  const { terminal, images, serializer, write } = createTerminal()
  await write('\x1b[?1049h\x1b[3;5H' + transmit)
  const first = await images.snapshot()
  expect(first.images).toHaveLength(1)
  expect(first.placements).toMatchObject([
    {
      imageId: 42,
      buffer: 'alternate',
      tiles: [
        [2, 4, 0, 4],
        [3, 4, 4, 4]
      ]
    }
  ])
  await write('\x1b_Ga=d,d=a,q=2\x1b\\')
  expect((await images.snapshot()).images).toHaveLength(1)
  expect((await images.snapshot()).placements).toHaveLength(0)
  await write('\x1b[5;7H\x1b_Ga=p,i=42,c=4,r=2,C=1,q=2\x1b\\')
  const redraw = await images.snapshot()
  expect(redraw.placements).toMatchObject([
    {
      tiles: [
        [4, 6, 0, 4],
        [5, 6, 4, 4]
      ]
    }
  ])
  expect(serializer.serialize()).not.toContain('\x1b_G')
  await write('\x1b_Ga=d,d=I,i=42,q=2\x1b\\')
  expect((await images.snapshot()).images).toHaveLength(0)
  terminal.dispose()
})

it('restores an upload at every PTY boundary, including APC prefixes, ST and chunk continuations', async () => {
  const wire = `\x1b_Ga=T,f=100,i=42,c=4,r=2,C=1,q=2,m=1;${png.slice(0, 40)}\x1b\\\x1b_Gm=0;${png.slice(40)}\x1b\\`
  for (let split = 1; split < wire.length; split++) {
    const host = createTerminal()
    const restored = createTerminal()
    await host.write(wire.slice(0, split))
    const snapshot = await host.images.snapshot()
    await restored.write(host.serializer.serialize())
    await restored.images.restore(snapshot)
    await restored.write(snapshot.pending + wire.slice(split))
    expect(
      (await restored.images.snapshot()).placements,
      `split ${split}`
    ).toMatchObject([
      {
        imageId: 42,
        tiles: [
          [0, 0, 0, 4],
          [1, 0, 4, 4]
        ]
      }
    ])
    expect(
      restored.terminal.buffer.active.getLine(0)?.translateToString(true),
      `split ${split}`
    ).toBe('')
    host.terminal.dispose()
    restored.terminal.dispose()
  }
})

it('tracks erasure, scrollback, both buffers, multiple placements, and upload IDs across recovery', async () => {
  const host = createTerminal()
  const restored = createTerminal()
  await host.write(transmit.replace('i=42,', '') + '\r\n' + '\r\n'.repeat(24))
  await host.write(
    '\x1b[?1049h\x1b[3;5H\x1b_Ga=p,i=1,p=1,c=4,r=2,C=1,q=2\x1b\\'
  )
  await host.write('\x1b[7;9H\x1b_Ga=p,i=1,p=2,c=4,r=2,C=1,q=2\x1b\\')
  await host.write('\x1b_Ga=d,d=i,i=1,p=1,q=2\x1b\\')
  const snapshot = await host.images.snapshot()
  expect(snapshot.placements).toHaveLength(2)
  expect(snapshot.placements.map((p) => p.buffer)).toEqual([
    'normal',
    'alternate'
  ])
  const responses: string[] = []
  restored.terminal.onData((data) => responses.push(data))
  await restored.write(host.serializer.serialize())
  const cursor = {
    x: restored.terminal.buffer.active.cursorX,
    y: restored.terminal.buffer.active.cursorY
  }
  await restored.images.restore(snapshot)
  expect(await restored.images.snapshot()).toEqual(snapshot)
  expect(responses).toEqual([])
  expect({
    x: restored.terminal.buffer.active.cursorX,
    y: restored.terminal.buffer.active.cursorY
  }).toEqual(cursor)
  await restored.write(transmit.replace('i=42,', ''))
  expect(
    (await restored.images.snapshot()).images.map((image) => image.id)
  ).toEqual([1, 2])
  await restored.write('\x1b[2J')
  expect(
    (await restored.images.snapshot()).placements.every(
      (p) => p.buffer === 'normal'
    )
  ).toBe(true)
  await restored.write('\x1bc')
  expect((await restored.images.snapshot()).images).toHaveLength(0)
  host.terminal.dispose()
  restored.terminal.dispose()
})

it('does not replay completed queries between chunks and discards cancelled uploads', async () => {
  const { terminal, images, write } = createTerminal()
  const chunk = `\x1b_Ga=T,f=100,i=42,c=4,r=2,q=2,m=1;${png.slice(0, 40)}\x1b\\`
  await write(chunk)
  await write('\x1b_Ga=q,i=99\x1b\\\x1b_Ga=d,d=a,q=2\x1b\\')
  expect((await images.snapshot()).pending).toBe(chunk)
  await write('\x1b_Gm=0;AAAA\x18')
  expect((await images.snapshot()).pending).toBe('')
  await write(transmit)
  expect((await images.snapshot()).placements).toHaveLength(1)
  terminal.dispose()
})

it('bounds cached upload bytes even when images have no placements', async () => {
  const { terminal, images, write } = createTerminal()
  const payload = 'AAAA'.repeat(3 * 1024 * 1024)
  await write(`\x1b_Ga=t,f=32,i=1,q=2;${payload}\x1b\\`)
  await write(`\x1b_Ga=t,f=32,i=2,q=2;${payload}\x1b\\`)
  expect((await images.snapshot()).images.map((image) => image.id)).toEqual([2])
  terminal.dispose()
})
