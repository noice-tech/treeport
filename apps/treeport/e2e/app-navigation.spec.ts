import { expect, test } from '@playwright/test'
import { mockApp } from './app-fixture'

test.describe('desktop worktree terminal UI', () => {
  test('recovers from an unexpected component crash', async ({ page }) => {
    await page.addInitScript(() => {
      const originalGetItem = Storage.prototype.getItem
      window.__restoreStorageGetItem = () => {
        Storage.prototype.getItem = originalGetItem
      }
      Storage.prototype.getItem = function (key) {
        if (key === 'treeport-last-workspace-route') {
          throw new Error('Unexpected render failure')
        }

        return originalGetItem.call(this, key)
      }
    })
    await mockApp(page)

    const fallback = page.getByRole('alert')
    await expect(
      fallback.getByRole('heading', {
        name: 'Treeport couldn’t display this workspace'
      })
    ).toBeVisible()
    await expect(
      fallback.getByText('your persistent terminal sessions will keep running')
    ).toBeVisible()
    await expect(
      fallback.getByRole('button', { name: 'Reload Treeport' })
    ).toBeVisible()

    await page.evaluate(() => window.__restoreStorageGetItem())
    await fallback.getByRole('button', { name: 'Try again' }).click()
    await expect(
      page.getByRole('button', {
        name: 'Switch project, current project example'
      })
    ).toBeVisible()
  })

  test('recovers project metadata after transient API failures', async ({
    page
  }) => {
    const mocked = await mockApp(page, [], { transientProjectFailures: 2 })
    await expect(
      page.getByRole('button', { name: 'Pi, running', exact: true })
    ).toBeVisible()
    expect(mocked.projectRequests()).toBe(3)
  })

  test('keeps the selected terminal while project metadata loads', async ({
    page
  }) => {
    const pathname = '/projects/proj_1/worktrees/wt_topic/terminals/term_pi'
    const mocked = await mockApp(page, [], {
      initialPath: pathname,
      delayProjects: true
    })

    await expect(page.getByText('Loading repositories…')).toBeVisible()
    await expect(
      page.getByRole('status', { name: 'Loading workspace' })
    ).toBeVisible()
    await expect(page.getByText('Choose a tree.')).toHaveCount(0)
    mocked.releaseProjects()
    await expect(
      page.getByRole('button', {
        name: 'Switch project, current project example'
      })
    ).toBeVisible()
    await expect(
      page
        .getByRole('list', { name: 'topic terminals' })
        .getByRole('button', { name: /^zsh · \/worktrees\/topic,/ })
    ).toBeVisible()
    await expect(page.locator('.xterm-rows')).toContainText(
      'same persistent terminal session'
    )
  })

  test('shows an open project with no worktrees', async ({ page }) => {
    await mockApp(page, [], {
      worktreeFree: true,
      initialPath: '/projects/proj_1'
    })
    await expect(
      page.getByRole('button', {
        name: 'Switch project, current project example'
      })
    ).toBeVisible()
    await expect(page.getByRole('button', { name: 'New tree' })).toBeEnabled()
  })

  test('shows a worktree with no terminals', async ({ page }) => {
    await mockApp(page, [], {
      terminalFree: true,
      initialPath: '/projects/proj_1/worktrees/wt_topic'
    })
    await expect(page.getByText('topic', { exact: true })).toBeVisible()
    await expect(page.getByRole('button', { name: /^New panel/ })).toBeEnabled()
  })

  test('shows a valid terminal when the saved selection no longer exists', async ({
    page
  }) => {
    await mockApp(page, [], {
      initialPath: '/projects/missing/worktrees/missing/terminals/missing'
    })

    await expect(
      page.getByRole('button', {
        name: 'Switch project, current project example'
      })
    ).toBeVisible()
    await expect(page.locator('.xterm-helper-textarea')).toBeFocused()
    await expect(page.locator('.xterm-rows')).toContainText(
      'same persistent terminal session'
    )
  })

  test('navigates and persists a desktop workspace', async ({ page }) => {
    await mockApp(page, [], { includeSecondProject: true })
    await expect(
      page.getByRole('button', {
        name: 'Switch project, current project example'
      })
    ).toBeVisible()
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            (window.__wsInstances ?? []).filter(
              (socket: { namespace: string; readyState: number }) =>
                socket.namespace === '/events' && socket.readyState === 1
            ).length
        )
      )
      .toBe(1)
    await expect(page.getByText('topic', { exact: true })).toBeVisible()
    await expect(
      page.getByRole('button', { name: /^(main tree|topic)$/ })
    ).toHaveText(['main tree', 'topic'])

    await page.getByRole('button', { name: 'Pi, running', exact: true }).click()
    await expect(page.locator('.xterm')).toBeVisible()
    await expect(page.locator('.xterm-helper-textarea')).toBeFocused()
    await expect(page.locator('.xterm-rows')).toContainText(
      'same persistent terminal session'
    )
    await expect(
      page
        .getByRole('button', {
          name: 'zsh · /worktrees/topic, running',
          exact: true
        })
        .last()
    ).toBeVisible()
    const shortcutModifier = await page.evaluate(() =>
      /Mac|iPhone|iPad|iPod/.test(navigator.platform) ? 'Meta' : 'Control'
    )
    await page.keyboard.press(`${shortcutModifier}+Shift+P`)
    const search = page.getByLabel('Search projects')
    await expect(search).toBeFocused()
    await search.fill('missing')
    await expect(page.getByText('No open projects found.')).toBeVisible()
    await search.fill('example')
    await expect(
      page.getByRole('button', { name: 'example', exact: true })
    ).toBeVisible()

    await page.locator('.xterm-screen').click()
    await expect(search).toHaveCount(0)
    await expect(page.locator('.xterm-helper-textarea')).toBeFocused()
    const switcher = page.getByRole('button', {
      name: 'Switch project, current project example'
    })
    await expect(page.getByText('topic', { exact: true })).toBeVisible()

    await switcher.click()
    const projectSearch = page.getByLabel('Search projects')
    await projectSearch.fill('another')
    await projectSearch.press('Enter')

    await expect(
      page.getByRole('button', {
        name: 'Switch project, current project another-project'
      })
    ).toBeVisible()
    await expect(page.getByText('topic', { exact: true })).toHaveCount(0)
    await expect(page.getByText('another topic', { exact: true })).toBeVisible()
    await expect(page.locator('.xterm-helper-textarea')).toBeFocused()

    await page
      .getByRole('button', {
        name: 'Switch project, current project another-project'
      })
      .click()
    await expect(page.getByLabel('Search projects')).toHaveValue('')

    await page.reload()
    await expect(
      page.getByRole('button', {
        name: 'Switch project, current project another-project'
      })
    ).toBeVisible()
    await expect(page.getByText('another topic', { exact: true })).toBeVisible()

    await page
      .getByRole('button', {
        name: 'Switch project, current project another-project'
      })
      .click()
    await page.getByRole('button', { name: 'example', exact: true }).click()
    await expect(page.getByText('topic', { exact: true })).toBeVisible()
    await expect(page.locator('.xterm-rows')).toContainText(
      'same persistent terminal session'
    )
    await expect(page.locator('.xterm-helper-textarea')).toBeFocused()

    await page
      .getByRole('button', {
        name: 'Switch project, current project example'
      })
      .click()
    const projectOption = page
      .getByRole('listitem')
      .filter({ hasText: 'example' })
    await projectOption.hover()
    page.once('dialog', (dialog) => dialog.accept())
    await page.getByRole('button', { name: 'Close project example' }).click()
    await expect(
      page.getByRole('button', {
        name: 'Switch project, current project another-project'
      })
    ).toBeVisible()
  })
  test('selects a remaining worktree after authoritative removal', async ({
    page
  }) => {
    const mocked = await mockApp(page, [], {
      initialPath: '/projects/proj_1/worktrees/wt_topic/terminals/term_pi'
    })
    const topicWorktree = page
      .getByRole('navigation', { name: 'Projects and trees' })
      .getByRole('button', { name: /^topic(?:,|$)/ })
    await expect(topicWorktree).toBeVisible()

    mocked.state.worktrees.splice(1, 1)
    const projectRefresh = page.waitForResponse(
      (response) =>
        response.request().method() === 'GET' &&
        new URL(response.url()).pathname === '/api/projects'
    )
    await page.evaluate(() => window.__eventSource.emit('worktree.removed'))
    await projectRefresh

    await expect(topicWorktree).toHaveCount(0)
    await expect(
      page.getByRole('button', { name: 'main tree', exact: true })
    ).toBeVisible()
    await expect(page.locator('.xterm-rows')).toContainText(
      'same persistent terminal session'
    )
  })

  test('opens and closes a project across its full lifecycle', async ({
    page
  }) => {
    const mocked = await mockApp(page, [], { startClosed: true })
    await expect(
      page.getByText('Open a Git repository to begin.')
    ).toBeVisible()

    await page.getByRole('button', { name: 'Open project' }).click()
    await expect(page.getByText('Recent projects')).toBeVisible()
    await expect(page.getByText('/repo')).toHaveCount(0)
    await page.getByRole('button', { name: 'example', exact: true }).click()
    await expect(
      page.getByRole('button', {
        name: 'Switch project, current project example'
      })
    ).toBeVisible()
    await expect(page.locator('.xterm-helper-textarea')).toBeFocused()

    await page
      .getByRole('button', {
        name: 'Switch project, current project example'
      })
      .click()
    await expect(page.getByText('Recent projects')).toHaveCount(0)
    await expect(page.getByText('Closed projects appear here.')).toHaveCount(0)

    const openSwitcher = () =>
      page
        .getByRole('button', {
          name: 'Switch project, current project example'
        })
        .click()
    const closeProject = async () => {
      const projectOption = page.getByRole('listitem').filter({
        has: page.getByRole('button', { name: 'Close project example' })
      })

      if (!(await projectOption.isVisible())) {
        await openSwitcher()
      }

      await projectOption.hover()
      await page.getByRole('button', { name: 'Close project example' }).click()
    }
    page.once('dialog', async (dialog) => {
      expect(dialog.message()).toContain('2 Treeport terminal sessions')
      expect(dialog.message()).toContain('Recent projects')
      await dialog.dismiss()
    })
    await closeProject()
    expect(mocked.closeRequests()).toBe(0)

    mocked.failNextClose()
    page.once('dialog', (dialog) => dialog.accept())
    await closeProject()
    await expect(
      page.getByText('Couldn’t close project “example”', { exact: true })
    ).toBeVisible()
    await expect(
      page.getByText(/Some terminal sessions could not be stopped/)
    ).toBeVisible()
    await expect(
      page.getByRole('button', {
        name: 'Switch project, current project example'
      })
    ).toBeVisible()

    page.once('dialog', (dialog) => dialog.accept())
    await closeProject()
    await expect(
      page.getByRole('button', { name: 'Open project' })
    ).toBeFocused()
    expect(mocked.closeRequests()).toBe(2)
    await expect
      .poll(() =>
        page.evaluate(() =>
          (window.__wsInstances ?? [])
            .filter((socket: WebSocket) =>
              socket.url.includes('/api/terminals/')
            )
            .every((socket: WebSocket) => socket.readyState === 3)
        )
      )
      .toBe(true)

    await page.getByRole('button', { name: 'Open project' }).click()
    await page.getByRole('button', { name: 'Open project…' }).click()
    const dialog = page.getByRole('dialog', { name: 'Open project' })
    const serverPath = dialog.getByLabel('Server folder path')
    const openButton = dialog.getByRole('button', { name: 'Open project' })
    await expect(
      dialog.getByText('Browse folders on the Treeport server.')
    ).toBeVisible()
    await expect(openButton).toBeDisabled()

    await serverPath.fill('/home/test/Pro')
    await expect(
      dialog.getByText('Choose a matching folder to continue.')
    ).toBeVisible()
    await serverPath.press('ArrowDown')
    const projectsFolder = dialog.getByRole('button', {
      name: 'Projects',
      exact: true
    })
    await expect(projectsFolder).toBeFocused()
    await projectsFolder.press('Enter')
    await expect(serverPath).toHaveValue('/home/test/Projects')
    await expect(serverPath).toBeFocused()
    await expect(
      dialog.getByText('This folder is not inside a Git repository.')
    ).toBeVisible()
    await expect(openButton).toBeDisabled()

    await dialog.getByRole('button', { name: 'example', exact: true }).click()
    const selectedPath = '/home/test/Projects/example'
    await expect(serverPath).toHaveValue(selectedPath)
    await expect(serverPath).toBeFocused()
    await expect(serverPath).toHaveJSProperty(
      'selectionStart',
      selectedPath.length
    )
    await expect(serverPath).toHaveJSProperty(
      'selectionEnd',
      selectedPath.length
    )

    await serverPath.fill('/repo')
    await serverPath.press('ArrowDown')
    await expect(serverPath).toBeFocused()
    await expect(openButton).toBeDisabled()
    await expect(dialog.getByText('Will open repository: /repo')).toBeVisible()

    const showHidden = dialog.getByLabel('Show hidden folders')
    await showHidden.check()
    await expect(openButton).toBeEnabled()
    mocked.failNextDirectoryBrowse()
    await showHidden.uncheck()
    await expect(dialog.getByRole('alert')).toContainText(
      'That folder cannot be read on the Treeport server'
    )
    await expect(openButton).toBeDisabled()

    await dialog.getByRole('button', { name: 'Retry' }).click()
    await expect(dialog.getByText('Will open repository: /repo')).toBeVisible()
    const releaseProjectsRefresh = mocked.delayNextProjects()
    await serverPath.press('Enter')
    await expect(dialog.getByRole('button', { name: 'Opening…' })).toBeVisible()
    releaseProjectsRefresh()
    await expect(dialog).toHaveCount(0)
    expect(mocked.registeredProjectPaths()).toEqual(['/repo'])
    await expect(
      page.getByRole('button', {
        name: 'Switch project, current project example'
      })
    ).toBeVisible()

    let confirmationShown = false
    page.on('dialog', async (confirmation) => {
      confirmationShown = true
      await confirmation.dismiss()
    })
    await closeProject()
    await expect(
      page.getByRole('button', { name: 'Open project' })
    ).toBeVisible()
    expect(confirmationShown).toBe(false)
    expect(mocked.closeRequests()).toBe(3)

    await page.getByRole('button', { name: 'Open project' }).click()
    const recentProjectOption = page.getByRole('listitem').filter({
      has: page.getByRole('button', {
        name: 'Remove recent project example'
      })
    })
    await recentProjectOption.hover()
    await page
      .getByRole('button', { name: 'Remove recent project example' })
      .click()
    await expect(
      page.getByRole('button', { name: 'example', exact: true })
    ).toHaveCount(0)
    expect(mocked.dismissRecentProjectRequests()).toBe(1)
  })
})
