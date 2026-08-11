import fs from 'node:fs/promises'
import path from 'node:path'
import type {
  WorktreeListener,
  WorktreeListenerDiscovery
} from '@treeport/shared'
import type { CommandRunner } from './command'

export interface WorktreeListenerScope {
  worktreePath: string
  panes: Array<{ pid: number; terminalId: string }>
}

interface ProcessInfo {
  pid: number
  ppid: number
  command: string
  cwd: string | null
}

interface SocketInfo {
  pid: number
  command: string
  host: string
  port: number
  inode?: string
}

function inWorktree(cwd: string | null, worktreePath: string): boolean {
  if (!cwd) {
    return false
  }

  const relative = path.relative(worktreePath, cwd)
  return (
    relative === '' ||
    (!relative.startsWith('..') && !path.isAbsolute(relative))
  )
}

function terminalForProcess(
  pid: number,
  processes: Map<number, ProcessInfo>,
  panes: Map<number, string>
): string | null {
  const visited = new Set<number>()
  let current = pid
  while (current > 0 && !visited.has(current)) {
    const terminalId = panes.get(current)
    if (terminalId) {
      return terminalId
    }

    visited.add(current)
    current = processes.get(current)?.ppid ?? 0
  }

  return null
}

function ipv6Address(hex: string): string | null {
  if (!/^[a-f\d]{32}$/iu.test(hex)) {
    return null
  }

  const bytes: number[] = []
  for (let word = 0; word < 4; word += 1) {
    const value = hex.slice(word * 8, word * 8 + 8)
    for (let byte = 3; byte >= 0; byte -= 1) {
      bytes.push(Number.parseInt(value.slice(byte * 2, byte * 2 + 2), 16))
    }
  }
  const groups = Array.from({ length: 8 }, (_, index) =>
    ((bytes[index * 2]! << 8) | bytes[index * 2 + 1]!).toString(16)
  )
  let bestStart = -1
  let bestLength = 0
  for (let index = 0; index < groups.length;) {
    if (groups[index] !== '0') {
      index += 1
      continue
    }

    let end = index
    while (groups[end] === '0') {
      end += 1
    }

    if (end - index > bestLength) {
      bestStart = index
      bestLength = end - index
    }

    index = end
  }

  if (bestLength < 2) {
    return groups.join(':')
  }

  const left = groups.slice(0, bestStart).join(':')
  const right = groups.slice(bestStart + bestLength).join(':')
  return `${left}::${right}`
}

function parseProcSockets(
  source: string,
  ipv6: boolean
): Map<string, Omit<SocketInfo, 'pid' | 'command'>> {
  const sockets = new Map<string, Omit<SocketInfo, 'pid' | 'command'>>()
  for (const line of source.split('\n').slice(1)) {
    const fields = line.trim().split(/\s+/u)
    if (fields.length < 10 || fields[3] !== '0A') {
      continue
    }

    const [addressHex, portHex] = fields[1]!.split(':')
    const port = Number.parseInt(portHex ?? '', 16)
    const inode = fields[9]!
    let host: string | null = null
    if (ipv6) {
      host = ipv6Address(addressHex ?? '')
    } else if (/^[a-f\d]{8}$/iu.test(addressHex ?? '')) {
      host = (addressHex!.match(/../gu) ?? [])
        .reverse()
        .map((byte) => Number.parseInt(byte, 16))
        .join('.')
    }

    if (host && port > 0 && port <= 65_535 && /^\d+$/u.test(inode)) {
      sockets.set(inode, { host, port, inode })
    }
  }

  return sockets
}

function parseEndpoint(value: string): { host: string; port: number } | null {
  const endpoint = value.replace(/\s+\(LISTEN\)$/u, '').trim()
  let host: string
  let portText: string
  if (endpoint.startsWith('[')) {
    const close = endpoint.lastIndexOf(']:')
    if (close < 0) {
      return null
    }

    host = endpoint.slice(1, close)
    portText = endpoint.slice(close + 2)
  } else {
    const separator = endpoint.lastIndexOf(':')
    if (separator < 1) {
      return null
    }

    host = endpoint.slice(0, separator)
    portText = endpoint.slice(separator + 1)
  }

  const port = Number.parseInt(portText, 10)
  return host && port > 0 && port <= 65_535 ? { host, port } : null
}

function finalListeners(
  sockets: SocketInfo[],
  processes: Map<number, ProcessInfo>,
  panes: Array<{ pid: number; terminalId: string }>,
  worktreePath: string
): WorktreeListener[] {
  const paneMap = new Map(panes.map((pane) => [pane.pid, pane.terminalId]))
  const listeners = new Map<string, WorktreeListener>()
  for (const socket of sockets) {
    const process = processes.get(socket.pid)
    if (!process) {
      continue
    }

    const terminalId = terminalForProcess(socket.pid, processes, paneMap)
    if (!terminalId && !inWorktree(process.cwd, worktreePath)) {
      continue
    }

    const listener = {
      pid: socket.pid,
      command: socket.command || process.command,
      host: socket.host,
      port: socket.port,
      terminalId
    }
    listeners.set(
      `${listener.pid}\0${listener.host}\0${listener.port}`,
      listener
    )
  }

  return [...listeners.values()].sort(
    (left, right) =>
      left.port - right.port ||
      left.command.localeCompare(right.command) ||
      left.pid - right.pid ||
      left.host.localeCompare(right.host)
  )
}

export class NetworkListenerAdapter {
  constructor(
    private readonly runner: CommandRunner,
    private readonly platform: NodeJS.Platform = process.platform,
    private readonly procRoot = '/proc'
  ) {}

  async listeners(
    scope: WorktreeListenerScope
  ): Promise<WorktreeListenerDiscovery> {
    if (this.platform !== 'linux' && this.platform !== 'darwin') {
      return {
        supported: false,
        message: 'TCP listener discovery is not supported on this platform.',
        listeners: []
      }
    }

    const worktreePath = await fs.realpath(scope.worktreePath)
    if (this.platform === 'linux') {
      const [tcp, tcp6, entries] = await Promise.all([
        fs.readFile(path.join(this.procRoot, 'net/tcp'), 'utf8'),
        fs
          .readFile(path.join(this.procRoot, 'net/tcp6'), 'utf8')
          .catch(() => ''),
        fs.readdir(this.procRoot, { withFileTypes: true })
      ])
      const socketByInode = new Map([
        ...parseProcSockets(tcp, false),
        ...parseProcSockets(tcp6, true)
      ])
      const processes = new Map<number, ProcessInfo>()
      await Promise.all(
        entries
          .filter((entry) => entry.isDirectory() && /^\d+$/u.test(entry.name))
          .map(async (entry) => {
            const pid = Number(entry.name)
            const processRoot = path.join(this.procRoot, entry.name)
            const [stat, command, cwd] = await Promise.all([
              fs
                .readFile(path.join(processRoot, 'stat'), 'utf8')
                .catch(() => null),
              fs
                .readFile(path.join(processRoot, 'comm'), 'utf8')
                .catch(() => ''),
              fs.realpath(path.join(processRoot, 'cwd')).catch(() => null)
            ])
            if (!stat) {
              return
            }

            const close = stat.lastIndexOf(')')
            const afterCommand =
              close >= 0
                ? stat
                    .slice(close + 1)
                    .trim()
                    .split(/\s+/u)
                : []
            const ppid = Number.parseInt(afterCommand[1] ?? '', 10)
            if (Number.isInteger(ppid)) {
              processes.set(pid, { pid, ppid, command: command.trim(), cwd })
            }
          })
      )
      const paneMap = new Map(
        scope.panes.map((pane) => [pane.pid, pane.terminalId])
      )
      const candidates = [...processes.values()].filter(
        (process) =>
          inWorktree(process.cwd, worktreePath) ||
          terminalForProcess(process.pid, processes, paneMap) !== null
      )
      const sockets: SocketInfo[] = []
      await Promise.all(
        candidates.map(async (process) => {
          const fdRoot = path.join(this.procRoot, String(process.pid), 'fd')
          const descriptors = await fs.readdir(fdRoot).catch(() => [])
          await Promise.all(
            descriptors.map(async (descriptor) => {
              const target = await fs
                .readlink(path.join(fdRoot, descriptor))
                .catch(() => '')
              const match = /^socket:\[(\d+)\]$/u.exec(target)
              const socket = match ? socketByInode.get(match[1]!) : undefined
              if (socket) {
                sockets.push({
                  ...socket,
                  pid: process.pid,
                  command: process.command
                })
              }
            })
          )
        })
      )
      return {
        supported: true,
        message: null,
        listeners: finalListeners(sockets, processes, scope.panes, worktreePath)
      }
    }

    const [lsofResult, psResult] = await Promise.all([
      this.runner.run({
        executable: '/usr/sbin/lsof',
        args: ['-nP', '-iTCP', '-sTCP:LISTEN', '-Fpcn'],
        timeoutMs: 10_000
      }),
      this.runner.run({
        executable: '/bin/ps',
        args: ['-axo', 'pid=,ppid='],
        timeoutMs: 10_000
      })
    ])
    if (lsofResult.exitCode !== 0) {
      throw new Error(
        lsofResult.stderr.trim() || 'Failed to enumerate listening TCP sockets'
      )
    }

    if (psResult.exitCode !== 0) {
      throw new Error(psResult.stderr.trim() || 'Failed to enumerate processes')
    }

    const sockets: SocketInfo[] = []
    let pid = 0
    let command = ''
    for (const line of lsofResult.stdout.split('\n')) {
      const field = line[0]
      const value = line.slice(1)
      if (field === 'p') {
        pid = Number.parseInt(value, 10)
        command = ''
      } else if (field === 'c') {
        command = value
      } else if (field === 'n' && pid > 0) {
        const endpoint = parseEndpoint(value)
        if (endpoint) {
          sockets.push({ pid, command, ...endpoint })
        }
      }
    }

    const processes = new Map<number, ProcessInfo>()
    for (const line of psResult.stdout.split('\n')) {
      const match = /^\s*(\d+)\s+(\d+)\s*$/u.exec(line)
      if (!match) {
        continue
      }

      const processPid = Number(match[1])
      processes.set(processPid, {
        pid: processPid,
        ppid: Number(match[2]),
        command:
          sockets.find((socket) => socket.pid === processPid)?.command ?? '',
        cwd: null
      })
    }

    const listenerPids = [...new Set(sockets.map((socket) => socket.pid))]
    for (let start = 0; start < listenerPids.length; start += 100) {
      const chunk = listenerPids.slice(start, start + 100)
      const cwdResult = await this.runner.run({
        executable: '/usr/sbin/lsof',
        args: ['-a', '-d', 'cwd', '-p', chunk.join(','), '-Fpn'],
        timeoutMs: 10_000
      })
      if (cwdResult.exitCode !== 0) {
        continue
      }

      let cwdPid = 0
      for (const line of cwdResult.stdout.split('\n')) {
        if (line[0] === 'p') {
          cwdPid = Number.parseInt(line.slice(1), 10)
        }

        if (line[0] === 'n' && cwdPid > 0) {
          const process = processes.get(cwdPid)
          if (process) {
            process.cwd = await fs.realpath(line.slice(1)).catch(() => null)
          }
        }
      }
    }

    return {
      supported: true,
      message: null,
      listeners: finalListeners(sockets, processes, scope.panes, worktreePath)
    }
  }
}
