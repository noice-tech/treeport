import { useRef, useState, type ClipboardEvent, type DragEvent } from 'react'
import { parseResponse, rpc } from '../api'
import { Textarea } from './ui/textarea'
import { errorMessage } from '../error-message'
import { cn } from '../lib/utils'

export function FilePasteTextarea({
  id,
  value,
  autoFocus,
  disabled,
  rows = 4,
  placeholder,
  className,
  onValueChange,
  onUploadingChange,
  onTextPaste
}: {
  id: string
  value: string
  autoFocus: boolean
  disabled: boolean
  rows?: number
  placeholder?: string
  className?: string
  onValueChange: (value: string) => void
  onUploadingChange: (uploading: boolean) => void
  onTextPaste?: (event: ClipboardEvent<HTMLTextAreaElement>) => void
}) {
  const [upload, setUpload] = useState<{
    state: 'uploading' | 'error'
    message: string
  } | null>(null)

  const [fileDragOver, setFileDragOver] = useState(false)

  // EXTERNAL: iOS drags a long-pressed selection with a web archive file. Dropping
  // the field's own text back onto it must not upload and insert it.
  const draggingOwnText = useRef(false)

  const statusId = `${id}-upload-status`

  const filesFromTransfer = (transfer: DataTransfer): File[] => {
    const files = Array.from(transfer.files)

    return files.length
      ? files
      : Array.from(transfer.items).flatMap((item) => {
          const file = item.kind === 'file' ? item.getAsFile() : null

          return file ? [file] : []
        })
  }

  const transfersFiles = (event: DragEvent<HTMLTextAreaElement>) =>
    !draggingOwnText.current &&
    Array.from(event.dataTransfer.types).includes('Files')

  const insertFiles = (
    textarea: HTMLTextAreaElement,
    files: File[],
    selectionStart: number,
    selectionEnd: number
  ) => {
    setUpload({
      state: 'uploading',
      message:
        files.length === 1
          ? 'Uploading file…'
          : `Uploading ${files.length} files…`
    })
    onUploadingChange(true)
    void Promise.all(
      files.map(async (file) => {
        const localPath = await (
          window.treeportDesktop?.getPathForFile?.(file) ??
          Promise.resolve(null)
        ).catch(() => null)

        if (localPath) {
          return localPath
        }

        const extension = /\.([a-z0-9]{1,16})$/i.exec(file.name)?.[1]

        const headers = new Headers({
          'content-type': file.type || 'application/octet-stream'
        })

        if (extension) {
          headers.set('x-treeport-file-extension', extension.toLowerCase())
        }

        const result = await parseResponse(
          rpc.api.files.$post({
            init: { body: file, headers },
            onProgress: () => {}
          })
        )

        return result.file.path
      })
    )
      .then(
        (paths) => {
          const before = textarea.value.slice(0, selectionStart)
          const after = textarea.value.slice(selectionEnd)
          const inserted = `${before && !/\s$/u.test(before) ? ' ' : ''}${paths.join(' ')}${after && !/^\s/u.test(after) ? ' ' : ''}`
          const caret = before.length + inserted.length
          setUpload(null)
          onValueChange(before + inserted + after)
          requestAnimationFrame(() => {
            textarea.focus()
            textarea.setSelectionRange(caret, caret)
          })
        },
        (cause: unknown) => {
          setUpload({
            state: 'error',
            message: `Couldn’t add file: ${errorMessage(cause)}`
          })
        }
      )
      .finally(() => onUploadingChange(false))
  }

  return (
    <>
      <div className="relative">
        <Textarea
          id={id}
          name={id}
          rows={rows}
          placeholder={placeholder}
          className={cn(
            'block max-h-60 field-sizing-content resize-none transition-none',
            fileDragOver &&
              'text-transparent ring-0 focus-visible:ring-0 outline-2 outline-dashed outline-offset-0 outline-accent-400 placeholder:text-transparent',
            className
          )}
          value={value}
          autoFocus={autoFocus}
          disabled={disabled}
          readOnly={upload?.state === 'uploading'}
          aria-busy={upload?.state === 'uploading'}
          aria-describedby={upload ? statusId : undefined}
          onChange={(event) => {
            setUpload(null)
            onValueChange(event.target.value)
          }}
          onPaste={(event) => {
            const files = filesFromTransfer(event.clipboardData)

            if (!files.length) {
              onTextPaste?.(event)

              return
            }

            event.preventDefault()

            if (upload?.state === 'uploading') {
              return
            }

            const textarea = event.currentTarget
            insertFiles(
              textarea,
              files,
              textarea.selectionStart,
              textarea.selectionEnd
            )
          }}
          onDragStart={() => {
            draggingOwnText.current = true
          }}
          onDragEnd={() => {
            draggingOwnText.current = false
          }}
          onDragOver={(event) => {
            if (!transfersFiles(event)) {
              return
            }

            event.preventDefault()

            if (upload?.state === 'uploading') {
              event.dataTransfer.dropEffect = 'none'

              return
            }

            event.dataTransfer.dropEffect = 'copy'
            setFileDragOver(true)
          }}
          onDragLeave={() => setFileDragOver(false)}
          onDrop={(event) => {
            if (!transfersFiles(event)) {
              return
            }

            event.preventDefault()
            setFileDragOver(false)

            const files = filesFromTransfer(event.dataTransfer)

            if (!files.length || upload?.state === 'uploading') {
              return
            }

            const textarea = event.currentTarget
            insertFiles(
              textarea,
              files,
              textarea.selectionStart,
              textarea.selectionEnd
            )
          }}
        />
        {fileDragOver ? (
          <div className="pointer-events-none absolute inset-0 grid place-items-center px-3 text-center text-sm text-accent-100">
            Drop files to insert their paths
          </div>
        ) : null}
      </div>
      {upload ? (
        <p
          id={statusId}
          className={
            upload.state === 'error'
              ? 'text-xs text-amber-300'
              : 'text-xs text-zinc-400'
          }
          role="status"
        >
          {upload.message}
        </p>
      ) : null}
    </>
  )
}
