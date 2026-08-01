import {
  FileDiff,
  parsePatchFiles
} from 'https://esm.sh/@pierre/diffs@1.3.1?bundle'
import { treeport } from '@treeport/panel-sdk'

const review = /** @type {HTMLElement} */ (document.querySelector('#review'))
const summary = /** @type {HTMLElement} */ (document.querySelector('#summary'))
const refresh = /** @type {HTMLButtonElement} */ (
  document.querySelector('#refresh')
)

/** @type {FileDiff[]} */
let renderedDiffs = []

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
    const renderer = new FileDiff({
      theme: 'pierre-dark',
      diffStyle: 'unified'
    })
    renderer.render({ fileDiff, containerWrapper: review })
    renderedDiffs.push(renderer)
  }
}

async function load() {
  refresh.disabled = true
  for (const diff of renderedDiffs) {
    diff.cleanUp()
  }
  renderedDiffs = []
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
