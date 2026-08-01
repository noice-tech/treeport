import {
  FileDiff,
  parsePatchFiles
} from 'https://esm.sh/@pierre/diffs@1.3.1?bundle'
import { FileTree } from 'https://esm.sh/@pierre/trees@1.0.0-beta.6?bundle'
import { treeport } from '@treeport/panel-sdk'

const workspace = /** @type {HTMLElement} */ (
  document.querySelector('.workspace')
)
const sidebar = /** @type {HTMLElement} */ (document.querySelector('aside'))
const resizeHandle = /** @type {HTMLElement} */ (
  document.querySelector('#resize-handle')
)
const review = /** @type {HTMLElement} */ (document.querySelector('#review'))
const fileTreeContainer = /** @type {HTMLElement} */ (
  document.querySelector('#file-tree')
)
const summary = /** @type {HTMLElement} */ (document.querySelector('#summary'))
const refresh = /** @type {HTMLButtonElement} */ (
  document.querySelector('#refresh')
)

/** @type {FileDiff[]} */
let renderedDiffs = []
/** @type {FileTree | null} */
let renderedTree = null
/** @type {Map<string, HTMLElement>} */
let fileSections = new Map()

/** @param {number} requestedWidth */
function setSidebarWidth(requestedWidth) {
  const maximumWidth = Math.max(160, workspace.clientWidth - 320)
  const width = Math.round(
    Math.min(maximumWidth, Math.max(160, requestedWidth))
  )
  workspace.style.setProperty('--sidebar-width', `${width}px`)
  resizeHandle.setAttribute('aria-valuenow', String(width))
  resizeHandle.setAttribute('aria-valuemax', String(maximumWidth))
}

resizeHandle.addEventListener('pointerdown', (event) => {
  if (event.button !== 0) {
    return
  }

  resizeHandle.setPointerCapture(event.pointerId)
  resizeHandle.classList.add('resizing')
  document.body.classList.add('resizing')
})
resizeHandle.addEventListener('pointermove', (event) => {
  if (!resizeHandle.hasPointerCapture(event.pointerId)) {
    return
  }

  setSidebarWidth(event.clientX - workspace.getBoundingClientRect().left)
})
resizeHandle.addEventListener('pointerup', (event) => {
  resizeHandle.releasePointerCapture(event.pointerId)
})
resizeHandle.addEventListener('lostpointercapture', () => {
  resizeHandle.classList.remove('resizing')
  document.body.classList.remove('resizing')
})
resizeHandle.addEventListener('keydown', (event) => {
  const currentWidth = sidebar.getBoundingClientRect().width
  if (event.key === 'ArrowLeft') {
    setSidebarWidth(currentWidth - 16)
  } else if (event.key === 'ArrowRight') {
    setSidebarWidth(currentWidth + 16)
  } else if (event.key === 'Home') {
    setSidebarWidth(160)
  } else if (event.key === 'End') {
    setSidebarWidth(Number.POSITIVE_INFINITY)
  } else {
    return
  }

  event.preventDefault()
})
addEventListener('resize', () => {
  setSidebarWidth(sidebar.getBoundingClientRect().width)
})
requestAnimationFrame(() => {
  setSidebarWidth(sidebar.getBoundingClientRect().width)
})

/** @param {string} unified */
function render(unified) {
  review.replaceChildren()

  if (!unified) {
    const empty = document.createElement('p')
    empty.className = 'empty'
    empty.textContent = 'No changes against the default branch merge base.'
    review.append(empty)
    return
  }

  const files = parsePatchFiles(unified).flatMap((patch) => patch.files)
  if (files.length === 0) {
    throw new Error('The worktree diff did not contain any file patches')
  }

  for (const fileDiff of files) {
    const section = document.createElement('section')
    section.className = 'file-diff'
    review.append(section)
    fileSections.set(fileDiff.name, section)

    const renderer = new FileDiff({
      theme: 'pierre-dark',
      diffStyle: 'unified'
    })
    renderer.render({ fileDiff, containerWrapper: section })
    renderedDiffs.push(renderer)
  }

  const gitStatus = files.map((file) => {
    let status = 'modified'
    switch (file.type) {
      case 'new':
        status = 'added'
        break
      case 'deleted':
        status = 'deleted'
        break
      case 'rename-pure':
      case 'rename-changed':
        status = 'renamed'
        break
    }
    return { path: file.name, status }
  })

  renderedTree = new FileTree({
    paths: files.map((file) => file.name),
    gitStatus,
    initialExpansion: 'open',
    flattenEmptyDirectories: true,
    density: 'compact',
    search: true,
    fileTreeSearchMode: 'hide-non-matches',
    onSelectionChange: () => {
      requestAnimationFrame(() => {
        const selectedPath = renderedTree?.getFocusedPath()
        const selectedSection = selectedPath
          ? fileSections.get(selectedPath)
          : undefined
        if (!selectedSection) {
          return
        }

        for (const section of fileSections.values()) {
          section.classList.toggle('selected', section === selectedSection)
        }
        selectedSection.scrollIntoView({ block: 'start' })
      })
    }
  })
  renderedTree.render({ fileTreeContainer })
}

async function load() {
  refresh.disabled = true
  for (const diff of renderedDiffs) {
    diff.cleanUp()
  }
  renderedTree?.cleanUp()
  renderedDiffs = []
  renderedTree = null
  fileSections = new Map()
  fileTreeContainer.replaceChildren()
  review.innerHTML = '<p class="empty">Reading worktree changes…</p>'

  try {
    const [context, diff] = await Promise.all([
      treeport.context(),
      treeport.diff()
    ])
    summary.textContent = `${context.project.name} / ${context.worktree.name} · ${diff.baseRef}`
    render(diff.unified)
  } catch (error) {
    review.innerHTML = ''
    const message = document.createElement('p')
    message.className = 'error'
    message.textContent = error instanceof Error ? error.message : String(error)
    review.append(message)
  } finally {
    refresh.disabled = false
  }
}

refresh.addEventListener('click', load)
void load()
