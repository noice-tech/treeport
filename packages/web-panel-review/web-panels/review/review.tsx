import { Dialog as Sheet } from '@base-ui/react/dialog'
import {
  ChevronDownIcon,
  ChevronUpIcon,
  ClipboardDocumentIcon,
  FolderIcon,
  ViewColumnsIcon,
  XMarkIcon
} from '@heroicons/react/16/solid'
import { parsePatchFiles, type FileDiffMetadata } from '@pierre/diffs'
import {
  FileDiff,
  type DiffLineAnnotation,
  type SelectedLineRange
} from '@pierre/diffs/react'
import type { FileTreeDirectoryHandle } from '@pierre/trees'
import { FileTree, useFileTree } from '@pierre/trees/react'
import {
  treeport,
  type GitDiff,
  type GitDiffFile,
  type GitDiffImage
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
  fileId: string
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

interface ReviewFile extends GitDiffFile {
  id: string
  scope: 'uncommitted' | 'committed'
  beforeCommit: string
  afterCommit: string | null
  diff: FileDiffMetadata | null
  loadState: 'idle' | 'loading' | 'ready' | 'oversized' | 'error'
  revision: string | null
  message: string | null
}

interface LoadedReview {
  summary: string
  generatedAt: string
  files: ReviewFile[]
  searchableLines: SearchableLine[]
}

const COMMENTS_KEY = 'review-comments-v1'
const VIEWED_KEY = 'review-viewed-files-v1'
// ponytail: Unfocused panels stay stale, and focused panels can lag two seconds.
// Add a host diff-change event when either limit matters.
const AUTO_REFRESH_INTERVAL_MS = 2_000
// Document styles don't reach the diff/tree shadow roots. Keep their native
// control behavior aligned without disabling selection or zoom on content.
const NATIVE_CONTROL_CSS = `
  button, [role="button"], [role="treeitem"] {
    touch-action: manipulation;
    -webkit-user-select: none;
    user-select: none;
    -webkit-touch-callout: none;
  }
  :is(button, [role="button"], [role="treeitem"]) :is(span, svg) {
    -webkit-user-select: none;
    user-select: none;
    -webkit-touch-callout: none;
  }
  @media (any-pointer: coarse) {
    input, textarea, select { font-size: max(1rem, 16px) !important; }
    button, [role="button"], [role="treeitem"] {
      transition: opacity 100ms ease-out;
    }
    :is(button, [role="button"], [role="treeitem"]):active:not(:disabled, [aria-disabled="true"]) {
      opacity: 0.7;
    }
  }
`
const DIFF_CSS = `
  ${NATIVE_CONTROL_CSS}
  [data-diffs-header] { position: sticky; top: calc(var(--review-group-header-height) - var(--review-scroll-padding)); z-index: 2; }
  [data-change-icon] { width: 0.875rem; height: 0.875rem; }
  @media (max-width: 700px) {
    :host { --diffs-gap-inline: 4px; --diffs-gap-block: 4px; }
    [data-diffs-header] { padding-inline: 0.5rem; }
    [data-header-content] { flex: 1; }
    [data-metadata] { flex-shrink: 0; }
  }
  /* Undo the library's ungated hover on inputs that can't hover precisely. */
  @media not all and (hover: hover) and (pointer: fine) {
    [data-expand-index] [data-separator-content]:hover { text-decoration: none; }
    [data-expand-button]:hover { color: var(--diffs-fg-number); }
  }
  ::highlight(review-find-matches) { background: rgb(250 204 21 / 30%); }
  ::highlight(review-find-active) { background: rgb(251 146 60 / 75%); }
`
const TREE_CSS = `
  ${NATIVE_CONTROL_CSS}
  /* Contain scrolling inside the library's actual shadow-root scroller. */
  [data-file-tree-virtualized-scroll="true"] { overscroll-behavior: contain; }
  @media not all and (hover: hover) and (pointer: fine) {
    /* Keep real selection/context/drag states, but don't retain a tap's hover. */
    [data-type="item"]:hover:not([data-item-selected="true"]):not([data-item-context-hover="true"]):not([data-item-drag-target="true"]) {
      background-color: var(--trees-bg);
      --truncate-marker-background-overlay-color: transparent;
    }
    [data-item-flattened-subitem]:hover:not([data-item-flattened-subitem-drag-target="true"]) {
      text-decoration: none;
    }
    [data-type="context-menu-trigger"]:hover:not([aria-expanded="true"]) {
      color: var(--trees-fg-muted);
    }
    :host(:hover) [data-item-section="spacing-item"] { opacity: 0; }
  }
  [data-truncate-marker] { opacity: 0 !important; }
  @container measure (height > calc(1lh + 1px)) {
    [data-truncate-marker] { opacity: 1 !important; }
  }
`

const reviewCommentSchema = z.object({
  id: z.string(),
  file: z.string(),
  fileId: z.string().optional(),
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
      ? {
          ...parsed.data,
          fileId: parsed.data.fileId ?? parsed.data.file,
          resolved: parsed.data.resolved ?? false
        }
      : null
  }).parse

function savedComments(comments: ReviewComment[]) {
  return comments.flatMap((comment) => {
    if (comment.draft && comment.originalBody === undefined) {
      return []
    }

    const { draft: _draft, originalBody, ...saved } = comment
    return [{ ...saved, body: originalBody ?? saved.body }]
  })
}

function searchableLinesFor(files: ReviewFile[]) {
  const lines: SearchableLine[] = []
  for (const file of files) {
    const fileDiff = file.diff
    if (!fileDiff) {
      continue
    }

    for (const hunk of fileDiff.hunks) {
      let additionLineNumber = hunk.additionStart
      let deletionLineNumber = hunk.deletionStart
      for (const content of hunk.hunkContent) {
        if (content.type === 'context') {
          for (let index = 0; index < content.lines; index += 1) {
            lines.push({
              file: file.id,
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
            file: file.id,
            side: 'deletions',
            lineNumber: deletionLineNumber + index,
            text:
              fileDiff.deletionLines[content.deletionLineIndex + index] ?? ''
          })
        }
        for (let index = 0; index < content.additions; index += 1) {
          lines.push({
            file: file.id,
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
  const Icon = direction === 'up' ? ChevronUpIcon : ChevronDownIcon
  return <Icon aria-hidden="true" />
}

function ChangedFileTree({
  files,
  onSelect
}: {
  files: ReviewFile[]
  onSelect(file: string): void
}) {
  const tree = useMemo(() => {
    const uncommittedRoot = 'Uncommitted changes'
    const committedRoot = 'Committed changes'
    const uncommitted = files.filter((file) => file.scope === 'uncommitted')
    const committed = files.filter((file) => file.scope === 'committed')
    const uncommittedCount = uncommitted.length
    const counts = new Map([
      [uncommittedRoot, uncommittedCount],
      [committedRoot, committed.length]
    ])
    const entries = [
      { group: uncommittedRoot, files: uncommitted },
      { group: committedRoot, files: committed }
    ]
    const actualPaths = new Map<string, string>()
    const gitStatus: Array<{
      path: string
      status: 'modified' | 'added' | 'deleted' | 'renamed' | 'untracked'
    }> = []
    for (const entry of entries) {
      for (const file of entry.files) {
        const path = file.path
        const syntheticPath = `${entry.group}/${path}`
        actualPaths.set(syntheticPath, file.id)
        gitStatus.push({ path: syntheticPath, status: file.status })
      }
    }

    const paths = [...actualPaths.keys()]
    const directories = new Set<string>()
    const initialExpandedPaths = new Set<string>()
    for (const path of paths) {
      const segments = path.split('/')
      for (let depth = 1; depth < segments.length; depth += 1) {
        const directory = segments.slice(0, depth).join('/')
        directories.add(directory)
        if (uncommittedCount === 0 || segments[0] === uncommittedRoot) {
          initialExpandedPaths.add(directory)
        }
      }
    }

    return {
      paths,
      actualPaths,
      gitStatus,
      counts,
      directories,
      initialExpandedPaths: [...initialExpandedPaths]
    }
  }, [files])
  // useFileTree captures options once; callbacks must read the current data.
  const current = useRef({ tree, onSelect })
  current.current = { tree, onSelect }
  const previousTree = useRef(tree)
  const { model } = useFileTree({
    paths: tree.paths,
    gitStatus: tree.gitStatus,
    initialExpansion: 'closed',
    initialExpandedPaths: tree.initialExpandedPaths,
    flattenEmptyDirectories: false,
    density: 'compact',
    unsafeCSS: TREE_CSS,
    search: true,
    fileTreeSearchMode: 'hide-non-matches',
    sort: (left, right) => {
      const leftRootOrder = left.segments[0]?.startsWith('Uncommitted changes')
        ? 0
        : 1
      const rightRootOrder = right.segments[0]?.startsWith(
        'Uncommitted changes'
      )
        ? 0
        : 1
      if (leftRootOrder !== rightRootOrder) {
        return leftRootOrder - rightRootOrder
      }

      if (left.isDirectory !== right.isDirectory) {
        return left.isDirectory ? -1 : 1
      }

      return left.basename.localeCompare(right.basename)
    },
    renderRowDecoration: ({ row }) => {
      const count = current.current.tree.counts.get(row.path)
      return count === undefined ? null : { text: `(${count})` }
    },
    onSelectionChange: (selectedPaths) => {
      const { tree, onSelect } = current.current
      const selected = selectedPaths.find((path) => tree.actualPaths.has(path))
      const actualPath = selected ? tree.actualPaths.get(selected) : null
      if (actualPath) {
        requestAnimationFrame(() => onSelect(actualPath))
      }
    }
  })

  useEffect(() => {
    const previous = previousTree.current
    if (
      previous.paths.length !== tree.paths.length ||
      previous.paths.some((path, index) => path !== tree.paths[index])
    ) {
      // Include hidden directories so closing a parent doesn't lose its
      // children's expansion state. Defaults apply only to new directories.
      const collapsedPaths: string[] = []
      const expandedPaths = [...tree.directories].filter((path) => {
        const item = model.getItem(path)
        // SAFETY: isDirectory() checks that the handle has directory methods.
        const expanded = item?.isDirectory()
          ? (item as FileTreeDirectoryHandle).isExpanded()
          : tree.initialExpandedPaths.includes(path)
        if (!expanded) {
          collapsedPaths.push(path)
        }

        return expanded
      })
      model.resetPaths(tree.paths, { initialExpandedPaths: expandedPaths })
      // resetPaths expands ancestors of expanded children; restore closed
      // parents without changing those children's remembered state.
      for (const path of collapsedPaths) {
        const item = model.getItem(path)
        if (item?.isDirectory()) {
          // SAFETY: isDirectory() checks that this is a directory handle.
          const directory = item as FileTreeDirectoryHandle
          directory.collapse()
        }
      }
    }

    model.setGitStatus(tree.gitStatus)

    previousTree.current = tree
  }, [model, tree])

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

  useEffect(() => {
    // React's autofocus runs before the diff's layout effect adds the
    // annotation slot, when this textarea isn't visible or focusable yet.
    textareaRef.current?.focus()
  }, [comment.draft, comment.resolved])

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

function ImagePreview({
  path,
  commit,
  label
}: {
  path: string
  commit: string | null
  label: string
}) {
  const container = useRef<HTMLElement>(null)
  const [result, setResult] = useState<{
    image: GitDiffImage | null
    error: string | null
  }>({ image: null, error: null })
  const [dimensions, setDimensions] = useState<string | null>(null)

  useEffect(() => {
    let active = true
    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries.some((entry) => entry.isIntersecting)) {
          return
        }

        observer.disconnect()
        void treeport.diffImage({ path, commit }).then(
          (image) => {
            if (active) {
              setResult({ image, error: null })
            }
          },
          (reason) => {
            if (active) {
              setResult({
                image: null,
                error:
                  reason instanceof Error ? reason.message : 'Could not read image'
              })
            }
          }
        )
      },
      { rootMargin: '300px' }
    )
    if (container.current) {
      observer.observe(container.current)
    }

    return () => {
      active = false
      observer.disconnect()
    }
  }, [commit, path])

  return (
    <figure className="image-preview" ref={container}>
      <figcaption>
        <strong>{label}</strong>
        {result.image && (
          <span>
            {dimensions ? `${dimensions} · ` : ''}
            {(result.image.byteLength / 1024).toFixed(1)} KiB
          </span>
        )}
      </figcaption>
      <div className="image-preview-canvas">
        {result.error ? (
          <p role="status">Preview unavailable: {result.error}</p>
        ) : result.image ? (
          <img
            src={result.image.dataUrl}
            alt={`${label}: ${path}`}
            decoding="async"
            onLoad={(event) =>
              setDimensions(
                `${event.currentTarget.naturalWidth} × ${event.currentTarget.naturalHeight}`
              )
            }
            onError={() =>
              setResult({
                image: null,
                error: 'The browser could not decode this image'
              })
            }
          />
        ) : (
          <p role="status">Loading image…</p>
        )}
      </div>
    </figure>
  )
}

function ReviewApp() {
  const [loaded, setLoaded] = useState<LoadedReview | null>(null)
  const loadedRef = useRef(loaded)
  loadedRef.current = loaded
  const loadedDiff = useRef<{
    uncommitted: GitDiff
    committed: GitDiff
  } | null>(null)
  const loadPending = useRef(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [comments, setComments] = useState<ReviewComment[]>([])
  const commentsRef = useRef(comments)
  commentsRef.current = comments
  const [viewedFiles, setViewedFiles] = useState<Set<string>>(new Set())
  const viewedFilesRef = useRef(viewedFiles)
  viewedFilesRef.current = viewedFiles
  const [imageSources, setImageSources] = useState<Set<string>>(new Set())
  const [collapsedFiles, setCollapsedFiles] = useState<Set<string>>(new Set())
  const collapsedFilesRef = useRef(collapsedFiles)
  collapsedFilesRef.current = collapsedFiles
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
  const [diffStyle, setDiffStyle] = useState<'unified' | 'split'>('unified')
  const [fileTreeOpen, setFileTreeOpen] = useState(false)
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

  const files = loaded?.files ?? []
  const fileGroups = useMemo(
    () =>
      [
        {
          id: 'uncommitted',
          label: 'Uncommitted changes',
          files: files.filter((file) => file.scope === 'uncommitted')
        },
        {
          id: 'committed',
          label: 'Committed changes',
          files: files.filter((file) => file.scope === 'committed')
        }
      ].filter((group) => group.files.length > 0),
    [files]
  )
  const fileNames = useMemo(() => files.map((file) => file.id), [files])
  const lineCounts = useMemo(
    () =>
      files.reduce(
        (counts, file) => {
          for (const hunk of file.diff?.hunks ?? []) {
            counts.additions += hunk.additionLines
            counts.deletions += hunk.deletionLines
          }
          return counts
        },
        { additions: 0, deletions: 0 }
      ),
    [files]
  )
  const saved = useMemo(() => savedComments(comments), [comments])
  const unresolved = useMemo(
    () => saved.filter((comment) => !comment.resolved),
    [saved]
  )
  const commentLocations = useMemo(
    () =>
      new Set(
        loaded?.searchableLines.map(({ file, side, lineNumber }) =>
          JSON.stringify([file, side, lineNumber])
        ) ?? []
      ),
    [loaded]
  )
  const loadedFileNames = useMemo(
    () =>
      new Set(
        files
          .filter(({ loadState }) => loadState === 'ready')
          .map(({ id }) => id)
      ),
    [files]
  )
  const outdatedComments = useMemo(
    () =>
      loaded
        ? unresolved.filter(
            ({ fileId, side, lineNumber }) =>
              !fileNames.includes(fileId) ||
              (loadedFileNames.has(fileId) &&
                !commentLocations.has(
                  JSON.stringify([fileId, side, lineNumber])
                ))
          )
        : [],
    [commentLocations, fileNames, loaded, loadedFileNames, unresolved]
  )
  const navigableComments = useMemo(
    () =>
      outdatedComments.length
        ? unresolved.filter(({ fileId, side, lineNumber }) =>
            commentLocations.has(JSON.stringify([fileId, side, lineNumber]))
          )
        : unresolved,
    [commentLocations, outdatedComments.length, unresolved]
  )
  const viewedCount = fileNames.filter((file) => viewedFiles.has(file)).length
  const activeCommentIndex = navigableComments.findIndex(
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
    if (loadPending.current) {
      return
    }

    loadPending.current = true
    const initial = loadedRef.current === null
    if (initial) {
      setLoading(true)
    }

    setError(null)
    try {
      const [
        context,
        uncommitted,
        committed,
        storedComments,
        storedViewedFiles
      ] = await Promise.all([
        initial ? treeport.context() : null,
        treeport.diff({ scope: 'uncommitted' }),
        treeport.diff({ scope: 'committed' }),
        initial ? treeport.storage.get(COMMENTS_KEY) : null,
        initial ? treeport.storage.get(VIEWED_KEY) : null
      ])
      if (uncommitted.headCommit !== committed.headCommit) {
        throw new Error('HEAD changed while reading the review. Retrying…')
      }

      const previousDiff = loadedDiff.current
      if (
        previousDiff &&
        [uncommitted, committed].every((diff, index) => {
          const previous =
            index === 0 ? previousDiff.uncommitted : previousDiff.committed
          return (
            previous.baseRef === diff.baseRef &&
            previous.baseCommit === diff.baseCommit &&
            previous.headCommit === diff.headCommit &&
            JSON.stringify(previous.files) === JSON.stringify(diff.files)
          )
        })
      ) {
        return
      }

      const parsedComments: ReviewComment[] =
        initial && Array.isArray(storedComments)
          ? storedComments.flatMap((comment): ReviewComment[] => {
              const parsed = parseReviewComment(comment)
              return parsed ? [parsed] : []
            })
          : commentsRef.current
      const parsedViewed = initial
        ? new Set(z.array(z.string()).catch([]).parse(storedViewedFiles))
        : viewedFilesRef.current
      const previousFiles = new Map(
        (loadedRef.current?.files ?? []).map((file) => [file.id, file])
      )
      const reviewFiles: ReviewFile[] = []
      for (const scope of ['uncommitted', 'committed'] as const) {
        const diff = scope === 'uncommitted' ? uncommitted : committed
        for (const file of diff.files) {
          const id = `${scope}:${file.path}`
          const beforeCommit = diff.baseCommit
          const afterCommit = scope === 'committed' ? diff.headCommit : null
          const previous = previousFiles.get(id)
          reviewFiles.push(
            previous &&
              previous.previousPath === file.previousPath &&
              previous.status === file.status &&
              previous.beforeCommit === beforeCommit &&
              previous.afterCommit === afterCommit
              ? previous
              : {
                  ...file,
                  id,
                  scope,
                  beforeCommit,
                  afterCommit,
                  diff: null,
                  loadState: 'idle',
                  revision: null,
                  message: null
                }
          )
        }
      }

      clearCopyFeedback()
      setSelectedFile((current) =>
        reviewFiles.some(({ id }) => id === current) ? current : null
      )
      setSelectedLines(null)
      setActiveFindMatch(-1)
      if (initial) {
        setComments(parsedComments)
        setActiveCommentId((current) =>
          parsedComments.some(({ id, resolved }) => id === current && !resolved)
            ? current
            : null
        )
        setViewedFiles(parsedViewed)
        setCommentStatus('')
      }

      const collapsed = fileStateLoaded.current
        ? new Set(collapsedFilesRef.current)
        : new Set(parsedViewed)
      if (!fileStateLoaded.current && uncommitted.files.length > 0) {
        for (const file of reviewFiles) {
          if (file.scope === 'committed') {
            collapsed.add(file.id)
          }
        }
      }

      setCollapsedFiles(collapsed)
      fileStateLoaded.current = true

      const nextLoaded: LoadedReview = {
        summary: context
          ? `${context.project.name} / ${context.worktree.name} · ${committed.baseRef}`
          : loadedRef.current!.summary,
        generatedAt: uncommitted.generatedAt,
        files: reviewFiles,
        searchableLines: searchableLinesFor(reviewFiles)
      }
      loadedDiff.current = { uncommitted, committed }
      loadedRef.current = nextLoaded
      setLoaded(nextLoaded)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      loadPending.current = false
      setLoading(false)
    }
  }, [clearCopyFeedback])

  const fileLoads = useRef(new Set<string>())
  const loadFile = useCallback(async (fileId: string, reload = false) => {
    const currentFile = loadedRef.current?.files.find(
      (file) => file.id === fileId
    )
    if (
      !currentFile ||
      fileLoads.current.has(fileId) ||
      (!reload && currentFile.loadState !== 'idle')
    ) {
      return
    }

    const filePath = currentFile.path
    const updateFile = (update: Partial<ReviewFile>) => {
      setLoaded((current) => {
        if (
          !current ||
          !current.files.some(
            (file) =>
              file.id === fileId &&
              file.beforeCommit === currentFile.beforeCommit &&
              file.afterCommit === currentFile.afterCommit
          )
        ) {
          return current
        }

        const next = {
          ...current,
          files: current.files.map((file) =>
            file.id === fileId ? { ...file, ...update } : file
          )
        }
        next.searchableLines = searchableLinesFor(next.files)
        loadedRef.current = next
        return next
      })
    }

    fileLoads.current.add(fileId)

    if (currentFile.loadState !== 'ready') {
      updateFile({ loadState: 'loading', message: null })
    }

    try {
      const result = await treeport.diffFile({
        path: filePath,
        scope: currentFile.scope
      })

      if (result.status === 'oversized') {
        updateFile({
          diff: null,
          loadState: 'oversized',
          revision: null,
          message: result.message ?? 'This patch is too large to display.'
        })
        return
      }

      if (result.revision === currentFile.revision) {
        return
      }

      const parsed = result.unified
        ? parsePatchFiles(result.unified, crypto.randomUUID()).flatMap(
            (patch) => patch.files
          )
        : []
      const fileDiff =
        parsed.find((candidate) => candidate.name === filePath) ?? parsed[0]
      if (!fileDiff) {
        throw new Error('The file diff did not contain a patch')
      }

      updateFile({
        diff: fileDiff,
        loadState: 'ready',
        revision: result.revision,
        message: null
      })
    } catch (reason) {
      updateFile({
        diff: null,
        loadState: 'error',
        revision: null,
        message: reason instanceof Error ? reason.message : String(reason)
      })
    } finally {
      fileLoads.current.delete(fileId)
    }
  }, [])

  useEffect(() => {
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            const filePath =
              entry.target instanceof HTMLElement
                ? entry.target.dataset.reviewFile
                : null

            if (filePath) {
              void loadFile(filePath)
            }
          }
        }
      },
      { root: document.querySelector('#review'), rootMargin: '300px 0px' }
    )
    for (const section of sectionRefs.current.values()) {
      observer.observe(section)
    }
    return () => observer.disconnect()
  }, [files, loadFile])

  useEffect(() => {
    const refresh = () => {
      void load()
      for (const file of loadedRef.current?.files ?? []) {
        if (file.loadState === 'ready') {
          void loadFile(file.id, true)
        }
      }
    }
    refresh()
    addEventListener('focus', refresh)
    const interval = setInterval(() => {
      if (document.hasFocus()) {
        refresh()
      }
    }, AUTO_REFRESH_INTERVAL_MS)
    return () => {
      removeEventListener('focus', refresh)
      clearInterval(interval)
    }
  }, [load, loadFile])

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
    setFileTreeOpen(false)
    setSelectedFile(file)
    requestAnimationFrame(() => {
      sectionRefs.current.get(file)?.scrollIntoView({ block: 'start' })
    })
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
            `[data-code]:is([data-unified], [data-${match.side}]) [data-line="${match.lineNumber}"]${sideSelector}`
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
  }, [collapsedFiles, diffStyle, findOpen, updateFindHighlights])

  const navigateToFindMatch = useCallback(
    (requestedIndex: number) => {
      if (findMatches.length === 0) {
        return
      }

      const index = (requestedIndex + findMatches.length) % findMatches.length
      const match = findMatches[index]!
      setActiveFindMatch(index)
      setImageSources((current) => new Set(current).add(match.file))
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
      setImageSources((current) => new Set(current).add(match.file))
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
    setFileTreeOpen(false)
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
      setFileTreeOpen(false)
      setCollapsed(comment.fileId, false)
      setImageSources((current) => new Set(current).add(comment.fileId))
      setActiveCommentId(comment.id)
      setSelectedFile(comment.fileId)
      setSelectedLines({
        file: comment.fileId,
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
            .get(comment.fileId)
            ?.scrollIntoView({ block: 'start' })
        }
      })
    },
    [setCollapsed]
  )

  const navigateComments = (direction: number) => {
    if (navigableComments.length === 0) {
      return
    }

    const current = navigableComments.findIndex(
      ({ id }) => id === activeCommentId
    )
    const index =
      current === -1
        ? direction > 0
          ? 0
          : navigableComments.length - 1
        : (current + direction + navigableComments.length) %
          navigableComments.length
    navigateToComment(navigableComments[index]!)
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
        const scope = comment.fileId.startsWith('committed:')
          ? 'committed'
          : comment.fileId.startsWith('uncommitted:')
            ? 'uncommitted'
            : 'previous combined diff'
        return `${comment.file}:${comment.lineNumber}${side} (${scope})\n${comment.body}`
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

  return (
    <Sheet.Root open={fileTreeOpen} onOpenChange={setFileTreeOpen}>
      <header className="review-toolbar" aria-label="Review toolbar">
        <p id="summary" className="sr-only">
          {loaded?.summary ??
            (error ? 'Could not load review' : 'Loading context…')}
        </p>
        <div className="review-progress">
          <div
            id="line-counts"
            aria-label={`${lineCounts.additions} lines added and ${lineCounts.deletions} lines deleted`}
          >
            <span className="additions">+{lineCounts.additions}</span>
            <span className="deletions">-{lineCounts.deletions}</span>
          </div>
          <div
            id="viewed-progress"
            aria-label={`${viewedCount} of ${fileNames.length} files viewed`}
          >
            <strong id="viewed-count">
              {viewedCount}/{fileNames.length}
            </strong>
            <span>viewed</span>
          </div>
        </div>
        {unresolved.length > 0 && (
          <div className="comment-controls">
            <div className="comment-navigation" aria-label="Comment navigation">
              <div id="comment-position">
                {navigableComments.length > 0 && (
                  <span>
                    {activeCommentIndex === -1
                      ? `${navigableComments.length} unresolved`
                      : `${activeCommentIndex + 1} of ${navigableComments.length} unresolved`}
                  </span>
                )}
                {outdatedComments.length > 0 && (
                  <span>{outdatedComments.length} outdated</span>
                )}
              </div>
              {navigableComments.length > 0 && (
                <div className="comment-navigation-buttons">
                  <button
                    className="toolbar-icon-button"
                    type="button"
                    aria-label="Previous unresolved comment"
                    title="Previous unresolved comment"
                    onClick={() => navigateComments(-1)}
                  >
                    <Chevron direction="up" />
                    <span className="touch-target" aria-hidden="true" />
                  </button>
                  <button
                    className="toolbar-icon-button"
                    type="button"
                    aria-label="Next unresolved comment"
                    title="Next unresolved comment"
                    onClick={() => navigateComments(1)}
                  >
                    <Chevron direction="down" />
                    <span className="touch-target" aria-hidden="true" />
                  </button>
                </div>
              )}
            </div>
            <button
              id="copy-comments"
              className="toolbar-copy-button"
              type="button"
              aria-label={`Copy unresolved comments (${unresolved.length})`}
              title={
                copyFeedback ?? `Copy unresolved comments (${unresolved.length})`
              }
              onClick={copy}
            >
              <ClipboardDocumentIcon aria-hidden="true" />
              <span className="copy-label">
                {copyFeedback ?? 'Copy comments'}
              </span>
              <span className="touch-target" aria-hidden="true" />
            </button>
          </div>
        )}
        <button
          id="split-diff-toggle"
          className="toolbar-icon-button"
          type="button"
          aria-label="Split diff"
          aria-pressed={diffStyle === 'split'}
          title={
            diffStyle === 'split'
              ? 'Switch to unified diff'
              : 'Switch to split diff'
          }
          onClick={() =>
            setDiffStyle((current) =>
              current === 'unified' ? 'split' : 'unified'
            )
          }
        >
          <ViewColumnsIcon aria-hidden="true" />
          <span className="touch-target" aria-hidden="true" />
        </button>
        <Sheet.Trigger
          id="file-tree-toggle"
          className="toolbar-icon-button"
          type="button"
          aria-label={`Show changed files (${files.length})`}
          title={`Show changed files (${files.length})`}
        >
          <FolderIcon aria-hidden="true" />
          <span className="touch-target" aria-hidden="true" />
        </Sheet.Trigger>
        <p id="comment-status" role="status">
          {commentStatus}
        </p>
        <p className="sr-only" role="status">
          {copyFeedback}
        </p>
        <div
          id="find-bar"
          role="search"
          aria-label="Find in changed lines"
          hidden={!findOpen}
        >
          <input
            ref={findInputRef}
            id="find-input"
            name="review-find"
            type="search"
            enterKeyHint="search"
            autoCapitalize="none"
            autoCorrect="off"
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
            <XMarkIcon aria-hidden="true" />
          </button>
        </div>
      </header>
      <div className="workspace">
        <main id="review" aria-live="polite">
          {!loading && !error && outdatedComments.length > 0 && (
            <section
              className="outdated-comments"
              aria-labelledby="outdated-comments-heading"
            >
              <h2 id="outdated-comments-heading">Outdated comments</h2>
              <p>
                These comment locations no longer appear in the current diff.
                Resolve or delete each comment after you review the new code.
              </p>
              <ul role="list">
                {outdatedComments.map((comment) => (
                  <li key={comment.id}>
                    <div className="outdated-comment-location">
                      <strong>{comment.file}</strong>
                      <span>
                        Line {comment.lineNumber}
                        {comment.side === 'deletions'
                          ? ' (deleted line)'
                          : ''}
                      </span>
                    </div>
                    <p>{comment.body}</p>
                    <div className="comment-actions">
                      <button
                        type="button"
                        aria-label={`Resolve outdated comment on ${comment.file} line ${comment.lineNumber}`}
                        onClick={() => setCommentResolved(comment, true)}
                      >
                        Resolve
                      </button>
                      <button
                        type="button"
                        aria-label={`Delete outdated comment on ${comment.file} line ${comment.lineNumber}`}
                        onClick={() => deleteComment(comment)}
                      >
                        Delete
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
            </section>
          )}
          {loading ? (
            <p className="empty">Reading tree changes…</p>
          ) : error ? (
            <p className="error">{error}</p>
          ) : files.length === 0 ? (
            <p className="empty">
              No changes against the default branch merge base.
            </p>
          ) : (
            fileGroups.map((group) => (
              <section
                key={group.id}
                className="review-change-group"
                aria-labelledby={`review-group-${group.id}`}
              >
                <h2
                  id={`review-group-${group.id}`}
                  className="review-group-header"
                >
                  <span>{group.label}</span>
                  <span className="review-group-count">
                    {group.files.length}
                  </span>
                </h2>
                {group.files.map((file) => {
                  const fileDiff = file.diff
                  if (!fileDiff) {
                    const label =
                      file.loadState === 'oversized'
                        ? 'Patch too large to display'
                        : file.loadState === 'error'
                          ? 'Could not load patch'
                          : file.loadState === 'loading'
                            ? 'Loading patch…'
                            : 'Patch loads when visible'
                    const isImage =
                      /\.(png|jpe?g|gif|webp|svg|avif|bmp|ico)$/i.test(
                        file.path
                      )
                    return (
                      <section
                        key={file.id}
                        data-review-file={file.id}
                        ref={(element) => {
                          if (element) {
                            sectionRefs.current.set(file.id, element)
                          } else {
                            sectionRefs.current.delete(file.id)
                          }
                        }}
                        className={`file-diff file-diff-placeholder${selectedFile === file.id ? ' selected' : ''}`}
                      >
                        <div className="file-placeholder-header">
                          <strong>{file.path}</strong>
                          <span>{label}</span>
                        </div>
                        {file.message && <p>{file.message}</p>}
                        {file.loadState === 'error' && (
                          <button
                            type="button"
                            onClick={() => void loadFile(file.id, true)}
                          >
                            Retry
                          </button>
                        )}
                        {file.loadState === 'oversized' && isImage && (
                          <div className="image-diff">
                            {file.status !== 'added' &&
                              file.status !== 'untracked' && (
                                <ImagePreview
                                  path={file.previousPath ?? file.path}
                                  commit={file.beforeCommit}
                                  label="Before"
                                />
                              )}
                            {file.status !== 'deleted' && (
                              <ImagePreview
                                path={file.path}
                                commit={file.afterCommit}
                                label="After"
                              />
                            )}
                          </div>
                        )}
                      </section>
                    )
                  }

                  const fileComments = comments.filter(
                    (comment) => comment.fileId === file.id
                  )
                  const annotations: DiffLineAnnotation<ReviewComment>[] =
                    fileComments.map((comment) => ({
                      side: comment.side,
                      lineNumber: comment.lineNumber,
                      metadata: comment
                    }))
                  const collapsed = collapsedFiles.has(file.id)
                  const isImage =
                    /\.(png|jpe?g|gif|webp|svg|avif|bmp|ico)$/i.test(
                      fileDiff.name
                    )
                  const showImage =
                    isImage &&
                    (fileDiff.hunks.length === 0 || !imageSources.has(file.id))
                  return (
                    <section
                      key={file.id}
                      data-review-file={file.id}
                      ref={(element) => {
                        if (element) {
                          sectionRefs.current.set(file.id, element)
                        } else {
                          sectionRefs.current.delete(file.id)
                        }
                      }}
                      className={`file-diff${selectedFile === file.id ? ' selected' : ''}`}
                    >
                      <FileDiff<ReviewComment>
                        fileDiff={fileDiff}
                        options={{
                          theme: 'pierre-dark',
                          diffStyle,
                          overflow: 'wrap',
                          collapsed: collapsed || showImage,
                          unsafeCSS: DIFF_CSS,
                          enableGutterUtility: true,
                          lineHoverHighlight: 'both',
                          onGutterUtilityClick: (range) => {
                            if (
                              commentsRef.current.some(
                                (comment) =>
                                  comment.fileId === file.id && comment.draft
                              )
                            ) {
                              return
                            }

                            const next = [
                              ...commentsRef.current,
                              {
                                id: `${Date.now()}-${++commentSerial.current}`,
                                file: file.path,
                                fileId: file.id,
                                side: range.side ?? 'additions',
                                lineNumber: range.start,
                                body: '',
                                resolved: false,
                                draft: true
                              } satisfies ReviewComment
                            ]
                            clearCopyFeedback()
                            setComments(next)
                            setSelectedLines({ file: file.id, range })
                          },
                          onPostRender: () => {
                            if (findOpen) {
                              requestAnimationFrame(updateFindHighlights)
                            }
                          }
                        }}
                        lineAnnotations={annotations}
                        selectedLines={
                          selectedLines?.file === file.id
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
                            onClick={() => setCollapsed(file.id, !collapsed)}
                          >
                            <svg viewBox="0 0 16 16" aria-hidden="true">
                              <path
                                d={collapsed ? 'm6 3 5 5-5 5' : 'm3 6 5 5 5-5'}
                              />
                            </svg>
                          </button>
                        )}
                        renderHeaderMetadata={() => (
                          <>
                            {isImage && fileDiff.hunks.length > 0 && (
                              <button
                                type="button"
                                aria-label={`${showImage ? 'Show source for' : 'Show image for'} ${fileDiff.name}`}
                                onClick={() => {
                                  setImageSources((current) => {
                                    const next = new Set(current)
                                    if (showImage) {
                                      next.add(file.id)
                                    } else {
                                      next.delete(file.id)
                                    }

                                    return next
                                  })
                                  setCollapsed(file.id, false)
                                }}
                              >
                                {showImage ? 'Source' : 'Image'}
                              </button>
                            )}
                            <label className="file-viewed">
                              <input
                                type="checkbox"
                                checked={viewedFiles.has(file.id)}
                                aria-label={`Viewed ${fileDiff.name}`}
                                onChange={(event) => {
                                  const checked = event.target.checked
                                  const next = new Set(viewedFiles)
                                  if (checked) {
                                    next.add(file.id)
                                  } else {
                                    next.delete(file.id)
                                  }

                                  setViewedFiles(next)
                                  setCollapsed(file.id, checked)
                                  void persistViewed(next)
                                }}
                              />
                              Viewed
                            </label>
                          </>
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
                              onResolve={() =>
                                setCommentResolved(comment, true)
                              }
                              onSave={(body) => saveComment(comment, body)}
                              onUnresolve={() =>
                                setCommentResolved(comment, false)
                              }
                            />
                          )
                        }}
                      />
                      {showImage && !collapsed && (
                        <div className="image-diff">
                          {fileDiff.type !== 'new' && (
                            <ImagePreview
                              key={`before:${file.beforeCommit}:${fileDiff.prevName ?? fileDiff.name}`}
                              path={fileDiff.prevName ?? fileDiff.name}
                              commit={file.beforeCommit}
                              label="Before"
                            />
                          )}
                          {fileDiff.type !== 'deleted' && (
                            <ImagePreview
                              key={`after:${file.id}:${file.afterCommit}:${fileDiff.newObjectId ?? loaded!.generatedAt}`}
                              path={fileDiff.name}
                              commit={file.afterCommit}
                              label="After"
                            />
                          )}
                        </div>
                      )}
                    </section>
                  )
                })}
              </section>
            ))
          )}
        </main>
      </div>
      <Sheet.Portal keepMounted>
        <Sheet.Backdrop className="file-sheet-backdrop" />
        <Sheet.Popup id="changed-files" className="file-sheet">
          <div className="file-sheet-header">
            <Sheet.Title>Changed files ({files.length})</Sheet.Title>
            <Sheet.Close aria-label="Close changed files">
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path d="M6 6l12 12M18 6 6 18" />
              </svg>
            </Sheet.Close>
          </div>
          <div id="file-tree">
            {files.length > 0 && (
              <ChangedFileTree files={files} onSelect={selectFile} />
            )}
          </div>
        </Sheet.Popup>
      </Sheet.Portal>
    </Sheet.Root>
  )
}

createRoot(document.querySelector('#root')!).render(<ReviewApp />)
