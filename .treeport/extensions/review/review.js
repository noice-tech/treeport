import { treeport } from '/api/web-panel-sdk/v1.js'

const review = document.querySelector('#review')
const summary = document.querySelector('#summary')
const refresh = document.querySelector('#refresh')

function render(unified) {
  review.replaceChildren()
  if (!unified) {
    const empty = document.createElement('p')
    empty.className = 'empty'
    empty.textContent = 'No changes against the default branch merge base.'
    review.append(empty)
    return
  }
  let section
  for (const line of unified.split('\n')) {
    if (line.startsWith('diff --git ')) {
      section = document.createElement('section')
      section.className = 'file'
      const heading = document.createElement('h2')
      heading.textContent = line
        .replace(/^diff --git a\//, '')
        .replace(/ b\//, ' → ')
      section.append(heading)
      const pre = document.createElement('pre')
      section.append(pre)
      review.append(section)
    }
    if (!section) continue
    const row = document.createElement('span')
    row.className = `line ${
      line.startsWith('+') && !line.startsWith('+++')
        ? 'add'
        : line.startsWith('-') && !line.startsWith('---')
          ? 'del'
          : line.startsWith('@@')
            ? 'hunk'
            : line.startsWith('diff ') || line.startsWith('index ')
              ? 'meta'
              : ''
    }`
    row.textContent = line || ' '
    section.querySelector('pre').append(row)
  }
}

async function load() {
  refresh.disabled = true
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
load()
