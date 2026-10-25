import { spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

// Headless Chromium paces every page at a fixed 60 Hz, and input crosses
// several frame-aligned stages before it reaches pixels. A private X server
// with a dummy output instead paces pages at the viewer's refresh rate. The
// display has no window manager; pages are still sized by device-metrics
// emulation.
//
// Chromium holds every CDP wheel event until the page's main thread commits a
// frame, so scrolling froze whenever a page was busy. Native scrolls run on
// the compositor thread instead. Xorg's inputtest driver provides a touchpad
// whose scroll deltas Chromium applies as exact pixels, and hosted windows are
// pinned fullscreen at the origin, so the output covers the largest viewport.
const MODE_TIMINGS = [
  '3840',
  '3848',
  '3856',
  '3888',
  '2160',
  '2162',
  '2164',
  '2166'
]

const MODE_PIXELS = 3888 * 2166

// The dummy driver otherwise rejects pixel clocks above 300 MHz. Rates go up
// to 240 Hz (see setRefreshRate).
const XORG_CONFIG = (input: string) => `Section "ServerFlags"
  Option "AutoAddDevices" "false"
  Option "AutoAddGPU" "false"
  Option "DontVTSwitch" "true"
EndSection
Section "Device"
  Identifier "device"
  Driver "dummy"
  VideoRam 65536
  DacSpeed ${Math.ceil((MODE_PIXELS * 240) / 1e6)}
EndSection
Section "InputDevice"
  Identifier "pointer"
  Driver "inputtest"
  Option "DeviceType" "PointerGesture"
  Option "SocketPath" "${input}"
EndSection
Section "ServerLayout"
  Identifier "layout"
  Screen "screen"
  InputDevice "pointer" "SendCoreEvents"
EndSection
Section "Monitor"
  Identifier "monitor"
  HorizSync 1.0 - 1000.0
  VertRefresh 1.0 - 1000.0
  Modeline "treeport" ${((MODE_PIXELS * 120) / 1e6).toFixed(3)} ${MODE_TIMINGS.join(' ')}
EndSection
Section "Screen"
  Identifier "screen"
  Device "device"
  Monitor "monitor"
  DefaultDepth 24
  SubSection "Display"
    Depth 24
    Modes "treeport"
  EndSubSection
EndSection
`

export interface BrowserDisplay {
  name: string
  width: number
  height: number
  // The inputtest socket, or null without the driver (CDP input then).
  input: string | null
  setRefreshRate(hz: number): void
  close(): void
}

// Returns null when Xorg or its dummy driver is unavailable; callers keep
// using headless Chromium then.
export async function startBrowserDisplay(
  directory: string
): Promise<BrowserDisplay | null> {
  if (process.platform !== 'linux') {
    return null
  }

  // Socket paths are limited to 107 bytes, too short for profile paths. The
  // private directory keeps other users from injecting input.
  const inputDirectory = await fs.mkdtemp(
    path.join(os.tmpdir(), 'treeport-input-')
  )

  const input = path.join(inputDirectory, 'pointer')

  const removeInput = () =>
    void fs.rm(inputDirectory, { recursive: true, force: true })

  const config = path.join(directory, 'treeport-xorg.conf')
  await fs.writeFile(config, XORG_CONFIG(input), { mode: 0o600 })

  for (let display = 90; display < 130; display++) {
    // A live server owns its lock; Xorg itself removes stale locks.
    if (
      await fs.access(`/tmp/.X${display}-lock`).then(
        () => true,
        () => false
      )
    ) {
      continue
    }

    // -terminate exits once the last client (Chromium) disconnects, so a
    // killed daemon cannot leak the server. -displayfd cannot be used: it
    // requires a filesystem socket, and WSL mounts /tmp/.X11-unix read-only.
    const server = spawn(
      'Xorg',
      [
        `:${display}`,
        '-config',
        config,
        '-logfile',
        path.join(directory, 'treeport-xorg.log'),
        '-nolisten',
        'tcp',
        '-novtswitch',
        '-terminate'
      ],
      { stdio: ['ignore', 'ignore', 'pipe'] }
    )

    let errors = ''
    server.stderr.setEncoding('utf8')
    server.stderr.on('data', (chunk: string) => {
      errors = (errors + chunk).slice(-4096)
    })
    let running = true

    const exited = new Promise<void>((resolve) => {
      const done = () => {
        running = false
        resolve()
      }

      server.once('exit', done)
      server.once('error', done)
    })

    const socket = ` @/tmp/.X11-unix/X${display}`
    let listening = -1

    for (
      let attempt = 0;
      running && (listening < 0 ? attempt < 100 : attempt - listening <= 20);
      attempt++
    ) {
      // Probe the listening socket without connecting: the first client to
      // disconnect would otherwise terminate the server.
      const sockets = (await fs.readFile('/proc/net/unix', 'utf8')).split('\n')
      const inputReady = sockets.some((line) => line.endsWith(` ${input}`))

      if (sockets.some((line) => line.endsWith(socket))) {
        listening = listening < 0 ? attempt : listening
      }

      // Input devices start just after the display socket opens. Without the
      // inputtest driver, Xorg runs without the device.
      if (listening >= 0 && (inputReady || attempt - listening >= 20)) {
        const name = `:${display}`

        const xrandr = (...args: string[]) =>
          new Promise<void>((resolve, reject) => {
            spawn('xrandr', args, {
              env: { ...process.env, DISPLAY: name },
              stdio: 'ignore'
            })
              .once('error', reject)
              .once('exit', (code) =>
                code === 0 ? resolve() : reject(new Error('xrandr failed'))
              )
          })

        let requested = 120
        let mode = 'treeport'
        let modes = 0
        let switching = Promise.resolve()

        return {
          name,
          width: Number(MODE_TIMINGS[0]),
          height: Number(MODE_TIMINGS[4]),
          input: inputReady ? input : null,
          setRefreshRate: (hz) => {
            // Above 120 Hz, half the rate keeps every frame on screen for
            // the same number of refreshes.
            const rate = Math.max(30, hz > 121 ? hz / 2 : hz)

            if (Math.abs(rate - requested) < 0.05) {
              return
            }

            requested = rate
            switching = switching
              .then(async () => {
                if (requested !== rate || !running) {
                  return
                }

                // Chromium rereads the refresh rate only when the output's
                // mode list changes, so every switch adds a fresh mode.
                const next = `treeport-${Math.round(rate)}-${++modes}`
                await xrandr(
                  '--newmode',
                  next,
                  ((MODE_PIXELS * rate) / 1e6).toFixed(3),
                  ...MODE_TIMINGS
                )
                await xrandr('--addmode', 'DUMMY0', next)
                await xrandr('--output', 'DUMMY0', '--mode', next)
                const previous = mode
                mode = next

                if (previous !== 'treeport') {
                  await xrandr('--delmode', 'DUMMY0', previous)
                  await xrandr('--rmmode', previous)
                }
              })
              .catch(() => undefined)
          },
          close: () => {
            server.kill()
            removeInput()
          }
        }
      }

      await new Promise((resolve) => setTimeout(resolve, 50))
    }

    server.kill()
    await exited

    // Only a display claimed by another server is worth another attempt.
    // A missing binary, driver or permission fails the same way everywhere.
    if (!errors.includes('already active')) {
      break
    }
  }

  removeInput()

  return null
}
