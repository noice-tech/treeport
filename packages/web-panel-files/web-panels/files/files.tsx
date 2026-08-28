import { Editor, type EditorOptions } from '@pierre/diffs/edit'
import { EditProvider, File } from '@pierre/diffs/react'
import { FileTree, useFileTree } from '@pierre/trees/react'
import { treeport } from '@treeport/panel-sdk'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import './files.css'

interface DocumentState {
  path: string
  savedContent: string
  currentContent: string
  revision: string | null
  generation: number
  loading: boolean
  saving: boolean
  conflict: boolean
  error: string | null
}

const EDITOR_CSS = `
  :host {
    min-height: 100%;
    background: #1e1e1e;
    --diffs-bg-caret-override: #ffffff;
  }
  ::selection { color: #ffffff; }
  [data-selection-range] { background-color: #264f78 !important; }
  pre { min-height: 100%; font: 13px/1.55 ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; }
  [data-diffs-header] { display: none !important; }
`

function FilesExplorer({
  paths,
  dirtyPaths,
  onSelect
}: {
  paths: string[]
  dirtyPaths: Set<string>
  onSelect(path: string): void
}) {
  const pathSet = useMemo(() => new Set(paths), [paths])
  const { model } = useFileTree({
    paths,
    initialExpansion: 'closed',
    flattenEmptyDirectories: false,
    density: 'compact',
    search: true,
    fileTreeSearchMode: 'hide-non-matches',
    onSelectionChange: (selectedPaths) => {
      const selected = selectedPaths.find((path) => pathSet.has(path))
      if (selected) {
        requestAnimationFrame(() => onSelect(selected))
      }
    }
  })

  useEffect(() => {
    model.setGitStatus(
      [...dirtyPaths].map((path) => ({ path, status: 'modified' as const }))
    )
  }, [dirtyPaths, model])

  return <FileTree model={model} />
}

function FilesApp() {
  const [paths, setPaths] = useState<string[] | null>(null)
  const [truncated, setTruncated] = useState(false)
  const [listError, setListError] = useState<string | null>(null)
  const [listLoading, setListLoading] = useState(true)
  const [selectedPath, setSelectedPath] = useState<string | null>(null)
  const selectedPathRef = useRef(selectedPath)
  selectedPathRef.current = selectedPath
  const [documents, setDocuments] = useState<Map<string, DocumentState>>(
    () => new Map()
  )
  const documentsRef = useRef(documents)
  documentsRef.current = documents
  const savingPaths = useRef(new Set<string>())
  const editorRef = useRef<Editor<undefined> | null>(null)
  const editorBodyRef = useRef<HTMLElement>(null)
  const workbenchRef = useRef<HTMLDivElement>(null)
  const sidebarRef = useRef<HTMLElement>(null)
  const resizeHandleRef = useRef<HTMLDivElement>(null)

  const setDocument = useCallback(
    (
      path: string,
      update: (current: DocumentState | undefined) => DocumentState | undefined
    ) => {
      setDocuments((current) => {
        const value = update(current.get(path))
        if (!value) {
          return current
        }

        const next = new Map(current)
        next.set(path, value)
        documentsRef.current = next
        return next
      })
    },
    []
  )

  const loadFiles = useCallback(() => {
    setListLoading(true)
    setListError(null)
    void treeport.files.list().then(
      (listing) => {
        setPaths(listing.paths)
        setTruncated(listing.truncated)
        setListLoading(false)
      },
      (reason) => {
        setListError(reason instanceof Error ? reason.message : String(reason))
        setListLoading(false)
      }
    )
  }, [])

  useEffect(loadFiles, [loadFiles])

  const openFile = useCallback(
    (path: string) => {
      selectedPathRef.current = path
      setSelectedPath(path)
      if (documentsRef.current.has(path)) {
        return
      }

      setDocument(path, () => ({
        path,
        savedContent: '',
        currentContent: '',
        revision: null,
        generation: 0,
        loading: true,
        saving: false,
        conflict: false,
        error: null
      }))
      void treeport.files.read(path).then(
        (file) => {
          setDocument(path, (current) => ({
            ...(current ?? {
              path,
              generation: 0
            }),
            savedContent: file.content,
            currentContent: file.content,
            revision: file.revision,
            loading: false,
            saving: false,
            conflict: false,
            error: null
          }))
        },
        (reason) => {
          setDocument(path, (current) =>
            current
              ? {
                  ...current,
                  loading: false,
                  error:
                    reason instanceof Error ? reason.message : String(reason)
                }
              : current
          )
        }
      )
    },
    [setDocument]
  )

  const createEditor = useCallback(
    (options: EditorOptions<undefined>) =>
      new Editor<undefined>({
        ...options,
        persistState: true,
        historyMaxEntries: 200,
        matchBrackets: true,
        autoSurround: 'default',
        onAttach: (editor, file) => {
          editorRef.current = editor
          options.onAttach?.(editor, file)
        },
        onChange: (file, annotations, event) => {
          options.onChange?.(file, annotations, event)
          setDocument(file.name, (current) =>
            current
              ? {
                  ...current,
                  currentContent: file.contents,
                  error: current.conflict ? current.error : null
                }
              : current
          )
        }
      }),
    [setDocument]
  )

  const saveSelected = useCallback(() => {
    const path = selectedPathRef.current
    const document = path ? documentsRef.current.get(path) : undefined
    if (
      !path ||
      !document?.revision ||
      document.currentContent === document.savedContent ||
      savingPaths.current.has(path)
    ) {
      return
    }

    const content = document.currentContent
    const expectedRevision = document.revision
    savingPaths.current.add(path)
    setDocument(path, (current) =>
      current
        ? {
            ...current,
            saving: true,
            conflict: false,
            error: null
          }
        : current
    )
    void treeport.files
      .write({ path, content, expectedRevision })
      .then(
        (result) => {
          setDocument(path, (current) =>
            current
              ? {
                  ...current,
                  savedContent: content,
                  revision: result.revision,
                  saving: false,
                  conflict: false,
                  error: null
                }
              : current
          )
        },
        (reason) => {
          // SAFETY: The panel SDK adds an optional string code to host errors.
          const code =
            reason instanceof Error && 'code' in reason
              ? (reason as Error & { code?: string }).code
              : undefined
          setDocument(path, (current) =>
            current
              ? {
                  ...current,
                  saving: false,
                  conflict: code === 'TREE_FILE_CHANGED',
                  error:
                    reason instanceof Error ? reason.message : String(reason)
                }
              : current
          )
        }
      )
      .finally(() => savingPaths.current.delete(path))
  }, [setDocument])

  const reloadFile = useCallback(
    (path: string) => {
      const document = documentsRef.current.get(path)
      if (
        document &&
        document.currentContent !== document.savedContent &&
        !window.confirm(`Discard unsaved changes to ${path}?`)
      ) {
        return
      }

      setDocument(path, (current) =>
        current
          ? {
              ...current,
              loading: true,
              conflict: false,
              error: null
            }
          : current
      )
      void treeport.files.read(path).then(
        (file) => {
          setDocument(path, (current) =>
            current
              ? {
                  ...current,
                  savedContent: file.content,
                  currentContent: file.content,
                  revision: file.revision,
                  generation: current.generation + 1,
                  loading: false,
                  saving: false,
                  conflict: false,
                  error: null
                }
              : current
          )
        },
        (reason) => {
          setDocument(path, (current) =>
            current
              ? {
                  ...current,
                  loading: false,
                  error:
                    reason instanceof Error ? reason.message : String(reason)
                }
              : current
          )
        }
      )
    },
    [setDocument]
  )

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const key = event.key.toLowerCase()
      const command = event.metaKey || event.ctrlKey
      const editorBody = editorBodyRef.current
      const editing = editorBody
        ? event.composedPath().includes(editorBody)
        : false
      const undo = editing && command && key === 'z' && !event.shiftKey
      const redo =
        editing &&
        ((command && key === 'z' && event.shiftKey) ||
          (event.ctrlKey && key === 'y' && !event.shiftKey))
      if ((undo || redo) && !event.altKey) {
        event.preventDefault()
        event.stopPropagation()
        if (undo) {
          editorRef.current?.undo()
        } else {
          editorRef.current?.redo()
        }

        return
      }

      if (key === 's' && command && !event.altKey && !event.shiftKey) {
        event.preventDefault()
        event.stopPropagation()
        saveSelected()
      }
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [saveSelected])

  useEffect(() => {
    const workbench = workbenchRef.current
    const sidebar = sidebarRef.current
    const handle = resizeHandleRef.current
    if (!workbench || !sidebar || !handle) {
      return
    }

    const setWidth = (
      requested: number,
      maximum = Math.max(160, workbench.clientWidth - 320)
    ) => {
      const width = Math.round(Math.min(maximum, Math.max(160, requested)))
      workbench.style.setProperty('--sidebar-width', `${width}px`)
      handle.setAttribute('aria-valuenow', String(width))
      handle.setAttribute('aria-valuemax', String(maximum))
    }
    let workbenchRight = 0
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

      const bounds = workbench.getBoundingClientRect()
      workbenchRight = bounds.right
      maximum = Math.max(160, bounds.width - 320)
      handle.setPointerCapture(event.pointerId)
      handle.classList.add('resizing')
      document.body.classList.add('resizing')
    }
    const pointerMove = (event: PointerEvent) => {
      if (!handle.hasPointerCapture(event.pointerId)) {
        return
      }

      pending = workbenchRight - event.clientX
      if (frame === null) {
        frame = requestAnimationFrame(apply)
      }
    }
    const pointerUp = (event: PointerEvent) => {
      if (!handle.hasPointerCapture(event.pointerId)) {
        return
      }

      pending = workbenchRight - event.clientX
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
        setWidth(current + 16)
      } else if (event.key === 'ArrowRight') {
        setWidth(current - 16)
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

  const dirtyPaths = useMemo(
    () =>
      new Set(
        [...documents.values()]
          .filter(
            (document) => document.currentContent !== document.savedContent
          )
          .map((document) => document.path)
      ),
    [documents]
  )
  const hasDirtyFiles = dirtyPaths.size > 0

  useEffect(() => treeport.panel.setDirty(hasDirtyFiles), [hasDirtyFiles])
  useEffect(() => () => treeport.panel.setDirty(false), [])
  useEffect(() => {
    if (!hasDirtyFiles) {
      return
    }

    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault()
      event.returnValue = ''
    }
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [hasDirtyFiles])

  const selectedDocument = selectedPath
    ? documents.get(selectedPath)
    : undefined
  const selectedDirty = Boolean(
    selectedDocument &&
    selectedDocument.currentContent !== selectedDocument.savedContent
  )
  return (
    <div className="workbench" ref={workbenchRef}>
      <main className="editor" aria-label="Source editor">
        <header className="editor-header">
          <div className="active-file" title={selectedPath ?? undefined}>
            {selectedPath ?? 'No file selected'}
            {selectedDirty ? (
              <span aria-label="Unsaved changes" className="dirty-marker">
                ●
              </span>
            ) : null}
          </div>
        </header>
        <div className="feedback">
          {selectedDocument?.error ? (
            <div role="alert">
              <span>{selectedDocument.error}</span>
              {selectedPath ? (
                <button type="button" onClick={() => reloadFile(selectedPath)}>
                  {selectedDocument.conflict ? 'Reload' : 'Retry'}
                </button>
              ) : null}
            </div>
          ) : null}
        </div>
        <section
          className="editor-body"
          aria-label="File contents"
          ref={editorBodyRef}
        >
          {!selectedPath ? (
            <p className="empty-editor">Select a file from Files.</p>
          ) : selectedDocument?.loading && !selectedDocument.revision ? (
            <p className="empty-editor" role="status">
              Reading {selectedPath}…
            </p>
          ) : selectedDocument?.revision ? (
            <EditProvider createEditor={createEditor}>
              <File
                edit
                file={{
                  name: selectedDocument.path,
                  contents: selectedDocument.currentContent,
                  cacheKey: `${selectedDocument.path}:${selectedDocument.generation}`
                }}
                options={{
                  theme: 'dark-plus',
                  themeType: 'dark',
                  overflow: 'scroll',
                  disableFileHeader: true,
                  tokenizeMaxLength: 500_000,
                  tokenizeMaxLineLength: 20_000,
                  unsafeCSS: EDITOR_CSS
                }}
              />
            </EditProvider>
          ) : null}
        </section>
      </main>
      <div
        className="resize-handle"
        ref={resizeHandleRef}
        role="separator"
        aria-label="Resize files"
        aria-orientation="vertical"
        aria-valuemin={160}
        tabIndex={0}
      />
      <aside className="explorer" aria-label="Files" ref={sidebarRef}>
        {listLoading ? (
          <p className="panel-message" role="status">
            Reading files…
          </p>
        ) : listError ? (
          <div className="panel-message error" role="alert">
            <p>{listError}</p>
            <button type="button" onClick={loadFiles}>
              Retry
            </button>
          </div>
        ) : paths?.length ? (
          <FilesExplorer
            paths={paths}
            dirtyPaths={dirtyPaths}
            onSelect={openFile}
          />
        ) : (
          <p className="panel-message">This tree has no editable files.</p>
        )}
        {truncated ? (
          <p className="listing-note" role="status">
            Showing the first 50,000 files.
          </p>
        ) : null}
      </aside>
    </div>
  )
}

createRoot(document.querySelector('#root')!).render(<FilesApp />)
