import { parsePatchFiles, type FileDiffMetadata } from '@pierre/diffs'
import {
  FileDiff,
  type DiffLineAnnotation,
  type SelectedLineRange
} from '@pierre/diffs/react'
import { FileTree, useFileTree } from '@pierre/trees/react'
import {
  treeport,
  type GitDiffChangeSets
} from '@treeport/panel-sdk'
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent
} from 'react'
import { createRoot } from 'react-dom/client'
import { z } from 'zod'
import './review.css'

type CommentSide = 'additions' | 'deletions'

interface ReviewComment {
  id: string
  file: string
  side: CommentSide
  lineNumber: number
  body: string
  resolved: boolean
  draft?: boolean
  originalBody?: string
}

interface SearchableLine {
  file: string
  side: CommentSide
  lineNumber: number
  text: string
}

interface FindMatch extends SearchableLine {
  start: number
  length: number
}

interface LoadedReview {
  summary: string
  generatedAt: string
  files: FileDiffMetadata[]
  changeSets: GitDiffChangeSets
  searchableLines: SearchableLine[]
}

const COMMENTS_KEY = 'review-comments-v1'
const VIEWED_KEY = 'review-viewed-files-v1'
const DIFF_CSS = `
  [data-diffs-header] { position: sticky; top: -1rem; z-index: 2; }
  [data-change-icon] { width: 0.875rem; height: 0.875rem; }
  ::highlight(review-find-matches) { background: rgb(250 204 21 / 30%); }
  ::highlight(review-find-active) { background: rgb(251 146 60 / 75%); }
`
const TREE_CSS = `
  [data-truncate-marker] { opacity: 0 !important; }
  @container measure (height > calc(1lh + 1px)) {
    [data-truncate-marker] { opacity: 1 !important; }
  }
`

const reviewCommentSchema = z.object({
  id: z.string(),
  file: z.string(),
  side: z.enum(['additions', 'deletions']),
  lineNumber: z.number().int().nonnegative(),
  body: z.string(),
  resolved: z.boolean().optional()
})

const parseReviewComment = z
  .unknown()
  .transform((value): ReviewComment | null => {
    const parsed = reviewCommentSchema.safeParse(value)
    return parsed.success
      ? { ...parsed.data, resolved: parsed.data.resolved ?? false }
      : null
  })
  .parse

function savedComments(comments: ReviewComment[]) {
  return comments.flatMap((comment) => {
    if (comment.draft && comment.originalBody === undefined) {
      return []
    }

    const { draft: _draft, originalBody, ...saved } = comment
    return [{ ...saved, body: originalBody ?? saved.body }]
  })
}

function searchableLinesFor(files: FileDiffMetadata[]) {
  const lines: SearchableLine[] = []
  for (const fileDiff of files) {
    for (const hunk of fileDiff.hunks) {
      let additionLineNumber = hunk.additionStart
      let deletionLineNumber = hunk.deletionStart
      for (const content of hunk.hunkContent) {
        if (content.type === 'context') {
          for (let index = 0; index < content.lines; index += 1) {
            lines.push({
              file: fileDiff.name,
              side: 'additions',
              lineNumber: additionLineNumber + index,
              text:
                fileDiff.additionLines[content.additionLineIndex + index] ?? ''
            })
          }
          additionLineNumber += content.lines
          deletionLineNumber += content.lines
          continue
        }

        for (let index = 0; index < content.deletions; index += 1) {
          lines.push({
            file: fileDiff.name,
            side: 'deletions',
            lineNumber: deletionLineNumber + index,
            text:
              fileDiff.deletionLines[content.deletionLineIndex + index] ?? ''
          })
        }
        for (let index = 0; index < content.additions; index += 1) {
          lines.push({
            file: fileDiff.name,
            side: 'additions',
            lineNumber: additionLineNumber + index,
            text:
              fileDiff.additionLines[content.additionLineIndex + index] ?? ''
          })
        }
        additionLineNumber += content.additions
        deletionLineNumber += content.deletions
      }
    }
  }
  return lines
}

function Chevron({ direction }: { direction: 'up' | 'down' }) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path
        d={
          direction === 'up'
            ? 'm4.5 15.75 7.5-7.5 7.5 7.5'
            : 'm19.5 8.25-7.5 7.5-7.5-7.5'
        }
      />
    </svg>
  )
}

function ChangedFileTree({
  files,
  changeSets,
  onSelect
}: {
  files: FileDiffMetadata[]
  changeSets: GitDiffChangeSets
  onSelect(file: string): void
}) {
  const tree = useMemo(() => {
    const filesByName = new Map(files.map((file) => [file.name, file]))
    const visible = (paths: string[]) =>
      [...new Set(paths)].filter((path) => filesByName.has(path)).sort()
    const branch = visible(changeSets.branch)
    const staged = visible(changeSets.staged)
    const unstaged = visible(changeSets.unstaged)
    const untracked = visible(changeSets.untracked)
    const uncommittedCount = new Set([...staged, ...unstaged, ...untracked])
      .size
    const uncommittedRoot = `Uncommitted Changes (${uncommittedCount})`
    const branchRoot = `Branch Changes (${branch.length})`
    const entries: Array<{
      group: string
      paths: string[]
      untracked: boolean
    }> = [
      {
        group: `${uncommittedRoot}/Staged (${staged.length})`,
        paths: staged,
        untracked: false
      },
      {
        group: `${uncommittedRoot}/Unstaged (${unstaged.length})`,
        paths: unstaged,
        untracked: false
      },
      {
        group: `${uncommittedRoot}/Untracked (${untracked.length})`,
        paths: untracked,
        untracked: true
      },
      { group: branchRoot, paths: branch, untracked: false }
    ]
    const actualPaths = new Map<string, string>()
    const gitStatus: Array<{
      path: string
      status:
        | 'modified'
        | 'added'
        | 'deleted'
        | 'renamed'
        | 'untracked'
    }> = []
    for (const entry of entries) {
      for (const path of entry.paths) {
        const syntheticPath = `${entry.group}/${path}`
        actualPaths.set(syntheticPath, path)
        const file = filesByName.get(path)!
        let status:
          | 'modified'
          | 'added'
          | 'deleted'
          | 'renamed'
          | 'untracked' = entry.untracked ? 'untracked' : 'modified'
        if (!entry.untracked && file.type === 'new') {
          status = 'added'
        } else if (!entry.untracked && file.type === 'deleted') {
          status = 'deleted'
        } else if (
          !entry.untracked &&
          (file.type === 'rename-pure' || file.type === 'rename-changed')
        ) {
          status = 'renamed'
        }

        gitStatus.push({ path: syntheticPath, status })
      }
    }

    const paths = [...actualPaths.keys()]
    const initialExpandedPaths = new Set<string>()
    if (uncommittedCount > 0) {
      for (const path of paths) {
        const segments = path.split('/')
        if (!segments[0]?.startsWith('Uncommitted Changes')) {
          continue
        }

        for (let depth = 1; depth < segments.length; depth += 1) {
          initialExpandedPaths.add(segments.slice(0, depth).join('/'))
        }
      }
    }

    return {
      paths,
      actualPaths,
      gitStatus,
      hasUncommittedChanges: uncommittedCount > 0,
      initialExpandedPaths: [...initialExpandedPaths]
    }
  }, [changeSets, files])
  const { model } = useFileTree({
    paths: tree.paths,
    gitStatus: tree.gitStatus,
    initialExpansion: tree.hasUncommittedChanges ? 'closed' : 'open',
    initialExpandedPaths: tree.initialExpandedPaths,
    flattenEmptyDirectories: false,
    density: 'compact',
    unsafeCSS: TREE_CSS,
    search: true,
    fileTreeSearchMode: 'hide-non-matches',
    sort: (left, right) => {
      const leftRootOrder = left.segments[0]?.startsWith(
        'Uncommitted Changes'
      )
        ? 0
        : 1
      const rightRootOrder = right.segments[0]?.startsWith(
        'Uncommitted Changes'
      )
        ? 0
        : 1
      if (leftRootOrder !== rightRootOrder) {
        return leftRootOrder - rightRootOrder
      }

      if (leftRootOrder === 0) {
        const order = ['Staged', 'Unstaged', 'Untracked']
        const leftGroup = left.segments[1] ?? left.basename
        const rightGroup = right.segments[1] ?? right.basename
        const leftOrder = order.findIndex((name) =>
          leftGroup.startsWith(name)
        )
        const rightOrder = order.findIndex((name) =>
          rightGroup.startsWith(name)
        )
        if (leftOrder !== rightOrder) {
          return leftOrder - rightOrder
        }
      }

      if (left.isDirectory !== right.isDirectory) {
        return left.isDirectory ? -1 : 1
      }

      return left.basename.localeCompare(right.basename)
    },
    onSelectionChange: (selectedPaths) => {
      const selected = selectedPaths.find((path) => tree.actualPaths.has(path))
      const actualPath = selected ? tree.actualPaths.get(selected) : null
      if (actualPath) {
        requestAnimationFrame(() => onSelect(actualPath))
      }
    }
  })

  return <FileTree model={model} />
}

function CommentEditor({
  comment,
  active,
  onCancel,
  onDelete,
  onEdit,
  onResolve,
  onSave,
  onUnresolve
}: {
  comment: ReviewComment
  active: boolean
  onCancel(): void
  onDelete(): void
  onEdit(): void
  onResolve(): void
  onSave(body: string): void
  onUnresolve(): void
}) {
  const [body, setBody] = useState(comment.body)
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  const submit = () => {
    const trimmed = body.trim()
    if (trimmed) {
      onSave(trimmed)
    } else {
      textareaRef.current?.focus()
    }
  }
  const onKeyDown = (event: ReactKeyboardEvent) => {
    if (event.key === 'Escape') {
      event.preventDefault()
      onCancel()
    } else if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
      event.preventDefault()
      submit()
    }
  }

  return (
    <div
      className={`review-comment${active ? ' active' : ''}`}
      data-comment-id={comment.id}
    >
      {comment.resolved ? (
        <div className="resolved-comment">
          <span>Resolved comment</span>
          <button
            type="button"
            aria-label={`Unresolve comment on ${comment.file} line ${comment.lineNumber}`}
            onClick={onUnresolve}
          >
            Unresolve
          </button>
        </div>
      ) : comment.draft ? (
        <>
          <textarea
            ref={textareaRef}
            autoFocus
            aria-label={`Comment on ${comment.file} line ${comment.lineNumber}`}
            placeholder="What should change?"
            value={body}
            onChange={(event) => setBody(event.target.value)}
            onKeyDown={onKeyDown}
          />
          <div className="comment-actions">
            <button type="button" onClick={onCancel}>
              Cancel
            </button>
            <button type="button" onClick={submit}>
              Save comment
            </button>
          </div>
        </>
      ) : (
        <>
          <p>{comment.body}</p>
          <div className="comment-actions">
            <button
              type="button"
              aria-label={`Resolve comment on ${comment.file} line ${comment.lineNumber}`}
              onClick={onResolve}
            >
              Resolve
            </button>
            <button type="button" onClick={onEdit}>
              Edit
            </button>
            <button type="button" onClick={onDelete}>
              Delete
            </button>
          </div>
        </>
      )}
    </div>
  )
}

function ReviewApp() {
  const [loaded, setLoaded] = useState<LoadedReview | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [comments, setComments] = useState<ReviewComment[]>([])
  const commentsRef = useRef(comments)
  commentsRef.current = comments
  const [viewedFiles, setViewedFiles] = useState<Set<string>>(new Set())
  const [collapsedFiles, setCollapsedFiles] = useState<Set<string>>(new Set())
  const collapsedFilesRef = useRef(collapsedFiles)
  collapsedFilesRef.current = collapsedFiles
  const autoCollapsedFiles = useRef<Set<string>>(new Set())
  const fileStateLoaded = useRef(false)
  const [selectedFile, setSelectedFile] = useState<string | null>(null)
  const [selectedLines, setSelectedLines] = useState<{
    file: string
    range: SelectedLineRange
  } | null>(null)
  const [activeCommentId, setActiveCommentId] = useState<string | null>(null)
  const [commentStatus, setCommentStatus] = useState('')
  const commentSerial = useRef(0)
  const [copyFeedback, setCopyFeedback] = useState<string | null>(null)
  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [findOpen, setFindOpen] = useState(false)
  const [findQuery, setFindQuery] = useState('')
  const [activeFindMatch, setActiveFindMatch] = useState(-1)
  const findInputRef = useRef<HTMLInputElement>(null)
  const findReturnFocus = useRef<HTMLElement | null>(null)
  const clearCopyFeedback = useCallback(() => {
    setCopyFeedback(null)
    if (copyTimer.current) {
      clearTimeout(copyTimer.current)
      copyTimer.current = null
    }
  }, [])
  const sectionRefs = useRef(new Map<string, HTMLElement>())
  const workspaceRef = useRef<HTMLDivElement>(null)
  const sidebarRef = useRef<HTMLElement>(null)
  const resizeHandleRef = useRef<HTMLDivElement>(null)

  const files = loaded?.files ?? []
  const fileNames = useMemo(() => files.map((file) => file.name), [files])
  const saved = useMemo(() => savedComments(comments), [comments])
  const unresolved = useMemo(
    () => saved.filter((comment) => !comment.resolved),
    [saved]
  )
  const viewedCount = fileNames.filter((file) => viewedFiles.has(file)).length
  const progress =
    fileNames.length === 0 ? 0 : (viewedCount / fileNames.length) * 100
  const activeCommentIndex = unresolved.findIndex(
    ({ id }) => id === activeCommentId
  )
  const findMatches = useMemo(() => {
    const query = findQuery.toLocaleLowerCase()
    if (!query || !loaded) {
      return []
    }

    return loaded.searchableLines.flatMap((line) => {
      const matches: FindMatch[] = []
      const text = line.text.toLocaleLowerCase()
      let start = text.indexOf(query)
      while (start !== -1) {
        matches.push({ ...line, start, length: query.length })
        start = text.indexOf(query, start + query.length)
      }
      return matches
    })
  }, [findQuery, loaded])

  const persistComments = useCallback(async (next: ReviewComment[]) => {
    const values = savedComments(next)
    const operation = values.length
      ? treeport.storage.set(COMMENTS_KEY, values)
      : treeport.storage.delete(COMMENTS_KEY)
    await operation.catch((reason) => {
      setCommentStatus(
        reason instanceof Error
          ? `Could not save: ${reason.message}`
          : 'Could not save comments'
      )
    })
  }, [])

  const persistViewed = useCallback(async (next: Set<string>) => {
    const operation = next.size
      ? treeport.storage.set(VIEWED_KEY, [...next].sort())
      : treeport.storage.delete(VIEWED_KEY)
    await operation.catch((reason) => {
      setCommentStatus(
        reason instanceof Error
          ? `Could not save: ${reason.message}`
          : 'Could not save viewed files'
      )
    })
  }, [])

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    setLoaded(null)
    setSelectedFile(null)
    setSelectedLines(null)
    setActiveFindMatch(-1)
    try {
      const [context, diff, storedComments, storedViewedFiles] =
        await Promise.all([
          treeport.context(),
          treeport.diff(),
          treeport.storage.get(COMMENTS_KEY),
          treeport.storage.get(VIEWED_KEY)
        ])
      const parsedComments: ReviewComment[] = Array.isArray(storedComments)
        ? storedComments.flatMap((comment): ReviewComment[] => {
            const parsed = parseReviewComment(comment)
            return parsed ? [parsed] : []
          })
        : []
      const parsedViewedFiles = z.array(z.string()).safeParse(storedViewedFiles)
      const parsedViewed = new Set(
        parsedViewedFiles.success ? parsedViewedFiles.data : []
      )
      const parsedFiles = diff.unified
        ? [
            ...new Map(
              parsePatchFiles(diff.unified)
                .flatMap((patch) => patch.files)
                .map((file) => [file.name, file])
            ).values()
          ]
        : []
      if (diff.unified && parsedFiles.length === 0) {
        throw new Error('The tree diff did not contain any file patches')
      }

      clearCopyFeedback()
      setComments(parsedComments)
      setActiveCommentId((current) =>
        parsedComments.some(
          ({ id, resolved }) => id === current && !resolved
        )
          ? current
          : null
      )
      setViewedFiles(parsedViewed)
      const uncommittedFiles = new Set([
        ...diff.changeSets.staged,
        ...diff.changeSets.unstaged,
        ...diff.changeSets.untracked
      ])
      const nextAutoCollapsedFiles = new Set<string>()
      if (uncommittedFiles.size > 0) {
        for (const file of diff.changeSets.branch) {
          if (!uncommittedFiles.has(file)) {
            nextAutoCollapsedFiles.add(file)
          }
        }
      }

      const collapsed = fileStateLoaded.current
        ? new Set(collapsedFilesRef.current)
        : new Set(parsedViewed)
      for (const file of autoCollapsedFiles.current) {
        if (!parsedViewed.has(file)) {
          collapsed.delete(file)
        }
      }
      for (const file of nextAutoCollapsedFiles) {
        collapsed.add(file)
      }
      setCollapsedFiles(collapsed)
      autoCollapsedFiles.current = nextAutoCollapsedFiles
      fileStateLoaded.current = true

      setCommentStatus('')
      setLoaded({
        summary: `${context.project.name} / ${context.worktree.name} · ${diff.baseRef}`,
        generatedAt: diff.generatedAt,
        files: parsedFiles,
        changeSets: diff.changeSets,
        searchableLines: searchableLinesFor(parsedFiles)
      })
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setLoading(false)
    }
  }, [clearCopyFeedback])

  useEffect(() => {
    void load()
  }, [load])

  const setCollapsed = useCallback((file: string, collapsed: boolean) => {
    setCollapsedFiles((current) => {
      const next = new Set(current)
      if (collapsed) {
        next.add(file)
      } else {
        next.delete(file)
      }

      return next
    })
  }, [])

  const selectFile = useCallback((file: string) => {
    setSelectedFile(file)
    sectionRefs.current.get(file)?.scrollIntoView({ block: 'start' })
  }, [])

  const createMatchRange = useCallback((match: FindMatch | undefined) => {
    if (!match) {
      return null
    }

    const section = sectionRefs.current.get(match.file)
    const fileContainer = section?.firstElementChild
    const sideSelector =
      match.side === 'deletions'
        ? '[data-line-type="change-deletion"]'
        : ':not([data-line-type="change-deletion"])'
    const line =
      fileContainer instanceof HTMLElement
        ? fileContainer.shadowRoot?.querySelector(
            `[data-line="${match.lineNumber}"]${sideSelector}`
          )
        : null
    if (!(line instanceof HTMLElement)) {
      return null
    }

    const range = new Range()
    const walker = document.createTreeWalker(line, NodeFilter.SHOW_TEXT)
    let offset = 0
    let startNode: Node | null = null
    let startOffset = 0
    let endNode: Node | null = null
    let endOffset = 0
    while (walker.nextNode()) {
      const node = walker.currentNode
      const length = node.textContent?.length ?? 0
      if (startNode === null && match.start <= offset + length) {
        startNode = node
        startOffset = match.start - offset
      }

      if (match.start + match.length <= offset + length) {
        endNode = node
        endOffset = match.start + match.length - offset
        break
      }

      offset += length
    }
    if (startNode === null || endNode === null) {
      return null
    }

    range.setStart(startNode, startOffset)
    range.setEnd(endNode, endOffset)
    return range
  }, [])

  const updateFindHighlights = useCallback(() => {
    const highlights = CSS.highlights
    if (!highlights) {
      return
    }

    const ranges = findMatches
      .map(createMatchRange)
      .filter((range): range is Range => range !== null)
    highlights.set('review-find-matches', new Highlight(...ranges))
    const activeRange = createMatchRange(findMatches[activeFindMatch])
    if (activeRange) {
      highlights.set('review-find-active', new Highlight(activeRange))
    } else {
      highlights.delete('review-find-active')
    }
  }, [activeFindMatch, createMatchRange, findMatches])

  useEffect(() => {
    if (!findOpen) {
      CSS.highlights?.delete('review-find-matches')
      CSS.highlights?.delete('review-find-active')
      return
    }

    const frame = requestAnimationFrame(updateFindHighlights)
    return () => cancelAnimationFrame(frame)
  }, [collapsedFiles, findOpen, updateFindHighlights])

  const navigateToFindMatch = useCallback(
    (requestedIndex: number) => {
      if (findMatches.length === 0) {
        return
      }

      const index = (requestedIndex + findMatches.length) % findMatches.length
      const match = findMatches[index]!
      setActiveFindMatch(index)
      setCollapsed(match.file, false)
      setSelectedFile(match.file)
      requestAnimationFrame(() => {
        updateFindHighlights()
        const range = createMatchRange(match)
        const line = range?.startContainer.parentElement?.closest('[data-line]')
        if (line instanceof HTMLElement) {
          line.scrollIntoView({ block: 'center' })
        } else {
          sectionRefs.current
            .get(match.file)
            ?.scrollIntoView({ block: 'start' })
        }
      })
    },
    [createMatchRange, findMatches, setCollapsed, updateFindHighlights]
  )

  useEffect(() => {
    setActiveFindMatch(findMatches.length ? 0 : -1)
    if (findMatches.length) {
      const match = findMatches[0]!
      setCollapsed(match.file, false)
      setSelectedFile(match.file)
      requestAnimationFrame(() => {
        const range = createMatchRange(match)
        const line = range?.startContainer.parentElement?.closest('[data-line]')
        if (line instanceof HTMLElement) {
          line.scrollIntoView({ block: 'center' })
        }
      })
    }
  }, [createMatchRange, findMatches, setCollapsed])

  const openFind = useCallback(() => {
    if (!findOpen) {
      findReturnFocus.current =
        document.activeElement instanceof HTMLElement
          ? document.activeElement
          : null
      setFindOpen(true)
    }

    requestAnimationFrame(() => {
      findInputRef.current?.focus()
      findInputRef.current?.select()
    })
  }, [findOpen])
  const closeFind = useCallback(() => {
    setFindOpen(false)
    setActiveFindMatch(-1)
    const returnFocus = findReturnFocus.current
    if (returnFocus?.isConnected) {
      returnFocus.focus()
    }

    findReturnFocus.current = null
  }, [])

  useEffect(() => treeport.shortcuts.onFind(openFind), [openFind])
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && findOpen) {
        event.preventDefault()
        closeFind()
      }
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [closeFind, findOpen])

  const navigateToComment = useCallback(
    (comment: ReviewComment) => {
      setCollapsed(comment.file, false)
      setActiveCommentId(comment.id)
      setSelectedFile(comment.file)
      setSelectedLines({
        file: comment.file,
        range: {
          start: comment.lineNumber,
          end: comment.lineNumber,
          side: comment.side,
          endSide: comment.side
        }
      })
      requestAnimationFrame(() => {
        const element = document.querySelector(
          `[data-comment-id="${CSS.escape(comment.id)}"]`
        )
        if (element instanceof HTMLElement) {
          element.scrollIntoView({ block: 'center' })
        } else {
          sectionRefs.current
            .get(comment.file)
            ?.scrollIntoView({ block: 'start' })
        }
      })
    },
    [setCollapsed]
  )

  const navigateComments = (direction: number) => {
    if (unresolved.length === 0) {
      return
    }

    const current = unresolved.findIndex(({ id }) => id === activeCommentId)
    const index =
      current === -1
        ? direction > 0
          ? 0
          : unresolved.length - 1
        : (current + direction + unresolved.length) % unresolved.length
    navigateToComment(unresolved[index]!)
  }

  const updateComment = (next: ReviewComment[], persist: boolean) => {
    clearCopyFeedback()
    setComments(next)
    if (persist) {
      void persistComments(next)
    }
  }
  const cancelComment = (comment: ReviewComment) => {
    const next =
      comment.originalBody === undefined
        ? commentsRef.current.filter(({ id }) => id !== comment.id)
        : commentsRef.current.map((candidate) => {
            if (candidate.id !== comment.id) {
              return candidate
            }

            const { originalBody, ...rest } = candidate
            return {
              ...rest,
              body: originalBody ?? candidate.body,
              draft: false
            }
          })
    updateComment(next, false)
    setSelectedLines(null)
  }
  const saveComment = (comment: ReviewComment, body: string) => {
    const next = commentsRef.current.map((candidate) => {
      if (candidate.id !== comment.id) {
        return candidate
      }

      const { originalBody: _originalBody, ...rest } = candidate
      return { ...rest, body, draft: false }
    })
    setActiveCommentId(comment.id)
    updateComment(next, true)
    setSelectedLines(null)
  }
  const editComment = (comment: ReviewComment) => {
    const next = commentsRef.current.map((candidate) =>
      candidate.id === comment.id
        ? { ...candidate, draft: true, originalBody: candidate.body }
        : candidate
    )
    setActiveCommentId(comment.id)
    updateComment(next, false)
  }
  const deleteComment = (comment: ReviewComment) => {
    const next = commentsRef.current.filter(({ id }) => id !== comment.id)
    if (activeCommentId === comment.id) {
      setActiveCommentId(null)
    }

    updateComment(next, true)
    setSelectedLines(null)
  }
  const setCommentResolved = (comment: ReviewComment, resolved: boolean) => {
    const next = commentsRef.current.map((candidate) =>
      candidate.id === comment.id ? { ...candidate, resolved } : candidate
    )
    if (resolved && activeCommentId === comment.id) {
      setActiveCommentId(null)
    }

    updateComment(next, true)
  }

  const copy = () => {
    const output = unresolved
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
    setCopyFeedback(
      copied
        ? `Copied ${unresolved.length} ${unresolved.length === 1 ? 'comment' : 'comments'}`
        : 'Could not copy unresolved comments'
    )
    if (copyTimer.current) {
      clearTimeout(copyTimer.current)
    }

    copyTimer.current = setTimeout(() => setCopyFeedback(null), 1_500)
  }

  useEffect(
    () => () => {
      if (copyTimer.current) {
        clearTimeout(copyTimer.current)
      }
    },
    []
  )

  useEffect(() => {
    const workspace = workspaceRef.current
    const sidebar = sidebarRef.current
    const handle = resizeHandleRef.current
    if (!workspace || !sidebar || !handle) {
      return
    }

    const setWidth = (
      requested: number,
      maximum = Math.max(160, workspace.clientWidth - 320)
    ) => {
      const width = Math.round(Math.min(maximum, Math.max(160, requested)))
      workspace.style.setProperty('--sidebar-width', `${width}px`)
      handle.setAttribute('aria-valuenow', String(width))
      handle.setAttribute('aria-valuemax', String(maximum))
    }
    let workspaceLeft = 0
    let maximum = 160
    let pending: number | null = null
    let frame: number | null = null
    const apply = () => {
      if (frame !== null) {
        cancelAnimationFrame(frame)
      }

      frame = null
      if (pending === null) {
        return
      }

      setWidth(pending, maximum)
      pending = null
    }
    const pointerDown = (event: PointerEvent) => {
      if (event.button !== 0) {
        return
      }

      const bounds = workspace.getBoundingClientRect()
      workspaceLeft = bounds.left
      maximum = Math.max(160, bounds.width - 320)
      handle.setPointerCapture(event.pointerId)
      handle.classList.add('resizing')
      document.body.classList.add('resizing')
    }
    const pointerMove = (event: PointerEvent) => {
      if (!handle.hasPointerCapture(event.pointerId)) {
        return
      }

      pending = event.clientX - workspaceLeft
      if (frame === null) {
        frame = requestAnimationFrame(apply)
      }
    }
    const pointerUp = (event: PointerEvent) => {
      pending = event.clientX - workspaceLeft
      apply()
      handle.releasePointerCapture(event.pointerId)
    }
    const lostCapture = () => {
      handle.classList.remove('resizing')
      document.body.classList.remove('resizing')
    }
    const keyDown = (event: KeyboardEvent) => {
      const current = sidebar.getBoundingClientRect().width
      if (event.key === 'ArrowLeft') {
        setWidth(current - 16)
      } else if (event.key === 'ArrowRight') {
        setWidth(current + 16)
      } else if (event.key === 'Home') {
        setWidth(160)
      } else if (event.key === 'End') {
        setWidth(Number.POSITIVE_INFINITY)
      } else {
        return
      }

      event.preventDefault()
    }
    const resize = () => setWidth(sidebar.getBoundingClientRect().width)
    handle.addEventListener('pointerdown', pointerDown)
    handle.addEventListener('pointermove', pointerMove)
    handle.addEventListener('pointerup', pointerUp)
    handle.addEventListener('lostpointercapture', lostCapture)
    handle.addEventListener('keydown', keyDown)
    window.addEventListener('resize', resize)
    requestAnimationFrame(resize)
    return () => {
      handle.removeEventListener('pointerdown', pointerDown)
      handle.removeEventListener('pointermove', pointerMove)
      handle.removeEventListener('pointerup', pointerUp)
      handle.removeEventListener('lostpointercapture', lostCapture)
      handle.removeEventListener('keydown', keyDown)
      window.removeEventListener('resize', resize)
      if (frame !== null) {
        cancelAnimationFrame(frame)
      }
    }
  }, [])

  return (
    <>
      <header>
        <div className="heading">
          <strong>Code review</strong>
          <span id="summary">
            {loaded?.summary ??
              (error ? 'Could not load context' : 'Loading context…')}
          </span>
        </div>
        <div className="actions">
          <div
            id="viewed-progress"
            aria-label={`${viewedCount} of ${fileNames.length} files viewed`}
          >
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <circle className="viewed-progress-track" cx="12" cy="12" r="9" />
              <circle
                id="viewed-progress-value"
                cx="12"
                cy="12"
                r="9"
                pathLength="100"
                style={{ strokeDasharray: `${progress} 100` }}
              />
            </svg>
            <span>
              <strong id="viewed-count">
                {viewedCount} / {fileNames.length}
              </strong>{' '}
              viewed
            </span>
          </div>
          <span id="comment-status" role="status">
            {commentStatus}
          </span>
          <div className="comment-navigation" aria-label="Comment navigation">
            <span id="comment-position">
              {activeCommentIndex === -1
                ? `${unresolved.length} unresolved`
                : `${activeCommentIndex + 1} of ${unresolved.length} unresolved`}
            </span>
            <div className="comment-navigation-buttons">
              <button
                type="button"
                aria-label="Previous unresolved comment"
                title="Previous unresolved comment"
                disabled={!unresolved.length}
                onClick={() => navigateComments(-1)}
              >
                <Chevron direction="up" />
              </button>
              <button
                type="button"
                aria-label="Next unresolved comment"
                title="Next unresolved comment"
                disabled={!unresolved.length}
                onClick={() => navigateComments(1)}
              >
                <Chevron direction="down" />
              </button>
            </div>
          </div>
          <button type="button" disabled={!unresolved.length} onClick={copy}>
            {copyFeedback ?? `Copy unresolved (${unresolved.length})`}
          </button>
          <button type="button" disabled={loading} onClick={() => void load()}>
            Refresh
          </button>
        </div>
        <div
          id="find-bar"
          role="search"
          aria-label="Find in changed lines"
          hidden={!findOpen}
        >
          <input
            ref={findInputRef}
            id="find-input"
            type="search"
            aria-label="Find in changed lines"
            placeholder="Find in changed lines"
            autoComplete="off"
            spellCheck={false}
            value={findQuery}
            onChange={(event) => setFindQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault()
                navigateToFindMatch(activeFindMatch + (event.shiftKey ? -1 : 1))
              }
            }}
          />
          <span id="find-position" role="status">
            {activeFindMatch === -1
              ? `0 of ${findMatches.length}`
              : `${activeFindMatch + 1} of ${findMatches.length}`}
          </span>
          <div className="find-navigation">
            <button
              type="button"
              aria-label="Previous match"
              title="Previous match"
              disabled={!findMatches.length}
              onClick={() => navigateToFindMatch(activeFindMatch - 1)}
            >
              <Chevron direction="up" />
            </button>
            <button
              type="button"
              aria-label="Next match"
              title="Next match"
              disabled={!findMatches.length}
              onClick={() => navigateToFindMatch(activeFindMatch + 1)}
            >
              <Chevron direction="down" />
            </button>
          </div>
          <button
            id="close-find"
            type="button"
            aria-label="Close find"
            title="Close find"
            onClick={closeFind}
          >
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M6 6l12 12M18 6 6 18" />
            </svg>
          </button>
        </div>
      </header>
      <div className="workspace" ref={workspaceRef}>
        <aside aria-label="Changed files" ref={sidebarRef}>
          <div id="file-tree">
            {files.length > 0 && (
              <ChangedFileTree
                key={loaded?.generatedAt}
                files={files}
                changeSets={loaded!.changeSets}
                onSelect={selectFile}
              />
            )}
          </div>
        </aside>
        <div
          id="resize-handle"
          ref={resizeHandleRef}
          role="separator"
          aria-label="Resize changed files"
          aria-orientation="vertical"
          aria-valuemin={160}
          tabIndex={0}
        />
        <main id="review" aria-live="polite">
          {loading ? (
            <p className="empty">Reading tree changes…</p>
          ) : error ? (
            <p className="error">{error}</p>
          ) : files.length === 0 ? (
            <p className="empty">
              No changes against the default branch merge base.
            </p>
          ) : (
            files.map((fileDiff) => {
              const fileComments = comments.filter(
                ({ file }) => file === fileDiff.name
              )
              const annotations: DiffLineAnnotation<ReviewComment>[] =
                fileComments.map((comment) => ({
                  side: comment.side,
                  lineNumber: comment.lineNumber,
                  metadata: comment
                }))
              const collapsed = collapsedFiles.has(fileDiff.name)
              return (
                <section
                  key={fileDiff.name}
                  ref={(element) => {
                    if (element) {
                      sectionRefs.current.set(fileDiff.name, element)
                    } else {
                      sectionRefs.current.delete(fileDiff.name)
                    }
                  }}
                  className={`file-diff${selectedFile === fileDiff.name ? ' selected' : ''}`}
                >
                  <FileDiff<ReviewComment>
                    fileDiff={fileDiff}
                    options={{
                      theme: 'pierre-dark',
                      diffStyle: 'unified',
                      overflow: 'wrap',
                      collapsed,
                      unsafeCSS: DIFF_CSS,
                      enableGutterUtility: true,
                      lineHoverHighlight: 'both',
                      onGutterUtilityClick: (range) => {
                        if (
                          commentsRef.current.some(
                            (comment) =>
                              comment.file === fileDiff.name && comment.draft
                          )
                        ) {
                          return
                        }

                        const next = [
                          ...commentsRef.current,
                          {
                            id: `${Date.now()}-${++commentSerial.current}`,
                            file: fileDiff.name,
                            side: range.side ?? 'additions',
                            lineNumber: range.start,
                            body: '',
                            resolved: false,
                            draft: true
                          } satisfies ReviewComment
                        ]
                        clearCopyFeedback()
                        setComments(next)
                        setSelectedLines({ file: fileDiff.name, range })
                      },
                      onPostRender: () => {
                        if (findOpen) {
                          requestAnimationFrame(updateFindHighlights)
                        }
                      }
                    }}
                    lineAnnotations={annotations}
                    selectedLines={
                      selectedLines?.file === fileDiff.name
                        ? selectedLines.range
                        : null
                    }
                    renderHeaderPrefix={() => (
                      <button
                        type="button"
                        className="file-collapse"
                        aria-label={`${collapsed ? 'Expand' : 'Collapse'} ${fileDiff.name}`}
                        title={`${collapsed ? 'Expand' : 'Collapse'} file`}
                        aria-expanded={!collapsed}
                        onClick={() => setCollapsed(fileDiff.name, !collapsed)}
                      >
                        <svg viewBox="0 0 16 16" aria-hidden="true">
                          <path
                            d={collapsed ? 'm6 3 5 5-5 5' : 'm3 6 5 5 5-5'}
                          />
                        </svg>
                      </button>
                    )}
                    renderHeaderMetadata={() => (
                      <label className="file-viewed">
                        <input
                          type="checkbox"
                          checked={viewedFiles.has(fileDiff.name)}
                          aria-label={`Viewed ${fileDiff.name}`}
                          onChange={(event) => {
                            const checked = event.target.checked
                            const next = new Set(viewedFiles)
                            if (checked) {
                              next.add(fileDiff.name)
                            } else {
                              next.delete(fileDiff.name)
                            }

                            setViewedFiles(next)
                            setCollapsed(fileDiff.name, checked)
                            void persistViewed(next)
                          }}
                        />
                        Viewed
                      </label>
                    )}
                    renderAnnotation={(annotation) => {
                      const comment = annotation.metadata
                      return (
                        <CommentEditor
                          comment={comment}
                          active={comment.id === activeCommentId}
                          onCancel={() => cancelComment(comment)}
                          onDelete={() => deleteComment(comment)}
                          onEdit={() => editComment(comment)}
                          onResolve={() => setCommentResolved(comment, true)}
                          onSave={(body) => saveComment(comment, body)}
                          onUnresolve={() =>
                            setCommentResolved(comment, false)
                          }
                        />
                      )
                    }}
                  />
                </section>
              )
            })
          )}
        </main>
      </div>
    </>
  )
}

createRoot(document.querySelector('#root')!).render(<ReviewApp />)
