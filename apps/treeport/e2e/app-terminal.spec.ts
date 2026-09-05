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
      await page.evaluate(() =>
        window.__eventSource.emit(
          'worktree.created',
          JSON.stringify({ projectId: 'proj_1', worktreeId: 'wt_new' })
        )
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
    await page.evaluate(() => window.__lastWs.close())
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
      socket.receive('terminal_error', {
        code: 'ATTACH_FAILED',
        message: 'Terminal unavailable',
        retryable: false
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
})
