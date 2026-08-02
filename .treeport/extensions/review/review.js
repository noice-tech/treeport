import {
  FileDiff,
  parsePatchFiles
} from 'https://esm.sh/@pierre/diffs@1.3.1?bundle'
import { FileTree } from 'https://esm.sh/@pierre/trees@1.0.0-beta.6?bundle'
import { treeport } from '@treeport/panel-sdk'

/**
 * @typedef {object} ReviewComment
 * @property {string} id
 * @property {string} file
 * @property {'additions' | 'deletions'} side
 * @property {number} lineNumber
 * @property {string} body
 * @property {boolean} [draft]
 * @property {string} [originalBody]
 */

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
const copyComments = /** @type {HTMLButtonElement} */ (
  document.querySelector('#copy-comments')
)
const previousComment = /** @type {HTMLButtonElement} */ (
  document.querySelector('#previous-comment')
)
const nextComment = /** @type {HTMLButtonElement} */ (
  document.querySelector('#next-comment')
)
const commentPosition = /** @type {HTMLElement} */ (
  document.querySelector('#comment-position')
)
const commentStatus = /** @type {HTMLElement} */ (
  document.querySelector('#comment-status')
)

/** @type {FileDiff[]} */
let renderedDiffs = []
/** @type {FileTree | null} */
let renderedTree = null
/** @type {Map<string, HTMLElement>} */
let fileSections = new Map()
/** @type {Map<string, FileDiff>} */
let diffRenderers = new Map()
/** @type {ReviewComment[]} */
let comments = []
/** @type {Map<string, HTMLElement>} */
let commentElements = new Map()
/** @type {string | null} */
let activeCommentId = null
let commentSerial = 0

function savedComments() {
  return comments.flatMap((comment) => {
    if (comment.draft && comment.originalBody === undefined) {
      return []
    }

    const { draft: _draft, originalBody, ...saved } = comment
    return [{ ...saved, body: originalBody ?? saved.body }]
  })
}

function updateCommentActions() {
  const saved = savedComments()
  const count = saved.length
  const activeIndex = saved.findIndex(
    (comment) => comment.id === activeCommentId
  )
  if (activeIndex === -1) {
    activeCommentId = null
  }

  previousComment.disabled = count === 0
  nextComment.disabled = count === 0
  commentPosition.textContent =
    activeIndex === -1
      ? `${count} ${count === 1 ? 'comment' : 'comments'}`
      : `${activeIndex + 1} of ${count}`
  copyComments.disabled = count === 0
  copyComments.textContent = `Copy comments (${count})`
}

/** @param {string} file */
function clearCommentSelection(file) {
  requestAnimationFrame(() => {
    diffRenderers.get(file)?.setSelectedLines(null, { notify: false })
  })
}

/** @param {ReviewComment} comment */
function navigateToComment(comment) {
  activeCommentId = comment.id
  updateCommentActions()
  for (const element of commentElements.values()) {
    element.classList.remove('active')
  }

  const section = fileSections.get(comment.file)
  for (const candidate of fileSections.values()) {
    candidate.classList.toggle('selected', candidate === section)
  }
  diffRenderers.get(comment.file)?.setSelectedLines(
    {
      start: comment.lineNumber,
      end: comment.lineNumber,
      side: comment.side,
      endSide: comment.side
    },
    { notify: false }
  )
  requestAnimationFrame(() => {
    const element = commentElements.get(comment.id)
    if (element?.isConnected) {
      element.classList.add('active')
      element.scrollIntoView({ block: 'center' })
    } else {
      section?.scrollIntoView({ block: 'start' })
    }
  })
}

/** @param {number} direction */
function navigateComments(direction) {
  const saved = savedComments()
  if (saved.length === 0) {
    return
  }

  const currentIndex = saved.findIndex(
    (comment) => comment.id === activeCommentId
  )
  const nextIndex =
    currentIndex === -1
      ? direction > 0
        ? 0
        : saved.length - 1
      : (currentIndex + direction + saved.length) % saved.length
  navigateToComment(saved[nextIndex])
}

/** @param {ReviewComment} comment */
function cancelCommentDraft(comment) {
  if (comment.originalBody === undefined) {
    comments = comments.filter((candidate) => candidate.id !== comment.id)
  } else {
    comments = comments.map((candidate) => {
      if (candidate.id !== comment.id) {
        return candidate
      }

      const { originalBody, ...saved } = candidate
      return { ...saved, body: originalBody, draft: false }
    })
  }

  updateCommentActions()
  updateAnnotations(comment.file)
  clearCommentSelection(comment.file)
}

/** @param {string} file */
function updateAnnotations(file) {
  const renderer = diffRenderers.get(file)
  if (!renderer) {
    return
  }

  renderer.setLineAnnotations(
    comments
      .filter((comment) => comment.file === file)
      .map((comment) => ({
        side: comment.side,
        lineNumber: comment.lineNumber,
        metadata: comment
      }))
  )
  renderer.rerender()
}

async function persistComments() {
  try {
    const saved = savedComments()
    if (saved.length === 0) {
      await treeport.storage.delete('review-comments-v1')
      commentStatus.textContent = 'Comments cleared'
      return
    }

    await treeport.storage.set('review-comments-v1', saved)
    commentStatus.textContent = 'Comments saved'
  } catch (error) {
    commentStatus.textContent =
      error instanceof Error
        ? `Could not save: ${error.message}`
        : 'Could not save comments'
  }
}

/** @param {ReviewComment} comment */
function renderComment(comment) {
  const container = document.createElement('div')
  container.className = 'review-comment'
  container.dataset.commentId = comment.id
  container.classList.toggle('active', comment.id === activeCommentId)
  commentElements.set(comment.id, container)

  if (comment.draft) {
    const textarea = document.createElement('textarea')
    textarea.setAttribute(
      'aria-label',
      `Comment on ${comment.file} line ${comment.lineNumber}`
    )
    textarea.placeholder = 'What should change?'
    textarea.value = comment.body

    const actions = document.createElement('div')
    actions.className = 'comment-actions'
    const cancel = document.createElement('button')
    cancel.type = 'button'
    cancel.dataset.commentAction = 'cancel'
    cancel.textContent = 'Cancel'
    const save = document.createElement('button')
    save.type = 'button'
    save.dataset.commentAction = 'save'
    save.textContent = 'Save comment'
    actions.append(cancel, save)
    container.append(textarea, actions)

    requestAnimationFrame(() => textarea.focus())
    return container
  }

  const body = document.createElement('p')
  body.textContent = comment.body
  const actions = document.createElement('div')
  actions.className = 'comment-actions'
  const edit = document.createElement('button')
  edit.type = 'button'
  edit.dataset.commentAction = 'edit'
  edit.textContent = 'Edit'
  const remove = document.createElement('button')
  remove.type = 'button'
  remove.dataset.commentAction = 'delete'
  remove.textContent = 'Delete'
  actions.append(edit, remove)
  container.append(body, actions)
  return container
}

document.addEventListener('click', (event) => {
  const action = event
    .composedPath()
    .find(
      (element) =>
        element instanceof HTMLElement && element.dataset.commentAction
    )
  if (!(action instanceof HTMLElement)) {
    return
  }

  const container = action.closest('.review-comment')
  const comment = comments.find(
    (candidate) => candidate.id === container?.dataset.commentId
  )
  if (!comment) {
    return
  }

  const actionName = action.dataset.commentAction
  if (actionName === 'cancel') {
    cancelCommentDraft(comment)
    return
  }

  if (actionName === 'save') {
    const textarea = container?.querySelector('textarea')
    const body = textarea?.value.trim()
    if (!body) {
      textarea?.focus()
      return
    }

    comments = comments.map((candidate) => {
      if (candidate.id !== comment.id) {
        return candidate
      }

      const { originalBody: _originalBody, ...saved } = candidate
      return { ...saved, body, draft: false }
    })
    activeCommentId = comment.id
  } else if (actionName === 'edit') {
    comments = comments.map((candidate) =>
      candidate.id === comment.id
        ? {
            ...candidate,
            draft: true,
            originalBody: candidate.body
          }
        : candidate
    )
    activeCommentId = comment.id
  } else {
    comments = comments.filter((candidate) => candidate.id !== comment.id)
    if (activeCommentId === comment.id) {
      activeCommentId = null
    }
  }

  updateCommentActions()
  updateAnnotations(comment.file)
  clearCommentSelection(comment.file)
  if (actionName !== 'edit') {
    void persistComments()
  }
})

document.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape') {
    return
  }

  const container = event
    .composedPath()
    .find(
      (element) =>
        element instanceof HTMLElement &&
        element.classList.contains('review-comment')
    )
  const comment = comments.find(
    (candidate) =>
      candidate.id ===
      (container instanceof HTMLElement ? container.dataset.commentId : null)
  )
  if (!comment?.draft) {
    return
  }

  event.preventDefault()
  cancelCommentDraft(comment)
})

previousComment.addEventListener('click', () => {
  navigateComments(-1)
})
nextComment.addEventListener('click', () => {
  navigateComments(1)
})

copyComments.addEventListener('click', () => {
  const output = savedComments()
    .map((comment) => {
      const side = comment.side === 'deletions' ? ' (deleted line)' : ''
      return `${comment.file}:${comment.lineNumber}${side}\n${comment.body}`
    })
    .join('\n\n')
  const textarea = document.createElement('textarea')
  textarea.value = output
  textarea.style.position = 'fixed'
  textarea.style.opacity = '0'
  document.body.append(textarea)
  textarea.select()
  const copied = document.execCommand('copy')
  textarea.remove()
  commentStatus.textContent = copied
    ? `Copied ${savedComments().length} comments`
    : 'Could not copy comments'
})

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
      diffStyle: 'unified',
      enableGutterUtility: true,
      lineHoverHighlight: 'both',
      onGutterUtilityClick: (range) => {
        if (
          comments.some(
            (comment) => comment.file === fileDiff.name && comment.draft
          )
        ) {
          return
        }

        comments.push({
          id: `${Date.now()}-${++commentSerial}`,
          file: fileDiff.name,
          side: range.side,
          lineNumber: range.start,
          body: '',
          draft: true
        })
        updateAnnotations(fileDiff.name)
      },
      renderAnnotation: (annotation) => renderComment(annotation.metadata)
    })
    diffRenderers.set(fileDiff.name, renderer)
    renderer.render({
      fileDiff,
      containerWrapper: section,
      lineAnnotations: comments
        .filter((comment) => comment.file === fileDiff.name)
        .map((comment) => ({
          side: comment.side,
          lineNumber: comment.lineNumber,
          metadata: comment
        }))
    })
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
  diffRenderers = new Map()
  fileTreeContainer.replaceChildren()
  review.innerHTML = '<p class="empty">Reading worktree changes…</p>'

  try {
    const [context, diff, storedComments] = await Promise.all([
      treeport.context(),
      treeport.diff(),
      treeport.storage.get('review-comments-v1')
    ])
    comments = Array.isArray(storedComments)
      ? storedComments.filter(
          (comment) =>
            comment !== null &&
            typeof comment === 'object' &&
            typeof comment.id === 'string' &&
            typeof comment.file === 'string' &&
            (comment.side === 'additions' || comment.side === 'deletions') &&
            Number.isInteger(comment.lineNumber) &&
            comment.lineNumber >= 0 &&
            typeof comment.body === 'string'
        )
      : []
    updateCommentActions()
    commentStatus.textContent = ''
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
