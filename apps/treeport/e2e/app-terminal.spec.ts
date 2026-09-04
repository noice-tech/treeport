import { expect, test } from '@playwright/test'
import { mockApp } from './support/mock-app'
import {
  requestTerminalControl,
  waitForTerminalControl
} from './support/interactions'

test.describe('desktop worktree and terminal workflows', () => {
  test('creates worktrees with focus, rollback, retry, and preset snapshots', async ({
    page
  }) => {
    const mocked = await mockApp(page, [], {
      treeContextFields: [
        { id: 'issue', label: 'Issue', input: 'text' },
        { id: 'brief', label: 'Task description', input: 'textarea' }
      ]
    })
    {
      const trigger = page.getByRole('button', { name: 'New tree' })
      await trigger.click()
      const dialog = page.getByRole('dialog', { name: 'Create tree' })
      await expect(dialog).toBeVisible()
      await expect(dialog.getByLabel('Tree name')).toBeFocused()
      await dialog.getByLabel('Tree name').fill('focus-test')
      const submit = dialog.getByRole('button', { name: 'Create tree' })
      await expect(submit).toBeEnabled()
      await submit.focus()
      await submit.press('Tab')
      await expect(dialog.getByRole('button', { name: 'Close' })).toBeFocused()
      await page.keyboard.press('Escape')
      await expect(dialog).toHaveCount(0)
      await expect(trigger).toBeFocused()
    }
    {
      const releaseCreate = mocked.delayNextCreate()
      mocked.failNextCreate()
      await page.getByRole('button', { name: 'New tree' }).click()
      await page.getByLabel('Tree name').fill('will fail')
      await page.getByRole('button', { name: 'Create tree' }).click()
      await expect(
        page.getByRole('heading', { name: 'Create tree' })
      ).toHaveCount(0)
      const pending = page.getByRole('status', {
        name: 'Creating tree will-fail'
      })
      await expect(pending).toHaveText('will-fail')

      releaseCreate()
      await expect(pending).toHaveCount(0)
      await expect(page.getByText('create failed')).toBeVisible()
    }
    {
      const releaseCreate = mocked.delayNextCreate()
      const selectedTerminal = page.getByRole('main', { name: /terminal$/ })
      const selectedWorkspaceUrl = page.url()
      await expect(selectedTerminal).toBeVisible()
      await page.getByRole('button', { name: 'New tree' }).click()
      await page.getByLabel('Tree name').fill('New Tópic / Preview!')
      await page.getByLabel('Issue').fill('TREE-123')
      await page
        .getByLabel('Task description')
        .fill('Review the cache behavior.\nKeep the terminal workflow.')
      const requestPromise = page.waitForRequest(
        (request) =>
          request.method() === 'POST' &&
          new URL(request.url()).pathname ===
            '/api/projects/proj_1/worktree-operations'
      )
      await page.getByRole('button', { name: 'Create tree' }).click()
      const request = await requestPromise
      expect(request.postDataJSON()).toEqual({
        name: 'New Tópic / Preview!',
        base: 'default',
        context: {
          issue: 'TREE-123',
          brief: 'Review the cache behavior.\nKeep the terminal workflow.'
        },
        initialTerminal: {
          name: 'Shell',
          initialSize: {
            cols: expect.any(Number),
            rows: expect.any(Number)
          }
        }
      })
      await expect(
        page.getByRole('heading', { name: 'Create tree' })
      ).toHaveCount(0)
      const pending = page.getByRole('status', {
        name: 'Creating tree new-topic-preview'
      })
      await expect(pending).toHaveText('new-topic-preview')
      await expect(pending).toBeFocused()
      const projectRequestsBeforeEvent = mocked.projectRequests()
      await page.evaluate(() => window.__eventSource.emit('worktree.created'))
      await expect
        .poll(() => mocked.projectRequests())
        .toBeGreaterThan(projectRequestsBeforeEvent)

      const projectRequestsBeforeCompletion = mocked.projectRequests()
      const releaseCompletedProjects = mocked.delayNextProjects()
      releaseCreate()
      await expect
        .poll(() => mocked.projectRequests())
        .toBeGreaterThan(projectRequestsBeforeCompletion)
      await expect(pending).toBeVisible()
      releaseCompletedProjects()
      await expect(
        page.getByRole('button', { name: 'new-topic-preview', exact: true })
      ).toHaveCount(1)
      expect(await pending.count()).toBe(0)
      await expect(
        page.getByRole('button', {
          name: /^(main tree|topic|new-topic-preview)$/
        })
      ).toHaveText(['main tree', 'topic', 'new-topic-preview'])
      await expect(page).toHaveURL(selectedWorkspaceUrl)
      await expect(selectedTerminal).toBeVisible()
    }
    {
      await page.getByRole('button', { name: 'New tree' }).click()
      await page.getByLabel('Initial terminal').selectOption('preset_hunk')
      await expect
        .poll(() =>
          page.evaluate(() =>
            localStorage.getItem('treeport-initial-terminal-preset')
          )
        )
        .toBe('preset_hunk')
      await page.keyboard.press('Escape')
      await page.reload()
      await page.getByRole('button', { name: 'New tree' }).click()
      await expect(page.getByLabel('Initial terminal')).toHaveValue(
        'preset_hunk'
      )
      await page.getByLabel('Tree name').fill('preset topic')
      const requestPromise = page.waitForRequest(
        (request) =>
          request.method() === 'POST' &&
          new URL(request.url()).pathname ===
            '/api/projects/proj_1/worktree-operations'
      )
      await page.getByRole('button', { name: 'Create tree' }).click()
      expect((await requestPromise).postDataJSON()).toEqual({
        name: 'preset topic',
        base: 'default',
        initialTerminal: expect.objectContaining({
          name: 'Hunk',
          initialTitle: 'Hunk',
          returnToShell: true,
          initialSize: {
            cols: expect.any(Number),
            rows: expect.any(Number)
          }
        })
      })
      await page.getByRole('button', { name: 'New tree' }).click()
      await expect(page.getByLabel('Initial terminal')).toHaveValue(
        'preset_hunk'
      )
      await page.getByLabel('Initial terminal').selectOption('shell')
      await page.keyboard.press('Escape')
      await page.getByRole('button', { name: 'New tree' }).click()
      await expect(page.getByLabel('Initial terminal')).toHaveValue('shell')
    }
  })

  test('restores an in-progress worktree creation after reload without taking over navigation', async ({
    page
  }) => {
    const mocked = await mockApp(page)
    const releaseCreate = mocked.delayNextCreate()
    await page.getByRole('button', { name: 'New tree' }).click()
    await page.getByLabel('Tree name').fill('reload topic')
    await page.getByRole('button', { name: 'Create tree' }).click()
    await expect(
      page.getByRole('status', { name: 'Creating tree reload-topic' })
    ).toBeVisible()

    await page.reload()
    await expect(
      page.getByRole('status', { name: 'Creating tree reload-topic' })
    ).toBeVisible()
    const activeTerminal = page.getByRole('main', { name: /terminal$/ })
    await expect(activeTerminal).toBeVisible()
    releaseCreate()
    await expect(
      page.getByRole('status', { name: 'Creating tree reload-topic' })
    ).toHaveCount(0)
    await expect(
      page.getByRole('button', { name: 'reload-topic', exact: true })
    ).toBeVisible()
    await expect(activeTerminal).toBeVisible()
  })

  test('shows pending control and does not replay the triggering key', async ({
    page
  }) => {
    await mockApp(page)
    await page.getByRole('button', { name: 'Pi, running', exact: true }).click()
    await expect(page.locator('.xterm-helper-textarea')).toBeFocused()
    await expect(page.getByText('Viewing', { exact: true })).toBeVisible()
    await page.evaluate(() => {
      window.__wsSent = []
      window.__delayTakeControl = true
      document.querySelector('.xterm-helper-textarea')!.dispatchEvent(
        new KeyboardEvent('keydown', {
          bubbles: true,
          key: 'f',
          metaKey: true
        })
      )
    })
    await page.waitForTimeout(50)
    await expect(page.getByText('Viewing', { exact: true })).toBeVisible()
    expect(
      await page.evaluate(() =>
        window.__wsSent.some((message: any) => message.type === 'take_control')
      )
    ).toBe(false)

    await page.keyboard.press('x')
    await expect(
      page.getByText('Taking control…', { exact: true })
    ).toBeVisible()
    expect(
      await page.evaluate(() =>
        window.__wsSent.some(
          (message: any) => message.type === 'input' && message.data === 'x'
        )
      )
    ).toBe(false)

    await page.evaluate(() => window.__releaseTakeControl())
    await waitForTerminalControl(page)
    expect(
      await page.evaluate(() =>
        window.__wsSent.some(
          (message: any) => message.type === 'input' && message.data === 'x'
        )
      )
    ).toBe(false)

    await page.keyboard.press('y')
    await expect
      .poll(() =>
        page.evaluate(() =>
          window.__wsSent.some(
            (message: any) => message.type === 'input' && message.data === 'y'
          )
        )
      )
      .toBe(true)

    const socketsBeforeReconnect = await page.evaluate(
      () => window.__wsInstances.length
    )
    await page.evaluate(() => window.__lastWs.onclose())
    await expect
      .poll(() => page.evaluate(() => window.__wsInstances.length))
      .toBeGreaterThan(socketsBeforeReconnect)
  })

  test('broadcasts canonical dimensions and controller takeover across two viewers', async ({
    context,
    page
  }) => {
    const viewer = await context.newPage()
    await mockApp(page)
    await mockApp(viewer)
    await page.getByRole('button', { name: 'Pi, running', exact: true }).click()
    await viewer
      .getByRole('button', { name: 'Pi, running', exact: true })
      .click()

    await requestTerminalControl(page)
    await expect(page.getByText('Viewing', { exact: true })).toHaveCount(0)
    await expect(viewer.getByText('Viewing', { exact: true })).toBeVisible()
    await page.waitForTimeout(250)
    const beforeControllerResize = await page.evaluate(() =>
      JSON.parse(
        localStorage.getItem('__treeport_terminal_state__:term_pi') || '{}'
      )
    )
    await page.setViewportSize({ width: 1_100, height: 720 })
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            JSON.parse(
              localStorage.getItem('__treeport_terminal_state__:term_pi') ||
                '{}'
            ).revision
        )
      )
      .toBeGreaterThan(beforeControllerResize.revision)
    const afterControllerResize = await page.evaluate(() =>
      JSON.parse(
        localStorage.getItem('__treeport_terminal_state__:term_pi') || '{}'
      )
    )
    const viewerSocketState = await viewer.evaluate(() => {
      const socket = window.__lastWs
      return {
        cols: socket.cols,
        rows: socket.rows,
        revision: socket.revision
      }
    })
    expect(viewerSocketState).toEqual({
      cols: afterControllerResize.cols,
      rows: afterControllerResize.rows,
      revision: afterControllerResize.revision
    })

    await viewer.setViewportSize({ width: 760, height: 640 })
    await viewer.waitForTimeout(250)
    const afterViewerResize = await page.evaluate(() =>
      JSON.parse(
        localStorage.getItem('__treeport_terminal_state__:term_pi') || '{}'
      )
    )
    expect(afterViewerResize).toEqual(afterControllerResize)

    await requestTerminalControl(viewer)
    await expect(viewer.getByText('Viewing', { exact: true })).toHaveCount(0)
    await expect(page.getByText('Viewing', { exact: true })).toBeVisible()
    const takeoverState = await viewer.evaluate(() => {
      const socket = window.__lastWs
      return {
        state: JSON.parse(
          localStorage.getItem('__treeport_terminal_state__:term_pi') || '{}'
        ),
        clientId: socket.clientId
      }
    })
    expect(takeoverState.state.controllerClientId).toBe(takeoverState.clientId)
    expect(takeoverState.state.generation).toBeGreaterThan(
      afterViewerResize.generation
    )

    await viewer.setViewportSize({ width: 980, height: 700 })
    await expect
      .poll(() =>
        viewer.evaluate(
          () =>
            JSON.parse(
              localStorage.getItem('__treeport_terminal_state__:term_pi') ||
                '{}'
            ).revision
        )
      )
      .toBeGreaterThan(takeoverState.state.revision)
    const finalState = await viewer.evaluate(() =>
      JSON.parse(
        localStorage.getItem('__treeport_terminal_state__:term_pi') || '{}'
      )
    )
    for (const target of [page, viewer]) {
      const expectedGrid = {
        cols: finalState.cols,
        rows: finalState.rows,
        revision: finalState.revision
      }
      await expect
        .poll(() =>
          target.evaluate(() => {
            const socket = window.__lastWs
            return {
              cols: socket.cols,
              rows: socket.rows,
              revision: socket.revision
            }
          })
        )
        .toEqual(expectedGrid)
    }
  })

  test('does not automatically retry a fatal terminal error', async ({
    page
  }) => {
    await mockApp(page)
    await page.getByRole('button', { name: 'Pi, running', exact: true }).click()
    await expect(page.getByText('Viewing', { exact: true })).toBeVisible()
    await page.evaluate(async () => {
      const socket = window.__lastWs
      socket.onmessage?.({
        data: JSON.stringify({
          version: 1,
          type: 'error',
          code: 'ATTACH_FAILED',
          message: 'Terminal unavailable',
          retryable: false
        })
      })
      await new Promise((resolve) => setTimeout(resolve))
      socket.close()
    })
    await expect(page.getByRole('button', { name: 'Retry' })).toBeVisible()
    const before = await page.evaluate(() => window.__wsInstances.length)
    await page.evaluate(() => window.dispatchEvent(new Event('online')))
    await page.waitForTimeout(750)
    expect(await page.evaluate(() => window.__wsInstances.length)).toBe(before)
    await page.getByRole('button', { name: 'Retry' }).click()
    await expect
      .poll(() => page.evaluate(() => window.__wsInstances.length))
      .toBeGreaterThan(before)
  })

  test('shows, coalesces, and acknowledges terminal notifications', async ({
    page
  }) => {
    const bellMetadata = {
      terminalId: 'term_pi',
      title: 'zsh · /worktrees/topic',
      progress: null,
      progressStartedAt: null,
      progressClearedAt: null,
      bell: {
        sequence: 4,
        at: '2026-01-01T00:02:00.000Z',
        unread: true
      }
    } satisfies TerminalRuntimeMetadata
    await mockApp(page, [bellMetadata], { desktopBridge: true })
    await expect(page.getByRole('button', { name: 'Dismiss' })).toHaveCount(0)

    const piTreeRow = page.getByRole('button', {
      name: /zsh · \/worktrees\/topic.*bell/
    })
    const notificationTrigger = page.getByRole('button', {
      name: 'Notifications, 1 unread'
    })
    await expect(piTreeRow).toBeVisible()
    await expect(notificationTrigger).toBeVisible()
    await expect
      .poll(() => page.evaluate(() => window.__attentionRequests))
      .toBe(0)
    await page.reload()
    await expect(piTreeRow).toBeVisible()

    await notificationTrigger.click()
    const notificationCenter = page.getByRole('dialog', {
      name: 'Notifications'
    })
    await expect(
      notificationCenter.getByText('zsh · /worktrees/topic')
    ).toBeVisible()
    await expect(notificationCenter.getByText('example · topic')).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(notificationCenter).toHaveCount(0)
    await expect(piTreeRow).toBeVisible()

    await notificationTrigger.click()
    await page.evaluate(() => {
      window.__wsSent = []
    })
    const terminalScreen = page.locator('.xterm-screen')
    const terminalBounds = await terminalScreen.boundingBox()
    expect(terminalBounds).not.toBeNull()
    const terminalPointerY = terminalBounds!.y + terminalBounds!.height / 2
    await page.mouse.move(
      terminalBounds!.x + terminalBounds!.width / 2 - 64,
      terminalPointerY
    )
    await page.mouse.down()
    await page.mouse.move(
      terminalBounds!.x + terminalBounds!.width / 2 + 64,
      terminalPointerY
    )
    await page.mouse.up()
    await expect(notificationCenter).toHaveCount(0)
    expect(
      await page.evaluate(() =>
        window.__wsSent.filter(
          (message: any) =>
            message.type === 'input' || message.type === 'take_control'
        )
      )
    ).toEqual([])

    const previousWorkspaceUrl = page.url()
    await expect(
      page.getByRole('main', { name: 'zsh · /worktrees/topic terminal' })
    ).toBeVisible()
    await notificationTrigger.click()
    const acknowledgement = page.waitForRequest(
      (request) =>
        request.method() === 'POST' &&
        new URL(request.url()).pathname ===
          '/api/terminals/term_pi/bell/acknowledge'
    )
    await notificationCenter
      .getByRole('button', { name: 'Open zsh · /worktrees/topic' })
      .click()
    await expect(notificationCenter).toHaveCount(0)
    const request = await acknowledgement
    expect(request.postDataJSON()).toEqual({ sequence: 4 })
    await expect(page).toHaveURL(
      /\/projects\/proj_1\/worktrees\/wt_topic\/terminals\/term_pi$/
    )
    const notificationTerminal = page.getByRole('main', {
      name: 'zsh · /worktrees/topic terminal'
    })
    await expect(notificationTerminal).toBeVisible()
    await expect(page.locator('.xterm-helper-textarea')).toBeFocused()

    await page.goBack()
    await expect(page).toHaveURL(previousWorkspaceUrl)
    await expect(
      page.getByRole('main', { name: 'zsh · /worktrees/topic terminal' })
    ).toBeVisible()
    await expect(page.locator('.xterm-helper-textarea')).toBeFocused()

    await page.goForward()
    await expect(page).toHaveURL(
      /\/projects\/proj_1\/worktrees\/wt_topic\/terminals\/term_pi$/
    )
    await expect(notificationTerminal).toBeVisible()
    await expect(page.locator('.xterm-helper-textarea')).toBeFocused()
    await expect(piTreeRow).toBeVisible()

    await page.evaluate(() =>
      window.__eventSource.emit(
        'terminal.metadata',
        JSON.stringify({
          data: {
            terminalId: 'term_pi',
            title: 'zsh · /worktrees/topic',
            progress: null,
            progressStartedAt: null,
            progressClearedAt: null,
            bell: {
              sequence: 4,
              at: '2026-01-01T00:02:00.000Z',
              unread: false
            }
          }
        })
      )
    )
    await expect(
      page.getByRole('button', { name: /zsh · \/worktrees\/topic.*bell/ })
    ).toHaveCount(0)
    await page.evaluate(() => {
      const socket = window.__wsInstances.find((item: any) =>
        item.url.includes('term_pi')
      )
      socket.onmessage?.({
        data: JSON.stringify({
          version: 1,
          type: 'output',
          streamId: socket.streamId,
          sequence: 2,
          data: '\u0007'
        })
      })
    })

    await expect(
      page.getByRole('button', { name: /zsh · \/worktrees\/topic.*bell/ })
    ).toHaveCount(0)
    await page.getByRole('button', { name: 'main tree', exact: true }).click()
    await expect(page.locator('.xterm-helper-textarea')).toBeFocused()

    const emitBell = (sequence: number, unread = true) =>
      page.evaluate(
        ({ nextSequence, nextUnread }) => {
          window.__eventSource.emit(
            'terminal.metadata',
            JSON.stringify({
              data: {
                terminalId: 'term_pi',
                title: 'Pi build · /worktrees/topic',
                hasForegroundProcess: true,
                progress: { state: 'normal', value: 61 },
                progressStartedAt: '2026-01-01T00:00:00.000Z',
                progressClearedAt: null,
                bell: {
                  sequence: nextSequence,
                  at: `2026-01-01T00:0${nextSequence}:00.000Z`,
                  unread: nextUnread
                }
              }
            })
          )
        },
        { nextSequence: sequence, nextUnread: unread }
      )

    await emitBell(5)
    await expect(
      page.getByRole('button', { name: 'Notifications, 1 unread' })
    ).toBeVisible()
    await expect(page.getByRole('button', { name: 'Dismiss' })).toHaveCount(0)
    await expect(
      page.getByRole('button', {
        name: /Pi build · \/worktrees\/topic.*61% complete.*bell/
      })
    ).toBeVisible()
    await expect
      .poll(() => page.evaluate(() => window.__attentionRequests))
      .toBe(1)

    await emitBell(5, false)
    await expect(
      page.getByRole('button', {
        name: 'Notifications, no unread notifications'
      })
    ).toBeVisible()

    await emitBell(6)
    const updatedTrigger = page.getByRole('button', {
      name: 'Notifications, 1 unread'
    })
    await updatedTrigger.click()
    const updatedCenter = page.getByRole('dialog', { name: 'Notifications' })
    await expect(
      updatedCenter.getByText('Pi build · /worktrees/topic')
    ).toBeVisible()
    const liveAcknowledgement = page.waitForRequest(
      (request) =>
        request.method() === 'POST' &&
        new URL(request.url()).pathname ===
          '/api/terminals/term_pi/bell/acknowledge'
    )
    await updatedCenter
      .getByRole('button', { name: 'Open Pi build · /worktrees/topic' })
      .click()
    expect((await liveAcknowledgement).postDataJSON()).toEqual({ sequence: 6 })
    await expect(
      page.getByRole('main', {
        name: 'Pi build · /worktrees/topic terminal'
      })
    ).toBeVisible()
    await page.getByRole('button', { name: 'main tree', exact: true }).click()
    const activeBellTerminal = page.getByRole('main', {
      name: 'zsh · /worktrees/topic terminal'
    })
    await expect(activeBellTerminal).toBeVisible()

    await page.evaluate(() =>
      window.__eventSource.emit(
        'terminal.metadata',
        JSON.stringify({
          data: {
            terminalId: 'term_pi',
            title: 'Pi',
            progress: null,
            progressStartedAt: null,
            progressClearedAt: null,
            bell: {
              sequence: 7,
              at: '2026-01-01T00:07:00.000Z',
              unread: true
            }
          }
        })
      )
    )

    const activeNotificationTrigger = page.getByRole('button', {
      name: 'Notifications, 1 unread'
    })
    await expect(activeNotificationTrigger).toBeVisible()
    await expect(activeBellTerminal).toBeVisible()
    await activeNotificationTrigger.click()
    const dismissAcknowledgement = page.waitForRequest(
      (request) =>
        request.method() === 'POST' &&
        new URL(request.url()).pathname ===
          '/api/terminals/term_pi/bell/acknowledge'
    )
    await page
      .getByLabel('Notifications')
      .getByRole('button', { name: 'Open Pi' })
      .click()
    expect((await dismissAcknowledgement).postDataJSON()).toEqual({
      sequence: 7
    })
    await expect(page.getByRole('main', { name: 'Pi terminal' })).toBeVisible()
  })

  test('manages global terminal presets without a selected worktree', async ({
    page
  }) => {
    await mockApp(page, [], { worktreeFree: true })
    const trigger = page
      .getByRole('navigation', { name: 'Projects and trees' })
      .getByRole('button', { name: 'New panel', exact: true })
    await expect(trigger).toBeEnabled()
    await trigger.click()
    const launcher = page.getByRole('dialog', { name: 'New panel' })
    await expect(launcher.getByRole('button', { name: 'Shell' })).toBeDisabled()
    await expect(
      launcher.getByRole('link', { name: 'Configure repository presets' })
    ).toHaveAttribute(
      'href',
      'https://treeport.app/features/terminal-presets/#repository-presets'
    )
    await launcher
      .getByRole('button', { name: 'Manage global presets' })
      .click()
    const dialog = page.getByRole('dialog', {
      name: 'Global terminal presets'
    })
    await expect(dialog).toBeVisible()
    await expect(dialog.getByRole('button', { name: 'New' })).toBeVisible()
    await expect(
      dialog.getByRole('button', { name: 'Delete Shell' })
    ).toHaveCount(0)

    await dialog.getByLabel('Name').fill('Review tool')
    await dialog.getByLabel('Command').fill('npx "semi;$HOME" --yes')
    const createRequest = page.waitForRequest(
      (request) =>
        request.method() === 'POST' &&
        new URL(request.url()).pathname === '/api/terminal-presets'
    )
    await dialog.getByRole('button', { name: 'Create preset' }).click()
    expect((await createRequest).postDataJSON()).toEqual({
      name: 'Review tool',
      executable: 'npx',
      args: ['semi;$HOME', '--yes'],
      closeOnSuccess: false
    })
    const presetRow = dialog.getByRole('button', { name: /^Review tool/ })
    await expect(presetRow).toBeVisible()
    await presetRow.click()

    await dialog.getByLabel('Name').fill('Review updated')
    await dialog.getByLabel('Command').fill('npx "semi;$HOME"')
    await dialog.getByLabel('Close on success').click()
    const updateRequest = page.waitForRequest(
      (request) =>
        request.method() === 'PATCH' &&
        new URL(request.url()).pathname === '/api/terminal-presets/preset_2'
    )
    await dialog.getByRole('button', { name: 'Save changes' }).click()
    expect((await updateRequest).postDataJSON()).toEqual({
      name: 'Review updated',
      executable: 'npx',
      args: ['semi;$HOME'],
      closeOnSuccess: true,
      expectedUpdatedAt: '2026-01-02T00:00:00.000Z'
    })

    page.once('dialog', (confirmation) => confirmation.accept())
    const deleteRequest = page.waitForRequest(
      (request) =>
        request.method() === 'DELETE' &&
        new URL(request.url()).pathname === '/api/terminal-presets/preset_2'
    )
    await dialog.getByRole('button', { name: 'Delete Review updated' }).click()
    expect((await deleteRequest).postDataJSON()).toEqual({
      expectedUpdatedAt: '2026-01-03T00:00:00.000Z'
    })
    await expect(
      dialog.getByRole('button', { name: /^Review updated/ })
    ).toHaveCount(0)
    await dialog.getByRole('button', { name: 'Close', exact: true }).click()
    await expect(trigger).toBeFocused()
  })
  test('installs, opens, navigates, and closes daemon-hosted Browser', async ({
    page
  }) => {
    const mocked = await mockApp(page, [], {
      hostedBrowser: true,
      browserInstallRequired: true,
      browserBeforeUnload: true
    })
    await page.getByRole('button', { name: /^topic(?:,|\s|$)/ }).click()

    const terminal = page.getByRole('main', { name: /terminal$/ })
    await expect(terminal).toBeVisible()
    await page.getByRole('button', { name: 'Toggle side panel' }).click()
    const tools = page.getByRole('region', {
      name: 'topic tool tab group'
    })
    await expect(tools.getByText('Open a tool', { exact: true })).toBeVisible()
    await expect(
      tools.getByRole('button', { name: 'Browser, new tab' })
    ).toBeVisible()
    await expect(
      tools.getByRole('button', { name: 'Review, web panel, Project' })
    ).toBeVisible()

    await page.getByRole('button', { name: 'main tree', exact: true }).click()
    await expect(
      page.getByRole('region', { name: 'main tree tool tab group' })
    ).not.toBeVisible()
    await page.getByRole('button', { name: /^topic(?:,|\s|$)/ }).click()
    await expect(tools).toBeVisible()
    await page.reload()
    await expect(tools).toBeVisible()

    const createRequest = page.waitForRequest(
      (request) =>
        request.method() === 'POST' &&
        new URL(request.url()).pathname ===
          '/api/worktrees/wt_topic/browser-panels'
    )
    await tools.getByRole('button', { name: 'Browser, new tab' }).click()
    expect((await createRequest).postDataJSON()).toEqual({})

    await expect(page).toHaveURL(/\/panels\/browser_panel_1$/)
    await expect(
      tools.getByRole('tab', { name: 'Browser', exact: true })
    ).toBeVisible()
    const address = page.getByRole('textbox', { name: 'Application URL' })
    await expect(address).toHaveValue('')
    await expect(address).toBeFocused()
    await expect(terminal).toBeVisible()
    const topicTerminalList = page.getByRole('list', {
      name: 'topic terminal tabs'
    })
    await expect(
      topicTerminalList.getByText('Browser', { exact: true })
    ).toHaveCount(0)

    await tools.getByRole('button', { name: 'Open another tool' }).click()
    const toolPicker = page.getByLabel('Open a tool')
    await expect(toolPicker.getByLabel('Available tools')).toBeFocused()
    const openWebPanelRequest = page.waitForRequest(
      (request) =>
        request.method() === 'POST' &&
        new URL(request.url()).pathname ===
          '/api/worktrees/wt_topic/panels/open'
    )
    await page.keyboard.press('ArrowDown')
    await page.keyboard.press('Enter')
    await openWebPanelRequest
    await expect(
      tools.getByRole('tab', { name: 'Review, web panel' })
    ).toBeVisible()
    await expect(terminal).toBeVisible()
    await expect(
      topicTerminalList.getByText('Review', { exact: true })
    ).toHaveCount(0)
    await tools.getByRole('tab', { name: 'Browser', exact: true }).click()

    const browserUnavailable = page.getByRole('alert')
    await expect(browserUnavailable).toContainText(
      'Chromium is not installed on this daemon.'
    )
    const releaseBrowserInstall = mocked.delayNextBrowserInstall()
    const installRequest = page.waitForRequest(
      (request) =>
        request.method() === 'POST' &&
        new URL(request.url()).pathname === '/api/browser/install'
    )
    await browserUnavailable
      .getByRole('button', { name: 'Install Chromium' })
      .click()
    await installRequest
    await expect(
      browserUnavailable.getByRole('button', {
        name: 'Installing Chromium…'
      })
    ).toBeDisabled()
    expect(mocked.browserInstallRequests()).toBe(1)
    releaseBrowserInstall()
    await expect(browserUnavailable).toHaveCount(0)
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            window.__wsInstances.filter(
              (socket) => socket.namespace === '/browsers'
            ).length
        )
      )
      .toBeGreaterThan(1)
    await page.evaluate(() => window.__setBrowserLoading(true))
    await expect(
      tools.getByRole('tab', { name: 'Browser, loading', exact: true })
    ).toBeVisible()
    await expect(
      page.getByRole('button', { name: 'Stop loading' })
    ).toBeVisible()
    await expect(page.getByText('Loading application…')).toHaveCount(0)
    await page.evaluate(() => window.__setBrowserLoading(false))
    await expect(
      tools.getByRole('tab', { name: 'Browser', exact: true })
    ).toBeVisible()
    const viewport = page.getByLabel(/^Browser viewport/)

    await tools.getByRole('button', { name: 'Open another tool' }).click()
    await expect(toolPicker).toBeVisible()
    const viewportBounds = await viewport.boundingBox()

    if (!viewportBounds) {
      throw new Error('The Browser viewport is not visible.')
    }

    await page.mouse.click(
      viewportBounds.x + viewportBounds.width / 2,
      viewportBounds.y + viewportBounds.height - 8
    )
    await expect(toolPicker).toHaveCount(0)

    await tools.getByRole('button', { name: 'Open another tool' }).click()
    await expect(toolPicker).toBeVisible()
    await page.locator('.xterm-screen').click({ position: { x: 8, y: 8 } })
    await expect(toolPicker).toHaveCount(0)

    const resizeRail = tools.getByRole('separator', {
      name: 'Resize side panel'
    })
    const resizeRailBounds = await resizeRail.boundingBox()
    if (!resizeRailBounds) {
      throw new Error('The side panel resize control is not visible.')
    }

    const browserWidthBeforeResize = await page.evaluate(
      () =>
        window.__browserCommands
          .filter((message) => message.type === 'resize')
          .at(-1)?.width
    )
    await page.mouse.move(
      resizeRailBounds.x + resizeRailBounds.width / 2,
      resizeRailBounds.y + resizeRailBounds.height / 2
    )
    await page.mouse.down()
    await page.mouse.move(resizeRailBounds.x - 48, resizeRailBounds.y + 20)
    await page.mouse.up()
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            window.__browserCommands
              .filter((message) => message.type === 'resize')
              .at(-1)?.width
        )
      )
      .not.toBe(browserWidthBeforeResize)
    await expect(
      page.getByRole('heading', { name: 'Development servers' })
    ).toHaveCount(0)

    await page.getByRole('button', { name: 'Development servers' }).click()
    await expect(
      page.getByRole('heading', { name: 'Development servers' })
    ).toBeVisible()
    await page
      .getByRole('button', {
        name: 'Open http://localhost:5173/, vite'
      })
      .click()
    await expect
      .poll(() => page.evaluate(() => window.__browserNavigationCompleted))
      .toBe('http://localhost:5173/')
    await expect(
      page.getByRole('heading', { name: 'Development servers' })
    ).toHaveCount(0)
    await expect(address).toHaveValue('http://localhost:5173/')
    await expect(viewport).toBeFocused()
    await expect(
      page.getByRole('button', { name: 'Copy application URL' })
    ).toHaveCount(0)
    await expect(
      page.getByRole('button', { name: 'Reset', exact: true })
    ).toHaveCount(0)

    const invalidAddress = 'http://user:secret@localhost:4173/application'
    await address.fill(invalidAddress)
    await address.press('Enter')
    await expect(page.getByRole('alert')).toHaveText(
      'Enter search terms or an HTTP or HTTPS address without credentials.'
    )
    await expect(address).toHaveValue(invalidAddress)
    await expect(address).toBeFocused()

    await address.fill('treeport browser')
    await address.press('Enter')
    await expect
      .poll(() => page.evaluate(() => window.__browserNavigationCompleted))
      .toBe('https://www.google.com/search?q=treeport+browser')

    await address.fill('localhost:4173/application')
    await page.evaluate(() => window.__repeatBrowserState())
    await expect(address).toHaveValue('localhost:4173/application')
    await address.press('Enter')
    await expect(address).not.toBeFocused()
    await expect(viewport).toBeFocused()
    await expect
      .poll(() => page.evaluate(() => window.__browserNavigationCompleted))
      .toBe('http://localhost:4173/application')
    await expect(address).toHaveValue('http://localhost:4173/application')

    await address.click()
    await expect(address).toHaveJSProperty('selectionStart', 0)
    await expect(address).toHaveJSProperty(
      'selectionEnd',
      'http://localhost:4173/application'.length
    )
    await address.click({ position: { x: 100, y: 10 } })
    await expect
      .poll(() =>
        address.evaluate((element) => {
          // SAFETY: The locator resolves the address-bar textbox.
          const input = element as HTMLInputElement
          return input.selectionStart === input.selectionEnd
        })
      )
      .toBe(true)

    const unsentDraft = 'localhost:4173/unsent'
    await address.fill(unsentDraft)
    await viewport.click()
    await page.evaluate(() => window.__repeatBrowserState())
    await expect(address).toHaveValue(unsentDraft)
    await page.evaluate(() =>
      window.__setBrowserUrl('http://localhost:4173/external')
    )
    await expect(address).toHaveValue('http://localhost:4173/external')

    const locationShortcut = await page.evaluate(() =>
      /Mac|iPhone|iPad|iPod/.test(navigator.platform) ? 'Meta+L' : 'Control+L'
    )
    await page.keyboard.press(locationShortcut)
    await expect(address).toBeFocused()
    await expect(address).toHaveJSProperty('selectionStart', 0)
    await expect(address).toHaveJSProperty(
      'selectionEnd',
      'http://localhost:4173/external'.length
    )

    await address.fill('localhost:4173/changed-draft')
    await address.press('Escape')
    await expect(address).toHaveValue('http://localhost:4173/external')
    await expect(address).toBeFocused()
    await expect(address).toHaveJSProperty('selectionStart', 0)
    await expect(address).toHaveJSProperty(
      'selectionEnd',
      'http://localhost:4173/external'.length
    )
    await address.press('Escape')
    await expect(viewport).toBeFocused()
    await page.keyboard.press(locationShortcut.replace('+L', '+F'))
    const findInput = page.getByRole('textbox', { name: 'Find in page' })
    await expect(findInput).toBeFocused()
    await findInput.fill('external')
    await expect
      .poll(() =>
        page.evaluate(() =>
          window.__browserCommands
            .filter((message) => message.type === 'find')
            .at(-1)
        )
      )
      .toEqual({
        type: 'find',
        text: 'external',
        forward: true,
        findNext: false
      })
    await findInput.press('Enter')
    await expect
      .poll(() =>
        page.evaluate(() =>
          window.__browserCommands
            .filter((message) => message.type === 'find')
            .at(-1)
        )
      )
      .toEqual({
        type: 'find',
        text: 'external',
        forward: true,
        findNext: true
      })
    await findInput.press('Escape')
    await expect(findInput).toHaveCount(0)
    await expect(viewport).toBeFocused()

    await page.keyboard.press('Meta+1')
    await expect(page).toHaveURL(/\/panels\/browser_panel_1$/)
    await page.keyboard.press('Meta+2')
    await expect(page).toHaveURL(/\/panels\/panel_1$/)

    await topicTerminalList
      .getByRole('button', { name: /^zsh · \/worktrees\/topic,/ })
      .click()
    await page.keyboard.press('Meta+2')
    await expect(page).toHaveURL(/\/terminals\/term_pi$/)
    await expect(page.locator('.xterm-helper-textarea')).toBeFocused()
    await tools.getByRole('tab', { name: 'Browser', exact: true }).click()
    await expect(page).toHaveURL(/\/panels\/browser_panel_1$/)
    await expect(address).toBeVisible()
    await expect(address).not.toBeFocused()

    await page.reload()
    await expect(page).toHaveURL(/\/panels\/browser_panel_1$/)
    await expect(
      page.getByRole('tab', { name: 'Browser', exact: true })
    ).toBeVisible()
    const sidePanelShortcut = await page.evaluate(() =>
      /Mac|iPhone|iPad|iPod/.test(navigator.platform)
        ? 'Meta+Alt+B'
        : 'Control+Alt+B'
    )
    await page.keyboard.press(sidePanelShortcut)
    await expect(tools).not.toBeVisible()
    await expect(terminal).toBeVisible()
    await page.keyboard.press(sidePanelShortcut)
    await expect(tools).toBeVisible()

    const initialCloseRequest = page.waitForRequest((request) => {
      const url = new URL(request.url())
      return (
        request.method() === 'DELETE' &&
        url.pathname === '/api/panels/browser_panel_1' &&
        !url.searchParams.has('force')
      )
    })
    await page.getByRole('button', { name: 'Close Browser' }).click()
    await initialCloseRequest
    const closeDialog = page.getByRole('alertdialog', { name: 'Leave site?' })
    await expect(closeDialog).toContainText(
      'Changes you made may not be saved.'
    )
    await closeDialog.getByRole('button', { name: 'Cancel' }).click()
    await expect(
      page.getByRole('tab', { name: 'Browser', exact: true })
    ).toBeVisible()

    await page.getByRole('button', { name: 'Close Browser' }).click()
    const forcedCloseRequest = page.waitForRequest((request) => {
      const url = new URL(request.url())
      return (
        request.method() === 'DELETE' &&
        url.pathname === '/api/panels/browser_panel_1' &&
        url.searchParams.get('force') === 'true'
      )
    })
    await closeDialog.getByRole('button', { name: 'Leave' }).click()
    await forcedCloseRequest
    await expect(
      page.getByRole('tab', { name: 'Browser', exact: true })
    ).toHaveCount(0)
    await expect(
      page.getByRole('tab', { name: 'Review, web panel' })
    ).toBeVisible()
    const reviewCloseRequest = page.waitForRequest(
      (request) =>
        request.method() === 'DELETE' &&
        new URL(request.url()).pathname === '/api/panels/panel_1'
    )
    await page.getByRole('button', { name: 'Close Review' }).click()
    await reviewCloseRequest
    await expect(
      page
        .getByRole('region', { name: 'topic tool tab group' })
        .getByText('Open a tool')
    ).toBeVisible()
  })

  test('launches repository presets and keeps global choices available while repository configuration refreshes', async ({
    page
  }) => {
    const repositoryPreset = {
      id: 'repository:proj_1:terminal-preset:hunk',
      name: 'Hunk',
      executable: 'repo-tool',
      args: ['argument with spaces', 'semi;$HOME'],
      shellCommand: null,
      cwd: null,
      env: {},
      closeOnSuccess: false,
      source: { type: 'repository' as const, format: 'treeport' as const }
    }
    const zedPreset = {
      id: 'repository:proj_1:zed-task:0',
      name: 'Zed build',
      executable: null,
      args: [],
      shellCommand: 'bun remotion',
      cwd: '/worktrees/topic/packages/app',
      env: {
        ZED_WORKTREE_ROOT: '/worktrees/topic',
        ZED_MAIN_GIT_WORKTREE: '/repo',
        CUSTOM: 'argument with spaces;$HOME'
      },
      closeOnSuccess: false,
      source: { type: 'repository' as const, format: 'zed' as const }
    }
    const mocked = await mockApp(page, [], {
      repositoryTerminalPresets: [repositoryPreset, zedPreset]
    })

    await page.getByRole('button', { name: /^topic(?:,|\s|$)/ }).click()
    const createRequest = page.waitForRequest(
      (request) =>
        request.method() === 'POST' &&
        new URL(request.url()).pathname === '/api/worktrees/wt_topic/terminals'
    )
    await page.getByRole('button', { name: 'New panel in topic' }).click()
    const launcher = page.getByRole('dialog', { name: 'New panel' })
    await launcher
      .getByRole('button', {
        name: 'Zed build, Repository · Zed, bun remotion'
      })
      .click()
    const requestBody = (await createRequest).postDataJSON()
    expect(requestBody).toMatchObject({
      name: 'Zed build',
      shellCommand: 'bun remotion',
      cwd: '/worktrees/topic/packages/app',
      env: {
        ZED_WORKTREE_ROOT: '/worktrees/topic',
        ZED_MAIN_GIT_WORKTREE: '/repo',
        CUSTOM: 'argument with spaces;$HOME'
      },
      returnToShell: true
    })
    expect(requestBody).not.toHaveProperty('argv')

    mocked.repositoryTerminalPresets.splice(0, 1, {
      ...repositoryPreset,
      id: 'repository:proj_1:terminal-preset:fixed',
      name: 'Fixed repository preset'
    })
    mocked.repositoryTerminalPresets.splice(1, 1)
    mocked.repositoryPresetDiagnostics.push({
      path: '.zed/tasks.json',
      itemId: null,
      message: 'Could not load Zed tasks: invalid JSONC'
    })
    await page.getByRole('button', { name: 'New panel in topic' }).click()
    await expect(
      launcher.getByText('Could not load Zed tasks: invalid JSONC')
    ).toBeVisible({ timeout: 7_000 })
    await expect(
      launcher.getByRole('button', { name: /^Hunk, Global, npx/ })
    ).toBeVisible()
    await expect(
      launcher.getByRole('button', {
        name: /^Fixed repository preset, Repository, repo-tool/
      })
    ).toBeVisible()
  })

  test('launches Shell and configured persistent and one-off presets', async ({
    page
  }) => {
    const mocked = await mockApp(page, [
      {
        terminalId: 'term_dev',
        title: null,
        hasForegroundProcess: false,
        progress: null,
        progressStartedAt: null,
        progressClearedAt: null,
        bell: null
      }
    ])
    await page.getByRole('button', { name: /^topic(?:,|\s|$)/ }).click()
    await expect(page.locator('.xterm-helper-textarea')).toBeFocused()
    await expect(
      page.getByRole('button', { name: 'Terminal', exact: true })
    ).toHaveCount(0)
    const requestPromise = page.waitForRequest(
      (request) =>
        request.method() === 'POST' &&
        new URL(request.url()).pathname === '/api/worktrees/wt_topic/terminals'
    )
    await page.getByRole('button', { name: 'New panel in topic' }).click()
    await page
      .getByRole('dialog', { name: 'New panel' })
      .getByRole('button', { name: 'Shell' })
      .click()
    const request = await requestPromise
    expect(request.postDataJSON()).toEqual({
      name: 'Shell',
      initialSize: {
        cols: expect.any(Number),
        rows: expect.any(Number)
      }
    })
    await expect(page.getByRole('dialog')).toHaveCount(0)

    const topicTerminals = page.getByRole('list', {
      name: 'topic terminal tabs'
    })
    await expect(
      topicTerminals.getByRole('button', {
        name: /^dev · \/worktrees\/topic,/
      })
    ).toBeVisible()
    await expect(page.locator('.xterm-helper-textarea')).toBeFocused()
    const socketsBeforeSwitch = await page.evaluate(
      () => window.__wsInstances.length
    )
    const zshTerminal = topicTerminals.getByRole('button', {
      name: /^zsh · \/worktrees\/topic,/
    })
    await zshTerminal.click()
    await expect(page.locator('.xterm-helper-textarea')).toBeFocused()
    await zshTerminal.click()
    await expect(page.locator('.xterm-helper-textarea')).toBeFocused()
    await expect
      .poll(() => page.evaluate(() => window.__wsInstances.length))
      .toBe(socketsBeforeSwitch)
    await expect(
      topicTerminals.getByRole('button', {
        name: /^dev · \/worktrees\/topic,/
      })
    ).toBeVisible()

    const terminalId = 'term_dev'
    let confirmationShown = false
    page.once('dialog', (dialog) => {
      confirmationShown = true
      void dialog.accept()
    })
    const closeRequest = page.waitForRequest(
      (request) =>
        request.method() === 'DELETE' &&
        new URL(request.url()).pathname === `/api/terminals/${terminalId}`
    )
    await topicTerminals
      .getByRole('button', { name: /^dev · \/worktrees\/topic,/ })
      .click({ button: 'middle' })
    await closeRequest
    expect(confirmationShown).toBe(false)
    await expect(
      topicTerminals.getByRole('button', {
        name: /^dev · \/worktrees\/topic,/
      })
    ).toHaveCount(0)
    const presetRequestPromise = page.waitForRequest(
      (request) =>
        request.method() === 'POST' &&
        new URL(request.url()).pathname === '/api/worktrees/wt_topic/terminals'
    )
    await page.getByRole('button', { name: 'New panel in topic' }).click()
    const presetItem = page
      .getByRole('dialog', { name: 'New panel' })
      .getByRole('button', { name: /^Hunk, Global, npx/ })
    await presetItem.click()
    const presetRequest = await presetRequestPromise
    expect(presetRequest.postDataJSON()).toEqual({
      name: 'Hunk',
      initialTitle: 'Hunk',
      argv: ['npx', '--yes', 'hunkdiff@0.17.3', 'diff', 'HEAD', '--watch'],
      returnToShell: true,
      initialSize: {
        cols: expect.any(Number),
        rows: expect.any(Number)
      }
    })
    await expect(page.locator('.xterm-helper-textarea')).toBeFocused()

    mocked.terminalPresets[0] = {
      ...mocked.terminalPresets[0]!,
      name: 'Open editor',
      executable: 'code',
      args: ['.'],
      closeOnSuccess: true,
      updatedAt: '2026-01-04T00:00:00.000Z'
    }
    await page.reload()
    await page.getByRole('button', { name: 'New tree' }).click()
    await expect(
      page.getByLabel('Initial terminal').getByRole('option', {
        name: 'Open editor'
      })
    ).toHaveCount(0)
    await page
      .getByRole('dialog')
      .getByRole('button', { name: 'Close', exact: true })
      .click()
    await page.getByRole('button', { name: /^topic(?:,|\s|$)/ }).click()
    const oneOffRequestPromise = page.waitForRequest(
      (request) =>
        request.method() === 'POST' &&
        new URL(request.url()).pathname === '/api/worktrees/wt_topic/terminals'
    )
    await page.getByRole('button', { name: 'New panel in topic' }).click()
    await page
      .getByRole('dialog', { name: 'New panel' })
      .getByRole('button', { name: 'Open editor' })
      .click()
    expect((await oneOffRequestPromise).postDataJSON()).toEqual({
      name: 'Open editor',
      initialTitle: 'Open editor',
      argv: ['code', '.'],
      closeOnSuccess: true,
      initialSize: {
        cols: expect.any(Number),
        rows: expect.any(Number)
      }
    })
  })

  test('confirms before closing a terminal with a foreground process', async ({
    page
  }) => {
    await mockApp(page, [
      {
        terminalId: 'term_pi',
        title: null,
        hasForegroundProcess: true,
        progress: null,
        progressStartedAt: null,
        progressClearedAt: null,
        bell: null
      }
    ])
    await page.getByRole('button', { name: /^topic(?:,|\s|$)/ }).click()
    await page.getByRole('button', { name: 'New panel in topic' }).click()
    await page
      .getByRole('dialog', { name: 'New panel' })
      .getByRole('button', { name: 'Shell' })
      .click()
    const topicTerminals = page.getByRole('list', {
      name: 'topic terminal tabs'
    })
    await topicTerminals
      .getByRole('button', { name: /^zsh · \/worktrees\/topic,/ })
      .click()
    const closeButton = topicTerminals.getByRole('button', {
      name: /^Close zsh · \/worktrees\/topic$/
    })
    await expect(closeButton).toBeVisible()

    let confirmationShown = false
    page.once('dialog', async (dialog) => {
      confirmationShown = true
      await dialog.dismiss()
    })
    await closeButton.click()
    expect(confirmationShown).toBe(true)
    await expect(closeButton).toBeVisible()

    page.once('dialog', (dialog) => dialog.accept())
    const closeRequest = page.waitForRequest(
      (request) =>
        request.method() === 'DELETE' &&
        new URL(request.url()).pathname === '/api/terminals/term_pi'
    )
    await closeButton.click()
    await closeRequest
    await expect(closeButton).toHaveCount(0)
    await expect(
      topicTerminals.getByRole('button', { name: /^dev · \/worktrees\/topic,/ })
    ).toBeVisible()
    await expect(page.locator('.xterm-helper-textarea')).toBeFocused()
  })

  test('groups review changes and persists resolved comments', async ({
    page
  }) => {
    const mocked = await mockApp(page, [], { realReviewPanel: true })
    mocked.setWebPanelStorage('panel_1', 'review-comments-v1', [
      {
        id: 'legacy-comment',
        file: 'src/shared.ts',
        side: 'additions',
        lineNumber: 1,
        body: 'Keep the shared behavior explicit.'
      },
      {
        id: 'branch-comment',
        file: 'src/branch.ts',
        side: 'additions',
        lineNumber: 1,
        body: 'Cover the branch-only path.',
        resolved: false
      }
    ])

    await page.getByRole('button', { name: /^topic(?:,|\s|$)/ }).click()
    await page.getByRole('button', { name: 'New panel in topic' }).click()
    const launcher = page.getByRole('dialog', { name: 'New panel' })
    await launcher.getByRole('button', { name: 'Review, web panel' }).click()
    await expect
      .poll(() =>
        page
          .frames()
          .some((frame) =>
            frame.url().includes('/api/web-panels/panel_1/assets/')
          )
      )
      .toBe(true)
    let reviewFrame = page
      .frames()
      .find((frame) => frame.url().includes('/api/web-panels/panel_1/assets/'))!

    await expect(
      reviewFrame.getByRole('treeitem', { name: 'Uncommitted Changes (3)' })
    ).toBeVisible()
    await expect(
      reviewFrame.getByRole('treeitem', { name: 'Staged (1)' })
    ).toBeVisible()
    await expect(
      reviewFrame.getByRole('treeitem', { name: 'Unstaged (2)' })
    ).toBeVisible()
    await expect(
      reviewFrame.getByRole('treeitem', { name: 'Untracked (1)' })
    ).toBeVisible()
    const branchChanges = reviewFrame.getByRole('treeitem', {
      name: 'Branch Changes (2)'
    })
    await expect(branchChanges).toBeVisible()
    await expect(
      reviewFrame.getByRole('treeitem', { name: 'branch.ts', exact: true })
    ).toHaveCount(0)
    await expect(
      reviewFrame.getByRole('treeitem', { name: 'shared.ts', exact: true })
    ).toHaveCount(1)
    await expect(
      reviewFrame.getByRole('button', { name: 'Expand src/branch.ts' })
    ).toBeVisible()
    await expect(
      reviewFrame.getByRole('button', { name: 'Collapse src/shared.ts' })
    ).toBeVisible()

    await expect(reviewFrame.getByText('2 unresolved')).toBeVisible()
    await reviewFrame
      .getByRole('button', {
        name: 'Resolve comment on src/shared.ts line 1'
      })
      .click()
    await expect(reviewFrame.getByText('Resolved comment')).toBeVisible()
    await expect(reviewFrame.getByText('1 unresolved')).toBeVisible()
    await expect(
      reviewFrame.getByRole('button', { name: 'Copy unresolved (1)' })
    ).toBeEnabled()
    await expect
      .poll(() => mocked.getWebPanelStorage('panel_1', 'review-comments-v1'))
      .toEqual([
        {
          id: 'legacy-comment',
          file: 'src/shared.ts',
          side: 'additions',
          lineNumber: 1,
          body: 'Keep the shared behavior explicit.',
          resolved: true
        },
        {
          id: 'branch-comment',
          file: 'src/branch.ts',
          side: 'additions',
          lineNumber: 1,
          body: 'Cover the branch-only path.',
          resolved: false
        }
      ])

    await page.reload()
    await expect
      .poll(() =>
        page
          .frames()
          .some((frame) =>
            frame.url().includes('/api/web-panels/panel_1/assets/')
          )
      )
      .toBe(true)
    reviewFrame = page
      .frames()
      .find((frame) => frame.url().includes('/api/web-panels/panel_1/assets/'))!
    await expect(reviewFrame.getByText('Resolved comment')).toBeVisible()
    await reviewFrame
      .getByRole('button', {
        name: 'Unresolve comment on src/shared.ts line 1'
      })
      .click()
    await expect(
      reviewFrame.getByText('Keep the shared behavior explicit.')
    ).toBeVisible()
    await expect(reviewFrame.getByText('2 unresolved')).toBeVisible()
    await expect
      .poll(() => mocked.getWebPanelStorage('panel_1', 'review-comments-v1'))
      .toEqual([
        {
          id: 'legacy-comment',
          file: 'src/shared.ts',
          side: 'additions',
          lineNumber: 1,
          body: 'Keep the shared behavior explicit.',
          resolved: false
        },
        {
          id: 'branch-comment',
          file: 'src/branch.ts',
          side: 'additions',
          lineNumber: 1,
          body: 'Cover the branch-only path.',
          resolved: false
        }
      ])

    await expect(
      reviewFrame.getByRole('button', { name: 'Refresh' })
    ).toHaveCount(0)
    await page.route('**/api/panels/panel_1/diff', (route) =>
      route.fulfill({
        json: {
          diff: {
            baseRef: 'origin/trunk',
            baseCommit: 'base',
            headCommit: 'head',
            generatedAt: '2026-01-01T00:00:01.000Z',
            unified: [
              'diff --git a/src/fresh.ts b/src/fresh.ts',
              'index 1111111..2222222 100644',
              '--- a/src/fresh.ts',
              '+++ b/src/fresh.ts',
              '@@ -1 +1 @@',
              '-old result',
              '+fresh result',
              ''
            ].join('\n'),
            changeSets: {
              branch: [],
              staged: [],
              unstaged: ['src/fresh.ts'],
              untracked: []
            }
          }
        }
      })
    )
    await expect(
      reviewFrame.getByRole('treeitem', { name: 'fresh.ts', exact: true })
    ).toBeVisible()
    const outdatedComments = reviewFrame.getByRole('region', {
      name: 'Outdated comments'
    })
    await expect(outdatedComments).toContainText(
      'Keep the shared behavior explicit.'
    )
    await expect(outdatedComments).toContainText('Cover the branch-only path.')
    await expect(
      reviewFrame.getByText('0 unresolved · 2 outdated')
    ).toBeVisible()
    await expect(
      reviewFrame.getByRole('button', {
        name: 'Previous unresolved comment'
      })
    ).toBeDisabled()

    await outdatedComments
      .getByRole('button', {
        name: 'Resolve outdated comment on src/shared.ts line 1'
      })
      .click()
    await expect(
      reviewFrame.getByText('0 unresolved · 1 outdated')
    ).toBeVisible()
    await outdatedComments
      .getByRole('button', {
        name: 'Delete outdated comment on src/branch.ts line 1'
      })
      .click()
    await expect(outdatedComments).toHaveCount(0)
    await expect(reviewFrame.getByText('0 unresolved')).toBeVisible()
    await expect
      .poll(() => mocked.getWebPanelStorage('panel_1', 'review-comments-v1'))
      .toEqual([
        {
          id: 'legacy-comment',
          file: 'src/shared.ts',
          side: 'additions',
          lineNumber: 1,
          body: 'Keep the shared behavior explicit.',
          resolved: true
        }
      ])
  })

  test('edits, saves, refreshes, and protects files from stale writes', async ({
    page
  }) => {
    const mocked = await mockApp(page, [], { realFilesPanel: true })
    await page.getByRole('button', { name: /^topic(?:,|\s|$)/ }).click()
    await page.getByRole('button', { name: 'New panel in topic' }).click()
    const launcher = page.getByRole('dialog', { name: 'New panel' })
    await launcher.getByRole('button', { name: 'Files, web panel' }).click()

    const permissionDialog = page.getByRole('alertdialog', {
      name: 'Allow privileged panel access?'
    })
    await expect(permissionDialog).toContainText(
      'It can read and change existing files in this tree.'
    )
    const permissionRequest = page.waitForRequest(
      (request) =>
        request.method() === 'PUT' &&
        new URL(request.url()).pathname.endsWith('/permission-grant')
    )
    await permissionDialog
      .getByRole('button', { name: 'Allow and open' })
      .click()
    expect((await permissionRequest).postDataJSON()).toEqual({
      granted: true,
      permissions: ['tree-files']
    })
    await expect(page.locator('iframe[title="Files"]')).not.toHaveAttribute(
      'sandbox',
      /allow-same-origin/
    )
    await expect
      .poll(() =>
        page
          .frames()
          .some((frame) =>
            frame.url().includes('/api/web-panels/panel_1/assets/')
          )
      )
      .toBe(true)
    const filesFrame = page
      .frames()
      .find((frame) => frame.url().includes('/api/web-panels/panel_1/assets/'))!

    await filesFrame.getByRole('treeitem', { name: 'src', exact: true }).click()
    await filesFrame
      .getByRole('treeitem', { name: 'app.ts', exact: true })
      .click()
    const editor = filesFrame.getByRole('textbox', { name: 'src/app.ts' })
    await expect(editor).toContainText('export const value = 1')
    await editor.click()
    await editor.press('Control+A')
    await page.keyboard.insertText('export const value = 2')
    await expect(editor).toContainText('export const value = 2')

    await editor.press('Control+Shift+f')
    const contentSearch = filesFrame.getByRole('searchbox', {
      name: 'Search file contents'
    })
    await expect(contentSearch).toBeFocused()
    await contentSearch.fill('value = 2')
    await contentSearch.press('Enter')
    const unsavedMatch = filesFrame.getByRole('button', {
      name: 'src/app.ts, line 2'
    })
    await expect(unsavedMatch).toBeVisible()
    await unsavedMatch.click()
    await expect(editor).toBeFocused()
    await expect(editor).toContainText('export const value = 2')
    await filesFrame.getByRole('button', { name: 'Files', exact: true }).click()

    await editor.press('Control+z')
    await expect(editor).toContainText('export const value = 1')
    await editor.press('Control+y')
    await expect(editor).toContainText('export const value = 2')

    const saveRequest = page.waitForRequest((request) => {
      const url = new URL(request.url())
      return (
        request.method() === 'PUT' &&
        url.pathname === '/api/panels/panel_1/files'
      )
    })
    await editor.press('Control+s')
    expect((await saveRequest).postDataJSON()).toEqual({
      path: 'src/app.ts',
      content: 'export const value = 1\nexport const value = 2',
      expectedRevision: 'revision-1'
    })
    await expect
      .poll(() => mocked.getTreeFile('src/app.ts')?.content)
      .toBe('export const value = 1\nexport const value = 2')
    await expect(filesFrame.getByLabel('Unsaved changes')).toBeHidden()
    await editor.press('Control+z')
    await expect(editor).toContainText('export const value = 1')
    await expect(filesFrame.getByLabel('Unsaved changes')).toBeVisible()
    await page.getByRole('button', { name: 'Close Files' }).click()
    const closeDialog = page.getByRole('alertdialog', { name: 'Close Files?' })
    await expect(closeDialog).toContainText(
      'Changes in this panel have not been saved.'
    )
    await expect(
      closeDialog.getByRole('button', { name: 'Close without saving' })
    ).toBeVisible()
    await closeDialog.getByRole('button', { name: 'Cancel' }).click()

    mocked.setTreeFile('src/app.ts', 'export const external = true\n')
    mocked.setTreeFile('CHANGELOG.md', '# Changes\n')
    await editor.click()
    const changelog = filesFrame.getByRole('treeitem', {
      name: 'CHANGELOG.md',
      exact: true
    })
    await expect(changelog).toBeVisible()
    await changelog.click()
    await expect(
      filesFrame.getByRole('textbox', { name: 'CHANGELOG.md' })
    ).toContainText('# Changes')
    await filesFrame
      .getByRole('treeitem', { name: 'app.ts', exact: true })
      .click()
    await expect(editor).toContainText('export const value = 1')
    const staleRequest = page.waitForRequest((request) => {
      const url = new URL(request.url())
      return (
        request.method() === 'PUT' &&
        url.pathname === '/api/panels/panel_1/files'
      )
    })
    await editor.press('Control+s')
    await staleRequest
    await expect(filesFrame.getByRole('alert')).toContainText(
      'The file changed after it was opened.'
    )
    expect(mocked.getTreeFile('src/app.ts')?.content).toBe(
      'export const external = true\n'
    )
    expect(mocked.treeFileWrites().at(-1)).toEqual({
      path: 'src/app.ts',
      content: 'export const value = 1\n',
      expectedRevision: 'revision-2'
    })

    await filesFrame
      .getByRole('treeitem', { name: 'README.md', exact: true })
      .click()
    const readmeEditor = filesFrame.getByRole('textbox', { name: 'README.md' })
    await expect(readmeEditor).toContainText('# Example')

    mocked.setTreeFile('README.md', '# Refreshed\n')
    await expect(readmeEditor).toContainText('# Refreshed')
  })

  test('creates a terminal while prior closes are pending', async ({
    page
  }) => {
    const mocked = await mockApp(page, [], { desktopBridge: true })
    await page.getByRole('button', { name: /^topic(?:,|\s|$)/ }).click()
    const terminals = page
      .getByRole('list', { name: 'topic terminal tabs' })
      .getByRole('listitem')

    await page.evaluate(() => {
      for (let index = 0; index < 7; index += 1) {
        window.__dispatchDesktopCommand('new-terminal')
      }
    })
    await expect(terminals).toHaveCount(8)

    const releaseDeletes = mocked.delayNextTerminalDelete()
    for (let count = 8; count > 1; count -= 1) {
      await terminals
        .last()
        .getByRole('button', { name: /^Close / })
        .click()
      await expect(terminals).toHaveCount(count - 1)
    }
    await expect.poll(() => mocked.terminalDeletions()).toBe(1)

    await page.evaluate(() => window.__dispatchDesktopCommand('new-terminal'))
    await expect.poll(() => mocked.terminalCreations()).toBe(8)
    await expect(terminals).toHaveCount(2)
    await expect(page).toHaveURL(
      /\/worktrees\/wt_topic\/terminals\/term_dev_8$/
    )

    releaseDeletes()
    await expect.poll(() => mocked.terminalDeletions()).toBe(7)
  })

  test('handles Electron commands through worktree, terminal, and web-panel flows', async ({
    page
  }) => {
    const mocked = await mockApp(page, [], { desktopBridge: true })

    await page.getByRole('button', { name: /^topic(?:,|\s|$)/ }).click()
    await expect(page).toHaveURL(/\/worktrees\/wt_topic\/terminals\/term_pi$/)
    await requestTerminalControl(page)
    await page.evaluate(() => {
      window.__wsSent = []
    })
    await page.keyboard.press('Alt+ArrowUp')
    await expect
      .poll(() =>
        page.evaluate(() =>
          window.__wsSent.some((message: any) => message.type === 'input')
        )
      )
      .toBe(true)
    await expect(page).toHaveURL(/\/worktrees\/wt_topic\/terminals\/term_pi$/)

    await page.evaluate(() =>
      window.__dispatchDesktopCommand('select-next-worktree')
    )
    await expect(page).toHaveURL(/\/worktrees\/wt_main\/terminals\/term_shell$/)
    await expect(page.locator('.xterm-helper-textarea')).toBeFocused()

    await page.evaluate(() =>
      window.__dispatchDesktopCommand('select-previous-worktree')
    )
    await expect(page).toHaveURL(/\/worktrees\/wt_topic\/terminals\/term_pi$/)
    await expect(page.locator('.xterm-helper-textarea')).toBeFocused()

    const topicTerminals = page
      .getByRole('list', { name: 'topic terminal tabs' })
      .getByRole('listitem')
    const releaseCreate = mocked.delayNextTerminalCreate()
    const createRequest = page.waitForRequest(
      (request) =>
        request.method() === 'POST' &&
        new URL(request.url()).pathname === '/api/worktrees/wt_topic/terminals'
    )
    await page.evaluate(() => window.__dispatchDesktopCommand('new-terminal'))
    expect((await createRequest).postDataJSON()).toMatchObject({
      name: 'Shell'
    })
    await expect(page.getByRole('button', { name: /, starting$/ })).toHaveCount(
      0
    )
    await expect(page).toHaveURL(/\/worktrees\/wt_topic\/terminals\/term_pi$/)
    await expect(page.locator('.xterm-helper-textarea')).toBeFocused()
    await page.evaluate(() => window.__dispatchDesktopCommand('new-terminal'))
    await expect.poll(() => mocked.terminalCreations()).toBe(2)
    await expect(topicTerminals).toHaveCount(1)
    releaseCreate()

    const createdTerminal = page.getByRole('button', {
      name: /^Shell, running/
    })
    const createdDevTerminal = page.getByRole('button', {
      name: /^dev · \/worktrees\/topic,/
    })
    await expect(topicTerminals).toHaveCount(3)
    await expect(page).toHaveURL(
      /\/worktrees\/wt_topic\/terminals\/term_dev_2$/
    )
    await expect(createdTerminal).toBeVisible()
    await expect(page.locator('.xterm-helper-textarea')).toBeFocused()
    await createdTerminal.click()
    await expect(createdDevTerminal).toBeVisible()
    await expect(page.locator('.xterm-helper-textarea')).toBeFocused()

    const releaseDelete = mocked.delayNextTerminalDelete()
    const closeRequest = page.waitForRequest(
      (request) =>
        request.method() === 'DELETE' &&
        new URL(request.url()).pathname === '/api/terminals/term_dev'
    )
    await page.evaluate(() => window.__dispatchDesktopCommand('close-panel'))
    await closeRequest
    await expect(createdDevTerminal).toHaveCount(0)
    await expect(topicTerminals).toHaveCount(2)
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            window.__wsInstances.find(
              (socket: any) => socket.terminalId === 'term_dev'
            )?.readyState
        )
      )
      .toBe(3)
    releaseDelete()
    await expect(topicTerminals).toHaveCount(2)

    mocked.failNextTerminalDelete()
    const releaseFailedDelete = mocked.delayNextTerminalDelete()
    const failedCloseRequest = page.waitForRequest(
      (request) =>
        request.method() === 'DELETE' &&
        new URL(request.url()).pathname === '/api/terminals/term_dev_2'
    )
    await page.evaluate(() => window.__dispatchDesktopCommand('close-panel'))
    await failedCloseRequest
    await expect(topicTerminals).toHaveCount(1)
    releaseFailedDelete()
    await expect(
      page.getByText('Couldn’t close terminal “Shell”', { exact: true })
    ).toBeVisible()
    await expect(page.getByText('Terminal could not be closed')).toBeVisible()
    await expect(topicTerminals).toHaveCount(2)

    mocked.failNextTerminalCreate()
    const releaseFailedCreate = mocked.delayNextTerminalCreate()
    await page.evaluate(() => window.__dispatchDesktopCommand('new-terminal'))
    await expect(topicTerminals).toHaveCount(2)
    releaseFailedCreate()
    await expect(
      page.getByText('Couldn’t create terminal “Shell”', { exact: true })
    ).toBeVisible()
    await expect(page.getByText('Terminal could not be created')).toBeVisible()
    await expect(
      page.getByText('Reference: request_terminal_create.')
    ).toBeVisible()
    await expect(topicTerminals).toHaveCount(2)

    mocked.failNextTerminalCreateWithGateway()
    await page.evaluate(() => window.__dispatchDesktopCommand('new-terminal'))
    const gatewayToast = page
      .getByRole('region', { name: /Notifications/ })
      .getByRole('listitem')
      .filter({ hasText: '502 Bad Gateway' })
    await expect(gatewayToast).toContainText('Couldn’t create terminal “Shell”')
    await expect(gatewayToast).toContainText(
      'Check that Treeport is running, then retry.'
    )
    await expect(page.getByText('PRIVATE_PROXY_DIAGNOSTIC')).toHaveCount(0)
    await expect(topicTerminals).toHaveCount(2)

    mocked.failNextTerminalCreateWithNetwork()
    await page.evaluate(() => window.__dispatchDesktopCommand('new-terminal'))
    const networkToast = page
      .getByRole('region', { name: /Notifications/ })
      .getByRole('listitem')
      .filter({ hasText: 'Treeport could not be reached.' })
    await expect(networkToast).toContainText('Couldn’t create terminal “Shell”')
    await expect(networkToast).toContainText(
      'Check that it is running and reachable, then retry.'
    )
    await expect(networkToast).not.toContainText('502 Bad Gateway')
    await expect(topicTerminals).toHaveCount(2)

    await page.evaluate(() => window.__dispatchDesktopCommand('new-panel'))
    const launcherSearch = page.getByLabel('Search panels')
    await expect(launcherSearch).toBeFocused()
    await launcherSearch.fill('Hunk')
    const presetRequest = page.waitForRequest(
      (request) =>
        request.method() === 'POST' &&
        new URL(request.url()).pathname === '/api/worktrees/wt_topic/terminals'
    )
    await page.keyboard.press('Enter')
    expect((await presetRequest).postDataJSON()).toMatchObject({
      name: 'Hunk'
    })

    await page.evaluate(() => window.__dispatchDesktopCommand('new-panel'))
    await page.getByLabel('Search panels').fill('Review')
    const panelOpenRequest = page.waitForRequest(
      (request) =>
        request.method() === 'POST' &&
        new URL(request.url()).pathname ===
          '/api/worktrees/wt_topic/panels/open'
    )
    await page.keyboard.press('Enter')
    expect((await panelOpenRequest).postDataJSON()).toEqual({
      definitionId: 'project:review',
      input: null,
      launchCwd: null
    })
    const reviewNavigationItem = page.getByRole('tab', {
      name: 'Review, web panel'
    })
    await expect(reviewNavigationItem).toHaveCount(1)
    await expect(topicTerminals).toHaveCount(3)
    await expect(page).toHaveURL(/\/panels\/panel_1$/)
    const reviewPanelUrl = page.url()
    await expect(page.locator('iframe[title="Review"]')).not.toHaveAttribute(
      'sandbox',
      /allow-same-origin/
    )
    await expect
      .poll(() =>
        page
          .frames()
          .some((frame) => frame.url().includes('/api/web-panels/panel_1/'))
      )
      .toBe(true)
    const launchedPanelFrame = page
      .frames()
      .find((frame) => frame.url().includes('/api/web-panels/panel_1/'))!
    await launchedPanelFrame.evaluate(() => {
      document.body.textContent = 'Preserved Review state'
    })
    await expect(page.locator('iframe[title="Review"]')).toBeFocused()

    await createdTerminal.click()
    await expect(page.locator('.xterm-helper-textarea')).toBeFocused()
    await expect(
      launchedPanelFrame.getByText('Preserved Review state')
    ).toBeVisible()
    await page.evaluate(() => window.__dispatchDesktopCommand('new-panel'))
    await page.getByLabel('Search panels').fill('Review')
    const panelReuseRequest = page.waitForRequest(
      (request) =>
        request.method() === 'POST' &&
        new URL(request.url()).pathname ===
          '/api/worktrees/wt_topic/panels/open'
    )
    await page.keyboard.press('Enter')
    await panelReuseRequest
    await expect(reviewNavigationItem).toHaveCount(1)
    await expect(page).toHaveURL(reviewPanelUrl)
    await expect(
      launchedPanelFrame.getByText('Preserved Review state')
    ).toBeVisible()
    await expect(page.locator('iframe[title="Review"]')).toBeFocused()
    await page.reload()

    await expect
      .poll(() =>
        page
          .frames()
          .some((frame) => frame.url().includes('/api/web-panels/panel_1/'))
      )
      .toBe(true)
    const panelFrame = page
      .frames()
      .find((frame) => frame.url().includes('/api/web-panels/panel_1/'))!
    await panelFrame.evaluate(() => {
      document.body.textContent = 'Unsaved panel draft'
      let keyboardInputs = 0
      window.addEventListener('keydown', (event) => {
        if (event.key !== 'x') {
          return
        }

        keyboardInputs += 1
        let status = document.querySelector(
          '[aria-label="Keyboard input status"]'
        )
        if (!status) {
          status = document.createElement('div')
          status.setAttribute('aria-label', 'Keyboard input status')
          document.body.append(status)
        }

        status.textContent = `Keyboard input received ${keyboardInputs} time${
          keyboardInputs === 1 ? '' : 's'
        }`
      })

      let findRequests = 0
      window.addEventListener('message', (event) => {
        if (
          event.source !== parent ||
          event.data?.source !== 'treeport-host-v1' ||
          event.data.method !== 'shortcut' ||
          event.data.shortcut !== 'find'
        ) {
          return
        }

        findRequests += 1
        let status = document.querySelector('[role="status"]')
        if (!status) {
          status = document.createElement('div')
          status.setAttribute('role', 'status')
          document.body.append(status)
        }

        status.textContent = `Find requested ${findRequests} time${
          findRequests === 1 ? '' : 's'
        }`
      })
    })
    await expect(panelFrame.getByText('Unsaved panel draft')).toBeVisible()

    await reviewNavigationItem.focus()
    await page.keyboard.press('Meta+f')
    await expect(panelFrame.getByRole('status')).toHaveText(
      'Find requested 1 time'
    )

    await panelFrame.evaluate(() =>
      parent.postMessage(
        {
          source: 'treeport-panel-v1',
          method: 'workspace.select',
          index: 0
        },
        '*'
      )
    )
    await expect(page.locator('.xterm-helper-textarea')).toBeFocused()
    await page.keyboard.press('Meta+4')
    await expect(page.locator('.xterm-helper-textarea')).toBeFocused()
    await panelFrame.locator('body').click()
    await page.keyboard.press('x')
    await expect(panelFrame.getByLabel('Keyboard input status')).toHaveText(
      'Keyboard input received 1 time'
    )

    await page.evaluate(() => window.__dispatchDesktopCommand('new-terminal'))
    const openToolPicker = page.getByLabel('Open a tool', { exact: true })
    await expect(openToolPicker).toBeVisible()
    await expect(openToolPicker.getByLabel('Available tools')).toBeFocused()
    await page.keyboard.press('Escape')
    await page.evaluate(() => window.__dispatchDesktopCommand('select-tab-1'))
    await expect(page).toHaveURL(reviewPanelUrl)
    await page.evaluate(() => window.__dispatchDesktopCommand('select-tab-2'))
    await expect(page).toHaveURL(reviewPanelUrl)

    await page.getByRole('button', { name: /^topic(?:,|\s|$)/ }).click()
    await page.evaluate(() => window.__dispatchDesktopCommand('select-tab-1'))
    await expect(page).toHaveURL(/\/terminals\/term_pi$/)
    const terminalFromTerminalRequest = page.waitForRequest(
      (request) =>
        request.method() === 'POST' &&
        new URL(request.url()).pathname === '/api/worktrees/wt_topic/terminals'
    )
    await page.evaluate(() => window.__dispatchDesktopCommand('new-terminal'))
    await terminalFromTerminalRequest
    await expect(page.locator('.xterm-helper-textarea')).toBeFocused()

    await reviewNavigationItem.click()
    await expect(panelFrame.getByText('Unsaved panel draft')).toBeVisible()
    mocked.setWebPanelHasStorage(true)
    await page.evaluate(() => window.__dispatchDesktopCommand('close-panel'))
    const closePanelDialog = page.getByRole('alertdialog', {
      name: 'Close Review?'
    })
    await expect(closePanelDialog).toContainText(
      'Closing it permanently deletes that data'
    )
    await closePanelDialog.getByRole('button', { name: 'Cancel' }).click()
    await expect(reviewNavigationItem).toBeVisible()

    const panelDeleteRequest = page.waitForRequest((request) => {
      const url = new URL(request.url())
      return (
        request.method() === 'DELETE' &&
        url.pathname === '/api/panels/panel_1' &&
        url.searchParams.get('discardStoredData') === 'true'
      )
    })
    await reviewNavigationItem.click({ button: 'middle' })
    await expect(closePanelDialog).toBeVisible()
    await closePanelDialog
      .getByRole('button', { name: 'Close and delete data' })
      .click()
    await panelDeleteRequest
    await expect(reviewNavigationItem).toHaveCount(0)
    await expect(page).toHaveURL(/\/terminals\/[^/]+$/)
    await expect(
      page
        .getByRole('region', { name: 'topic tool tab group' })
        .getByText('Open a tool')
    ).toBeVisible()
    await expect(
      page.getByRole('button', { name: 'Browser, new tab' })
    ).toBeFocused()

    const browserFromToolSurfaceRequest = page.waitForRequest(
      (request) =>
        request.method() === 'POST' &&
        new URL(request.url()).pathname ===
          '/api/worktrees/wt_topic/browser-panels'
    )
    await page.evaluate(() => window.__dispatchDesktopCommand('new-terminal'))
    await expect(
      page.getByRole('button', { name: 'Browser, new tab' })
    ).toBeFocused()
    await page.keyboard.press('Enter')
    await browserFromToolSurfaceRequest
    await expect(page).toHaveURL(/\/panels\/browser_panel_\d+$/)

    await page.evaluate(() => window.__dispatchDesktopCommand('new-worktree'))
    await expect(
      page.getByRole('dialog', { name: 'Create tree' })
    ).toBeVisible()
  })
})
