import { execFile } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { describe, expect, it, onTestFinished } from 'vitest'
import {
  createAdministratorCommand,
  createLaunchdDefinition,
  createServiceEnvironment,
  createSystemdDefinition,
  launchdLocation,
  serializeLaunchdDefinition,
  serializeSystemdDefinition,
  storedServiceMode,
  userLaunchdCommands
} from './service.js'

const execute = promisify(execFile)

describe('OS service definitions', () => {
  it('uses a per-user LaunchAgent for the normal macOS service lifecycle', () => {
    const home = '/Users/tree port'
    const location = launchdLocation({ uid: 501, home, mode: 'user' })
    const definition = createLaunchdDefinition({
      label: location.name,
      mode: 'user',
      runnerPath:
        '/Users/tree port/Library/Application Support/treeport/service/run',
      username: 'treeport',
      group: 'staff',
      environment: {
        HOME: home,
        PATH: '/opt/tree port/bin:/usr/bin'
      },
      home,
      logPath:
        '/Users/tree port/Library/Application Support/treeport/logs/daemon.log'
    })

    expect(location).toEqual({
      name: 'app.treeport.daemon.501',
      path: '/Users/tree port/Library/LaunchAgents/app.treeport.daemon.501.plist',
      domain: 'gui/501',
      target: 'gui/501/app.treeport.daemon.501'
    })
    expect(definition).toMatchObject({
      mode: 'user',
      username: null,
      group: null,
      keepAlive: true,
      abandonProcessGroup: true
    })
    const plist = serializeLaunchdDefinition(definition)
    expect(plist).not.toContain('<key>UserName</key>')
    expect(plist).not.toContain('<key>GroupName</key>')
    expect(plist).toContain('<key>KeepAlive</key>\n    <true/>')

    const lifecycle = [
      userLaunchdCommands({
        operation: 'enable',
        location,
        definitionPath: location.path
      }),
      userLaunchdCommands({
        operation: 'start',
        location,
        definitionPath: location.path,
        active: false
      }),
      userLaunchdCommands({
        operation: 'start',
        location,
        definitionPath: location.path,
        active: true
      }),
      userLaunchdCommands({
        operation: 'stop',
        location,
        definitionPath: location.path
      }),
      userLaunchdCommands({
        operation: 'disable',
        location,
        definitionPath: location.path
      })
    ]
    expect(lifecycle).toEqual([
      {
        bootout: ['bootout', location.target],
        enable: ['enable', location.target],
        activate: ['bootstrap', location.domain, location.path]
      },
      {
        bootout: null,
        enable: ['enable', location.target],
        activate: ['bootstrap', location.domain, location.path]
      },
      {
        bootout: null,
        enable: ['enable', location.target],
        activate: ['kickstart', '-k', location.target]
      },
      {
        bootout: ['bootout', location.target],
        enable: null,
        activate: null
      },
      {
        bootout: ['bootout', location.target],
        enable: null,
        activate: null
      }
    ])
    expect(JSON.stringify(lifecycle)).not.toMatch(
      /sudo|--request|LaunchDaemons/
    )
  })

  it('keeps advanced headless compatibility under the target macOS account', () => {
    const environment = {
      HOME: '/Users/tree port',
      PATH: '/opt/tree port/bin:/usr/bin',
      TREEPORT_DATA_DIR: '/Users/tree port/Library/Application Support/treeport'
    }
    const definition = createLaunchdDefinition({
      label: 'app.treeport.daemon.501',
      mode: 'headless',
      runnerPath:
        '/Users/tree port/Library/Application Support/treeport/service/run',
      username: 'treeport',
      group: 'staff',
      environment,
      home: '/Users/tree port',
      logPath:
        '/Users/tree port/Library/Application Support/treeport/logs/daemon.log'
    })

    expect(definition).toMatchObject({
      username: 'treeport',
      group: 'staff',
      keepAlive: true,
      abandonProcessGroup: true,
      processType: 'Background',
      umask: 0o077
    })
    expect(definition.programArguments).toEqual([
      '/Users/tree port/Library/Application Support/treeport/service/run'
    ])

    const plist = serializeLaunchdDefinition(definition)
    expect(plist).toContain(
      '<key>UserName</key>\n    <string>treeport</string>'
    )
    expect(plist).toContain('<key>AbandonProcessGroup</key>\n    <true/>')
    expect(plist).toContain(
      '<string>/Users/tree port/Library/Application Support/treeport/service/run</string>'
    )
  })

  it('recognizes released service records as their compatible service modes', () => {
    expect(storedServiceMode({ manager: 'launchd' })).toBe('headless')
    expect(storedServiceMode({ manager: 'systemd' })).toBe('user')
    expect(storedServiceMode({ manager: 'launchd', mode: 'user' })).toBe('user')

    expect(
      launchdLocation({
        uid: 501,
        home: '/Users/treeport',
        mode: storedServiceMode({ manager: 'launchd' })
      })
    ).toEqual({
      name: 'app.treeport.daemon.501',
      path: '/Library/LaunchDaemons/app.treeport.daemon.501.plist',
      domain: 'system',
      target: 'system/app.treeport.daemon.501'
    })
  })

  it('restarts the direct daemon process without killing tmux on systemd', () => {
    const definition = createSystemdDefinition({
      runnerPath: '/home/tree%port/.local/share/treeport/service/run',
      environment: {
        HOME: '/home/tree port',
        PATH: '/home/tree port/bin:/usr/bin'
      }
    })

    expect(definition).toMatchObject({
      restart: 'always',
      killMode: 'process',
      wantedBy: 'default.target'
    })
    const unit = serializeSystemdDefinition(definition)
    expect(unit).toContain('Restart=always')
    expect(unit).toContain('KillMode=process')
    expect(unit).toContain(
      'ExecStart="/home/tree%%port/.local/share/treeport/service/run"'
    )
    expect(unit).toContain('WantedBy=default.target')
  })

  it('runs the generated administrator command without Node in PATH', async () => {
    const temporaryDirectory = await fs.mkdtemp(
      path.join(os.tmpdir(), 'treeport-service-command-')
    )
    onTestFinished(() =>
      fs.rm(temporaryDirectory, { recursive: true, force: true })
    )

    const installationDirectory = path.join(
      temporaryDirectory,
      "owner's installation with spaces"
    )
    const restrictedBinDirectory = path.join(
      temporaryDirectory,
      'restricted-bin'
    )
    const runtimeExecutable = path.join(installationDirectory, 'node runtime')
    const runtimeEntrypoint = path.join(
      installationDirectory,
      "treeport's cli.mjs"
    )
    const requestPath = path.join(
      installationDirectory,
      "request's folder",
      'apply request.json'
    )
    await Promise.all([
      fs.mkdir(installationDirectory, { recursive: true }),
      fs.mkdir(restrictedBinDirectory, { recursive: true })
    ])
    await Promise.all([
      fs.symlink(process.execPath, runtimeExecutable),
      fs.writeFile(
        runtimeEntrypoint,
        "import fs from 'node:fs'; fs.writeFileSync(process.env.TREEPORT_TEST_OUTPUT, JSON.stringify(process.argv.slice(2)))\n"
      ),
      fs.writeFile(
        path.join(restrictedBinDirectory, 'sudo'),
        '#!/bin/sh\nexec "$@"\n',
        { mode: 0o755 }
      )
    ])

    const outputPath = path.join(temporaryDirectory, 'arguments.json')
    await execute(
      '/bin/sh',
      [
        '-c',
        createAdministratorCommand({
          runtimeExecutable,
          runtimeEntrypoint,
          requestPath
        })
      ],
      {
        env: {
          PATH: restrictedBinDirectory,
          TREEPORT_TEST_OUTPUT: outputPath
        }
      }
    )

    expect(JSON.parse(await fs.readFile(outputPath, 'utf8'))).toEqual([
      'service',
      'apply',
      '--request',
      requestPath
    ])
  })

  it('captures only the supported service environment', () => {
    const environment = createServiceEnvironment({
      user: {
        uid: 501,
        gid: 20,
        username: 'treeport',
        homedir: '/Users/treeport',
        shell: '/bin/zsh'
      },
      paths: {
        dataDir: '/data/treeport',
        runtimeDir: '/run/treeport',
        preferencesPath: '/data/treeport/config.json',
        statePath: '/run/treeport/daemon.json',
        lockPath: '/data/treeport/daemon.lock',
        logPath: '/data/treeport/logs/daemon.log'
      },
      apiUrl: 'http://127.0.0.1:8733',
      recordPath: '/data/treeport/service/service.json',
      installationMethod: 'npm',
      env: {
        PATH: '/opt/node/bin:/usr/bin',
        LANG: 'en_US.UTF-8',
        TREEPORT_TMUX_PATH: '/opt/tmux',
        TREEPORT_PROJECT_ID: 'project-secret-context',
        TREEPORT_API_URL: 'https://remote.example.test',
        SSH_AUTH_SOCK: '/tmp/agent.sock',
        TERM: 'xterm-256color',
        NPM_TOKEN: 'secret'
      }
    })

    expect(environment).toMatchObject({
      HOME: '/Users/treeport',
      USER: 'treeport',
      PATH: '/opt/node/bin:/usr/bin',
      LANG: 'en_US.UTF-8',
      TREEPORT_TMUX_PATH: '/opt/tmux',
      TREEPORT_API_URL: 'http://127.0.0.1:8733',
      TREEPORT_DAEMON_LIFECYCLE: 'service'
    })
    expect(environment).not.toHaveProperty('SSH_AUTH_SOCK')
    expect(environment).not.toHaveProperty('TERM')
    expect(environment).not.toHaveProperty('TREEPORT_PROJECT_ID')
    expect(environment).not.toHaveProperty('NPM_TOKEN')
  })
})
