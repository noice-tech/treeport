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
      const selectedTerminal = page.getByRole('main', {
        name: /terminal workspace$/
      })
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
      await page.getByLabel('Task description').press('ControlOrMeta+Enter')
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
      await expect(pending).not.toBeFocused()
      const projectRequestsBeforeEvent = mocked.projectRequests()
      await mocked.emitProjectEvent('worktree.created', {
        projectId: 'proj_1',
        worktreeId: 'wt_new'
      })
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
      await expect(pending).toHaveCount(0)
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

  test('remembers initial terminals independently for each project', async ({
    page
  }) => {
    await mockApp(page, [], { includeSecondProject: true })
    await page.getByRole('button', { name: 'New tree' }).click()
    await expect(page.getByLabel('Initial terminal')).toHaveValue('shell')
    await page.keyboard.press('Escape')

    await page
      .getByRole('button', {
        name: 'Switch project, current project example'
      })
      .click()
    await page
      .getByRole('button', { name: 'another-project', exact: true })
      .click()
    await page.getByRole('button', { name: 'New tree' }).click()
    await expect(page.getByLabel('Initial terminal')).toHaveValue('shell')
    await page.getByLabel('Initial terminal').selectOption('preset_hunk')
    await page.keyboard.press('Escape')

    await page
      .getByRole('button', {
        name: 'Switch project, current project another-project'
      })
      .click()
    await page.getByRole('button', { name: 'example', exact: true }).click()
    await page.getByRole('button', { name: 'New tree' }).click()
    await expect(page.getByLabel('Initial terminal')).toHaveValue('shell')
    await page.keyboard.press('Escape')
    await page.reload()
    await page
      .getByRole('button', {
        name: 'Switch project, current project example'
      })
      .click()
    await page
      .getByRole('button', { name: 'another-project', exact: true })
      .click()
    await page.getByRole('button', { name: 'New tree' }).click()
    await expect(page.getByLabel('Initial terminal')).toHaveValue('preset_hunk')
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
    const activeTerminal = page.getByRole('main', {
      name: 'main tree terminal workspace'
    })
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
    const mocked = await mockApp(page)
    await page.getByRole('button', { name: 'Pi, running', exact: true }).click()
    await expect(page.locator('.xterm-helper-textarea')).toBeFocused()
    await expect(page.getByText('Viewing', { exact: true })).toBeVisible()
    await page.clock.install()
    mocked.terminal.messages = []
    mocked.terminal.delayTakeControl = true
    await page.getByRole('textbox', { name: 'Terminal input' }).press('Meta+f')
    // The modifier-only event must not request control, even after timers run.
    await page.clock.runFor(50)
    await expect(page.getByText('Viewing', { exact: true })).toBeVisible()
    expect(
      mocked.terminal.messages.some(
        (message) => message.type === 'take_control'
      )
    ).toBe(false)

    await page.keyboard.press('x')
    await expect(
      page.getByText('Taking control…', { exact: true })
    ).toBeVisible()
    expect(
      mocked.terminal.messages.some(
        (message) => message.type === 'input' && message.data === 'x'
      )
    ).toBe(false)

    mocked.terminal.releaseTakeControl!()
    await waitForTerminalControl(page)
    expect(
      mocked.terminal.messages.some(
        (message) => message.type === 'input' && message.data === 'x'
      )
    ).toBe(false)

    await page.keyboard.press('y')
    await expect
      .poll(() =>
        mocked.terminal.messages.some(
          (message) => message.type === 'input' && message.data === 'y'
        )
      )
      .toBe(true)

    const socketsBeforeReconnect = mocked.terminal.connections.length
    mocked.terminal.connection.close()
    await expect
      .poll(() => mocked.terminal.connections.length)
      .toBeGreaterThan(socketsBeforeReconnect)
  })

  test('broadcasts canonical dimensions and controller takeover across two viewers', async ({
    context,
    page
  }) => {
    const viewer = await context.newPage()
    const controller = await mockApp(page)
    const observer = await mockApp(viewer)
    await page.getByRole('button', { name: 'Pi, running', exact: true }).click()
    await viewer
      .getByRole('button', { name: 'Pi, running', exact: true })
      .click()

    await page.clock.install()
    await viewer.clock.install()
    await requestTerminalControl(page)
    await expect(viewer.getByText('Viewing', { exact: true })).toBeVisible()
    await page.clock.runFor(250)
    controller.terminal.messages = []
    observer.terminal.messages = []

    await page.setViewportSize({ width: 1_100, height: 720 })
    await expect
      .poll(
        () =>
          controller.terminal.messages.filter(
            (message) => message.type === 'resize'
          ).length
      )
      .toBeGreaterThan(0)
    const controllerResize = controller.terminal.messages
      .filter((message) => message.type === 'resize')
      .at(-1)!
    for (const target of [page, viewer]) {
      await expect(target.locator('.xterm-rows > div')).toHaveCount(
        controllerResize.rows
      )
    }

    await viewer.setViewportSize({ width: 760, height: 640 })
    // A read-only viewer must not publish a debounced resize.
    await viewer.clock.runFor(250)
    expect(
      observer.terminal.messages.filter((message) => message.type === 'resize')
    ).toHaveLength(0)
    await expect(page.locator('.xterm-rows > div')).toHaveCount(
      controllerResize.rows
    )

    await requestTerminalControl(viewer)
    await expect(page.getByText('Viewing', { exact: true })).toBeVisible()
    await expect
      .poll(
        () =>
          observer.terminal.messages.filter(
            (message) => message.type === 'take_control'
          ).length
      )
      .toBe(1)
    const takeover = observer.terminal.messages.find(
      (message) => message.type === 'take_control'
    )!
    for (const target of [page, viewer]) {
      await expect(target.locator('.xterm-rows > div')).toHaveCount(
        takeover.rows
      )
    }

    observer.terminal.messages = []
    await viewer.setViewportSize({ width: 980, height: 700 })
    await expect
      .poll(
        () =>
          observer.terminal.messages.filter(
            (message) => message.type === 'resize'
          ).length
      )
      .toBeGreaterThan(0)
    const viewerResize = observer.terminal.messages
      .filter((message) => message.type === 'resize')
      .at(-1)!
    for (const target of [page, viewer]) {
      await expect(target.locator('.xterm-rows > div')).toHaveCount(
        viewerResize.rows
      )
    }
  })

  test('does not automatically retry a fatal terminal error', async ({
    page
  }) => {
    const mocked = await mockApp(page)
    await page.getByRole('button', { name: 'Pi, running', exact: true }).click()
    await expect(page.getByText('Viewing', { exact: true })).toBeVisible()
    await page.clock.install()
    {
      const socket = mocked.terminal.connection
      socket.receive('terminal_error', {
        code: 'ATTACH_FAILED',
        message: 'Terminal unavailable',
        retryable: false
      })
    }
    await expect(page.getByRole('button', { name: 'Retry' })).toBeVisible()
    mocked.terminal.connection.close()
    const before = mocked.terminal.connections.length
    await page.evaluate(() => window.dispatchEvent(new Event('online')))
    // Exercise the reconnect timer rather than racing a fixed sleep.
    await page.clock.runFor(750)
    expect(mocked.terminal.connections).toHaveLength(before)
    await page.getByRole('button', { name: 'Retry' }).click()
    await expect
      .poll(() => mocked.terminal.connections.length)
      .toBeGreaterThan(before)
  })

  test('confirms before closing a terminal with a foreground process', async ({
    page
  }) => {
    await mockApp(page, [
      {
        terminalId: 'term_pi',
        title: null,
        program: null,
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

  test('expands the side panel and restores its split layout', async ({
    page
  }) => {
    await mockApp(page)
    const toggle = page.getByRole('button', { name: 'Toggle side panel' })
    await toggle.click()
    const panel = page.getByRole('region', { name: 'main tree tool tab group' })
    const rail = page.getByRole('separator', { name: 'Resize side panel' })
    const defaultBounds = await panel.boundingBox()
    expect(defaultBounds).not.toBeNull()
    await rail.press('ArrowRight')
    await expect
      .poll(async () => (await panel.boundingBox())?.width)
      .toBeLessThan(defaultBounds!.width)
    const splitBounds = await panel.boundingBox()
    const terminal = page.getByRole('main', {
      name: 'main tree terminal workspace'
    })
    const terminalBounds = await terminal.boundingBox()
    expect(splitBounds).not.toBeNull()
    expect(terminalBounds).not.toBeNull()

    const enter = page.getByRole('button', { name: 'Enter full view' })
    const tooltip = page.getByRole('tooltip')
    await rail.hover()
    await toggle.hover()
    await expect(tooltip).toContainText('Toggle side panel ·')
    await enter.click()

    const exit = page.getByRole('button', { name: 'Exit full view' })
    await expect(exit).toBeVisible()
    await expect(rail).toBeHidden()
    await expect
      .poll(() => panel.boundingBox())
      .toEqual({
        x: terminalBounds!.x,
        y: splitBounds!.y,
        width: terminalBounds!.width + splitBounds!.width,
        height: splitBounds!.height
      })

    // Traverse a full keyboard focus cycle; the covered terminal must not
    // become a typing target, regardless of how the overlay is implemented.
    const terminalInput = page.getByRole('textbox', {
      name: 'Terminal input',
      includeHidden: true
    })
    await expect(terminalInput).toHaveCount(1)
    await expect(exit).toBeFocused()
    for (let step = 0; step < 100; step += 1) {
      await page.keyboard.press('Tab')
      await expect(terminalInput).not.toBeFocused()
      // Stop after a full focus cycle; the assertions above run on every step.
      // oxlint-disable-next-line playwright/no-conditional-in-test
      if (await exit.evaluate((button) => button === document.activeElement)) {
        break
      }
    }
    await expect(exit).toBeFocused()
    await page.keyboard.press('Enter')
    await expect.poll(() => panel.boundingBox()).toEqual(splitBounds)
    await expect(terminal).toBeVisible()
    await expect(rail).toBeVisible()

    await rail.hover()
    await enter.hover()
    await expect(tooltip).toHaveText('Enter full view')
    await toggle.click()
    await expect(panel).toBeHidden()
    await toggle.click()
    await expect(enter).toBeVisible()

    await enter.click()
    await toggle.click()
    await expect(panel).toBeHidden()
    await expect(terminal).toBeVisible()
    await toggle.click()
    await expect(enter).toBeVisible()
    await expect.poll(() => panel.boundingBox()).toEqual(splitBounds)

    await enter.click()
    await page
      .getByRole('list', { name: 'main tree terminal tabs' })
      .getByRole('button', { name: /, running$/ })
      .click()
    await expect(enter).toBeVisible()
    await expect(terminal).toBeVisible()

    await enter.click()
    await page.getByRole('button', { name: /^topic(?:,|\s|$)/ }).click()
    await page.getByRole('button', { name: /^main tree(?:,|\s|$)/ }).click()
    await expect(enter).toBeVisible()

    await page.setViewportSize({ width: 700, height: 720 })
    await expect(enter).toBeHidden()
    await expect(rail).toBeHidden()
    await expect(terminal).toBeHidden()
    await expect
      .poll(async () => {
        const bounds = await panel.boundingBox()
        return bounds ? bounds.x + bounds.width : null
      })
      .toBe(page.viewportSize()!.width)
    await page.setViewportSize({ width: 701, height: 720 })
    await expect(enter).toBeVisible()
    await expect(rail).toBeVisible()
  })
})
