import { expect, test } from '@playwright/test'
import {
  mockApp,
  requestTerminalControl,
  waitForTerminalControl
} from './app-fixture'

test.describe('desktop worktree and terminal workflows', () => {
  test('creates worktrees with focus, rollback, retry, and preset snapshots', async ({
    page
  }) => {
    const mocked = await mockApp(page)
    {
      const trigger = page.getByRole('button', { name: 'New worktree' })
      await trigger.click()
      const dialog = page.getByRole('dialog', { name: 'Create worktree' })
      await expect(dialog).toBeVisible()
      await expect(dialog.getByLabel('Worktree name')).toBeFocused()
      await dialog.getByLabel('Worktree name').fill('focus-test')
      const submit = dialog.getByRole('button', { name: 'Create worktree' })
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
      await page.getByRole('button', { name: 'New worktree' }).click()
      await page.getByLabel('Worktree name').fill('will fail')
      await page.getByRole('button', { name: 'Create worktree' }).click()
      await expect(
        page.getByRole('heading', { name: 'Create worktree' })
      ).toHaveCount(0)
      const pending = page.getByRole('status', {
        name: 'Creating worktree will fail'
      })
      await expect(pending).toHaveText('will fail')

      releaseCreate()
      await expect(pending).toHaveCount(0)
      await expect(page.getByText('create failed')).toBeVisible()
    }
    {
      const releaseCreate = mocked.delayNextCreate()
      await page.getByRole('button', { name: 'New worktree' }).click()
      await page.getByLabel('Worktree name').fill('new topic')
      const requestPromise = page.waitForRequest(
        (request) =>
          request.method() === 'POST' &&
          new URL(request.url()).pathname ===
            '/api/projects/proj_1/worktree-operations'
      )
      await page.getByRole('button', { name: 'Create worktree' }).click()
      const request = await requestPromise
      expect(request.postDataJSON()).toEqual({
        name: 'new topic',
        base: 'default',
        initialTerminal: {
          name: 'Shell',
          initialSize: {
            cols: expect.any(Number),
            rows: expect.any(Number)
          }
        }
      })
      await expect(
        page.getByRole('heading', { name: 'Create worktree' })
      ).toHaveCount(0)
      const pending = page.getByRole('status', {
        name: 'Creating worktree new topic'
      })
      await expect(pending).toHaveText('new topic')
      await expect(pending).toBeFocused()
      const projectRequestsBeforeEvent = mocked.projectRequests()
      await page.evaluate(() =>
        (window as any).__eventSource.emit('worktree.created')
      )
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
        page.getByRole('button', { name: 'new-topic', exact: true })
      ).toHaveCount(1)
      expect(await pending.count()).toBe(0)
      await expect(
        page.getByRole('button', { name: /^(main worktree|topic|new-topic)$/ })
      ).toHaveText(['main worktree', 'topic', 'new-topic'])
      await expect
        .poll(() =>
          page.evaluate(() =>
            ((window as any).__wsInstances || []).some(
              (socket: { url: string }) => socket.url.includes('term_new')
            )
          )
        )
        .toBe(true)
      const terminalOutput = page.locator('.xterm-rows')
      await expect(terminalOutput).toContainText('SETUP_OUTPUT')
      await expect(terminalOutput).toContainText('SHELL_READY')
      const text = await terminalOutput.textContent()
      expect(text?.indexOf('SETUP_OUTPUT')).toBeLessThan(
        text?.indexOf('SHELL_READY') ?? -1
      )
    }
    {
      await page.getByRole('button', { name: 'New worktree' }).click()
      await page.getByLabel('Initial terminal').selectOption({ label: 'Hunk' })
      await expect
        .poll(() =>
          page.evaluate(() =>
            localStorage.getItem('treeport-initial-terminal-preset')
          )
        )
        .toBe('preset_hunk')
      await page.keyboard.press('Escape')
      await page.reload()
      await page.getByRole('button', { name: 'New worktree' }).click()
      await expect(page.getByLabel('Initial terminal')).toHaveValue(
        'preset_hunk'
      )
      await page.getByLabel('Worktree name').fill('preset topic')
      const requestPromise = page.waitForRequest(
        (request) =>
          request.method() === 'POST' &&
          new URL(request.url()).pathname ===
            '/api/projects/proj_1/worktree-operations'
      )
      await page.getByRole('button', { name: 'Create worktree' }).click()
      expect((await requestPromise).postDataJSON()).toEqual({
        name: 'preset topic',
        base: 'default',
        initialTerminal: expect.objectContaining({
          name: 'Hunk',
          returnToShell: true,
          initialSize: {
            cols: expect.any(Number),
            rows: expect.any(Number)
          }
        })
      })
      await page.getByRole('button', { name: 'New worktree' }).click()
      await expect(page.getByLabel('Initial terminal')).toHaveValue(
        'preset_hunk'
      )
      await page.getByLabel('Initial terminal').selectOption('shell')
      await page.keyboard.press('Escape')
      await page.getByRole('button', { name: 'New worktree' }).click()
      await expect(page.getByLabel('Initial terminal')).toHaveValue('shell')
    }
  })

  test('restores an in-progress worktree creation after reload without taking over navigation', async ({
    page
  }) => {
    const mocked = await mockApp(page)
    const releaseCreate = mocked.delayNextCreate()
    await page.getByRole('button', { name: 'New worktree' }).click()
    await page.getByLabel('Worktree name').fill('reload topic')
    await page.getByRole('button', { name: 'Create worktree' }).click()
    await expect(
      page.getByRole('status', { name: 'Creating worktree reload topic' })
    ).toBeVisible()

    await page.reload()
    await expect(
      page.getByRole('status', { name: 'Creating worktree reload topic' })
    ).toBeVisible()
    const activeTerminal = page.getByRole('main', { name: /terminal$/ })
    await expect(activeTerminal).toBeVisible()
    releaseCreate()
    await expect(
      page.getByRole('status', { name: 'Creating worktree reload topic' })
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
      ;(window as any).__wsSent = []
      ;(window as any).__delayTakeControl = true
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
        (window as any).__wsSent.some(
          (message: any) => message.type === 'take_control'
        )
      )
    ).toBe(false)

    await page.keyboard.press('x')
    await expect(
      page.getByText('Taking control…', { exact: true })
    ).toBeVisible()
    expect(
      await page.evaluate(() =>
        (window as any).__wsSent.some(
          (message: any) => message.type === 'input' && message.data === 'x'
        )
      )
    ).toBe(false)

    await page.evaluate(() => (window as any).__releaseTakeControl())
    await waitForTerminalControl(page)
    expect(
      await page.evaluate(() =>
        (window as any).__wsSent.some(
          (message: any) => message.type === 'input' && message.data === 'x'
        )
      )
    ).toBe(false)

    await page.keyboard.press('y')
    await expect
      .poll(() =>
        page.evaluate(() =>
          (window as any).__wsSent.some(
            (message: any) => message.type === 'input' && message.data === 'y'
          )
        )
      )
      .toBe(true)

    const socketsBeforeReconnect = await page.evaluate(
      () => (window as any).__wsInstances.length
    )
    await page.evaluate(() => (window as any).__lastWs.onclose())
    await expect
      .poll(() => page.evaluate(() => (window as any).__wsInstances.length))
      .toBeGreaterThan(socketsBeforeReconnect)
  })

  test('takes control on an ordinary clipboard paste without replaying it', async ({
    page
  }) => {
    await mockApp(page)
    await page.getByRole('button', { name: 'Pi, running', exact: true }).click()
    await page.evaluate(() => {
      ;(window as any).__wsSent = []
      ;(window as any).__delayTakeControl = true
      const clipboard = new DataTransfer()
      clipboard.setData('text/plain', 'pasted while viewing')
      const event = new Event('paste', { bubbles: true, cancelable: true })
      Object.defineProperty(event, 'clipboardData', { value: clipboard })
      document.querySelector('.xterm-helper-textarea')!.dispatchEvent(event)
    })

    await expect(
      page.getByText('Taking control…', { exact: true })
    ).toBeVisible()
    expect(
      await page.evaluate(() =>
        (window as any).__wsSent.some(
          (message: any) =>
            message.type === 'input' &&
            String(message.data).includes('pasted while viewing')
        )
      )
    ).toBe(false)

    await page.evaluate(() => (window as any).__releaseTakeControl())
    await waitForTerminalControl(page)
    expect(
      await page.evaluate(() =>
        (window as any).__wsSent.some(
          (message: any) =>
            message.type === 'input' &&
            String(message.data).includes('pasted while viewing')
        )
      )
    ).toBe(false)
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
      const socket = (window as any).__lastWs
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
      const socket = (window as any).__lastWs
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
            const socket = (window as any).__lastWs
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
      const socket = (window as any).__lastWs
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
    const before = await page.evaluate(
      () => (window as any).__wsInstances.length
    )
    await page.evaluate(() => window.dispatchEvent(new Event('online')))
    await page.waitForTimeout(750)
    expect(
      await page.evaluate(() => (window as any).__wsInstances.length)
    ).toBe(before)
    await page.getByRole('button', { name: 'Retry' }).click()
    await expect
      .poll(() => page.evaluate(() => (window as any).__wsInstances.length))
      .toBeGreaterThan(before)
  })

  test('acknowledges, coalesces, and dismisses terminal bells', async ({
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
    await expect(piTreeRow).toBeVisible()
    await page.reload()
    await expect(piTreeRow).toBeVisible()

    const acknowledgement = page.waitForRequest(
      (request) =>
        request.method() === 'POST' &&
        new URL(request.url()).pathname ===
          '/api/terminals/term_pi/bell/acknowledge'
    )
    await piTreeRow.click()
    const request = await acknowledgement
    expect(request.postDataJSON()).toEqual({ sequence: 4 })
    await expect(piTreeRow).toBeVisible()

    await page.evaluate(() =>
      (window as any).__eventSource.emit(
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
      const socket = (window as any).__wsInstances.find((item: any) =>
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
    await page
      .getByRole('button', { name: 'main worktree', exact: true })
      .click()
    await expect(page.locator('.xterm-helper-textarea')).toBeFocused()

    const emitBell = (sequence: number, unread = true) =>
      page.evaluate(
        ({ nextSequence, nextUnread }) => {
          ;(window as any).__eventSource.emit(
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
    const dismissToast = page.getByRole('button', { name: 'Dismiss' })
    await expect(dismissToast).toHaveCount(1)
    await expect(
      page.getByText('example · topic', { exact: true })
    ).toBeVisible()
    await expect(
      page.getByRole('button', {
        name: /Pi build · \/worktrees\/topic.*61% complete.*bell/
      })
    ).toBeVisible()
    await expect
      .poll(() => page.evaluate(() => (window as any).__attentionRequests))
      .toBe(1)

    await emitBell(5, false)
    await expect(dismissToast).toHaveCount(1)

    await emitBell(6)
    await expect(dismissToast).toHaveCount(1)
    const liveAcknowledgement = page.waitForRequest(
      (request) =>
        request.method() === 'POST' &&
        new URL(request.url()).pathname ===
          '/api/terminals/term_pi/bell/acknowledge'
    )
    await page
      .getByRole('button', { name: /Pi build · \/worktrees\/topic.*bell/ })
      .click()
    expect((await liveAcknowledgement).postDataJSON()).toEqual({ sequence: 6 })
    await expect(
      page.getByRole('main', {
        name: 'Pi build · /worktrees/topic terminal'
      })
    ).toBeVisible()
    await expect(dismissToast).toHaveCount(0)
    await page
      .getByRole('button', { name: 'main worktree', exact: true })
      .click()
    const activeBellTerminal = page.getByRole('main', {
      name: 'zsh · /worktrees/topic terminal'
    })
    await expect(activeBellTerminal).toBeVisible()

    await page.evaluate(() =>
      (window as any).__eventSource.emit(
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

    await expect(dismissToast).toBeVisible()
    await expect(activeBellTerminal).toBeVisible()
    const dismissAcknowledgement = page.waitForRequest(
      (request) =>
        request.method() === 'POST' &&
        new URL(request.url()).pathname ===
          '/api/terminals/term_pi/bell/acknowledge'
    )
    await dismissToast.click()
    expect((await dismissAcknowledgement).postDataJSON()).toEqual({
      sequence: 7
    })
    await expect(activeBellTerminal).toBeVisible()
    await expect(dismissToast).toHaveCount(0)
  })

  test('manages global terminal presets without a selected worktree', async ({
    page
  }) => {
    await mockApp(page, [], { worktreeFree: true })
    const trigger = page.getByRole('button', { name: /^New panel/ })
    await expect(trigger).toBeEnabled()
    await trigger.click()
    const launcher = page.getByRole('dialog', { name: 'New panel' })
    await expect(launcher.getByRole('button', { name: 'Shell' })).toBeDisabled()
    await launcher.getByRole('button', { name: 'Manage presets' }).click()
    const dialog = page.getByRole('dialog', { name: 'Terminal presets' })
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
    await expect(page.getByRole('button', { name: /^New panel/ })).toBeFocused()
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
    await page.getByRole('button', { name: /^New panel/ }).click()
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
      name: 'topic terminals'
    })
    await expect(
      topicTerminals.getByRole('button', {
        name: /^dev · \/worktrees\/topic,/
      })
    ).toBeVisible()
    await expect(page.locator('.xterm-helper-textarea')).toBeFocused()
    const socketsBeforeSwitch = await page.evaluate(
      () => (window as any).__wsInstances.length
    )
    const zshTerminal = topicTerminals.getByRole('button', {
      name: /^zsh · \/worktrees\/topic,/
    })
    await zshTerminal.click()
    await expect(page.locator('.xterm-helper-textarea')).toBeFocused()
    await zshTerminal.click()
    await expect(page.locator('.xterm-helper-textarea')).toBeFocused()
    await expect
      .poll(() => page.evaluate(() => (window as any).__wsInstances.length))
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
    await page.getByRole('button', { name: /^New panel/ }).click()
    const presetItem = page
      .getByRole('dialog', { name: 'New panel' })
      .getByRole('button', { name: 'Hunk', exact: true })
    await presetItem.click()
    const presetRequest = await presetRequestPromise
    expect(presetRequest.postDataJSON()).toEqual({
      name: 'Hunk',
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
    await page.getByRole('button', { name: 'New worktree' }).click()
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
    await page.getByRole('button', { name: /^New panel/ }).click()
    await page
      .getByRole('dialog', { name: 'New panel' })
      .getByRole('button', { name: 'Open editor' })
      .click()
    expect((await oneOffRequestPromise).postDataJSON()).toEqual({
      name: 'Open editor',
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
    await page.getByRole('button', { name: /^New panel/ }).click()
    await page
      .getByRole('dialog', { name: 'New panel' })
      .getByRole('button', { name: 'Shell' })
      .click()
    const topicTerminals = page.getByRole('list', {
      name: 'topic terminals'
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

  test('handles Electron commands through worktree, terminal, and web-panel flows', async ({
    page
  }) => {
    const mocked = await mockApp(page, [], { desktopBridge: true })

    await page.getByRole('button', { name: /^topic(?:,|\s|$)/ }).click()

    const topicTerminals = page
      .getByRole('list', { name: 'topic terminals' })
      .getByRole('listitem')
    const releaseCreate = mocked.delayNextTerminalCreate()
    const createRequest = page.waitForRequest(
      (request) =>
        request.method() === 'POST' &&
        new URL(request.url()).pathname === '/api/worktrees/wt_topic/terminals'
    )
    await page.evaluate(() =>
      (window as any).__dispatchDesktopCommand('new-terminal')
    )
    expect((await createRequest).postDataJSON()).toMatchObject({
      name: 'Shell'
    })
    await expect(
      page.getByRole('button', { name: 'Shell, starting' })
    ).toBeVisible()
    await expect(page.getByRole('status')).toHaveText('Starting Shell…')
    await page.evaluate(() =>
      (window as any).__dispatchDesktopCommand('new-terminal')
    )
    await expect.poll(() => mocked.terminalCreations()).toBe(2)
    await expect(
      page.getByRole('button', { name: 'Shell, starting' })
    ).toHaveCount(2)
    releaseCreate()

    const createdTerminal = page.getByRole('button', {
      name: /^Shell, running/
    })
    const createdDevTerminal = page.getByRole('button', {
      name: /^dev · \/worktrees\/topic,/
    })
    await expect(topicTerminals).toHaveCount(3)
    await expect(createdTerminal).toBeVisible()
    await createdTerminal.click()
    await expect(createdDevTerminal).toBeVisible()
    await expect(page.locator('.xterm-helper-textarea')).toBeFocused()

    const releaseDelete = mocked.delayNextTerminalDelete()
    const closeRequest = page.waitForRequest(
      (request) =>
        request.method() === 'DELETE' &&
        new URL(request.url()).pathname === '/api/terminals/term_dev'
    )
    await page.evaluate(() =>
      (window as any).__dispatchDesktopCommand('close-panel')
    )
    await closeRequest
    await expect(createdDevTerminal).toHaveCount(0)
    await expect(topicTerminals).toHaveCount(2)
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            (window as any).__wsInstances.find(
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
    await page.evaluate(() =>
      (window as any).__dispatchDesktopCommand('close-panel')
    )
    await failedCloseRequest
    await expect(topicTerminals).toHaveCount(1)
    releaseFailedDelete()
    await expect(page.getByText('Terminal could not be closed')).toBeVisible()
    await expect(topicTerminals).toHaveCount(2)

    mocked.failNextTerminalCreate()
    const releaseFailedCreate = mocked.delayNextTerminalCreate()
    await page.evaluate(() =>
      (window as any).__dispatchDesktopCommand('new-terminal')
    )
    await expect(
      page.getByRole('button', { name: 'Shell, starting' })
    ).toBeVisible()
    releaseFailedCreate()
    await expect(page.getByText('Terminal could not be created')).toBeVisible()
    await expect(
      page.getByRole('button', { name: 'Shell, starting' })
    ).toHaveCount(0)

    await page.evaluate(() =>
      (window as any).__dispatchDesktopCommand('new-panel')
    )
    const launcherSearch = page.getByLabel('Search panels')
    await expect(launcherSearch).toBeFocused()
    await launcherSearch.fill('Hunk')
    const presetRequest = page.waitForRequest(
      (request) =>
        request.method() === 'POST' &&
        new URL(request.url()).pathname === '/api/worktrees/wt_topic/terminals'
    )
    await page.keyboard.press('Enter')
    expect((await presetRequest).postDataJSON()).toMatchObject({ name: 'Hunk' })

    await page.evaluate(() =>
      (window as any).__dispatchDesktopCommand('new-panel')
    )
    await page.getByLabel('Search panels').fill('Review')
    const panelCreateRequest = page.waitForRequest(
      (request) =>
        request.method() === 'POST' &&
        new URL(request.url()).pathname === '/api/worktrees/wt_topic/panels'
    )
    await page.keyboard.press('Enter')
    expect((await panelCreateRequest).postDataJSON()).toEqual({
      definitionId: 'project:review'
    })
    await expect(
      page.getByRole('button', { name: 'Review, web panel' })
    ).toBeVisible()
    await expect
      .poll(() =>
        page
          .frames()
          .some((frame) => frame.url().includes('/api/web-panels/panel_1/'))
      )
      .toBe(true)
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

        status.textContent = `Find requested ${findRequests} time${findRequests === 1 ? '' : 's'}`
      })
    })
    await expect(panelFrame.getByText('Unsaved panel draft')).toBeVisible()

    await page.getByRole('button', { name: 'Review, web panel' }).focus()
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
    await expect(panelFrame.getByText('Unsaved panel draft')).toBeVisible()

    const terminalFromPanelRequest = page.waitForRequest(
      (request) =>
        request.method() === 'POST' &&
        new URL(request.url()).pathname === '/api/worktrees/wt_topic/terminals'
    )
    await page.evaluate(() =>
      (window as any).__dispatchDesktopCommand('new-terminal')
    )
    await terminalFromPanelRequest
    await expect(page.locator('.xterm-helper-textarea')).toBeFocused()

    await page.getByRole('button', { name: 'Review, web panel' }).click()
    await expect(panelFrame.getByText('Unsaved panel draft')).toBeVisible()
    mocked.setWebPanelHasStorage(true)
    await page.evaluate(() =>
      (window as any).__dispatchDesktopCommand('close-panel')
    )
    const closePanelDialog = page.getByRole('alertdialog', {
      name: 'Close Review?'
    })
    await expect(closePanelDialog).toContainText(
      'Closing it permanently deletes that data'
    )
    await closePanelDialog.getByRole('button', { name: 'Cancel' }).click()
    await expect(
      page.getByRole('button', { name: 'Review, web panel' })
    ).toBeVisible()

    const panelDeleteRequest = page.waitForRequest((request) => {
      const url = new URL(request.url())
      return (
        request.method() === 'DELETE' &&
        url.pathname === '/api/panels/panel_1' &&
        url.searchParams.get('discardStoredData') === 'true'
      )
    })
    await page
      .getByRole('button', { name: 'Review, web panel' })
      .click({ button: 'middle' })
    await expect(closePanelDialog).toBeVisible()
    await closePanelDialog
      .getByRole('button', { name: 'Close and delete data' })
      .click()
    await panelDeleteRequest
    await expect(
      page.getByRole('button', { name: 'Review, web panel' })
    ).toHaveCount(0)
    await expect(page.locator('.xterm-helper-textarea')).toBeFocused()

    await page.evaluate(() =>
      (window as any).__dispatchDesktopCommand('new-worktree')
    )
    await expect(
      page.getByRole('dialog', { name: 'Create worktree' })
    ).toBeVisible()
  })
})
