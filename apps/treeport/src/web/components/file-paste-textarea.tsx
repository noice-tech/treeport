import { useState, type ClipboardEvent } from 'react'
import { parseResponse, rpc } from '../api'
import { Textarea } from './ui/textarea'
import { errorMessage } from '../error-message'
import { cn } from '../lib/utils'

// Pasted files are uploaded and their paths inserted at the caret.
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
  const statusId = `${id}-upload-status`
  return (
    <>
      <Textarea
        id={id}
        name={id}
        rows={rows}
        placeholder={placeholder}
        className={cn('max-h-60 field-sizing-content resize-none', className)}
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
          const clipboardFiles = Array.from(event.clipboardData.files)
          const files = clipboardFiles.length
            ? clipboardFiles
            : Array.from(event.clipboardData.items).flatMap((item) => {
                const file = item.kind === 'file' ? item.getAsFile() : null
                return file ? [file] : []
              })
          if (!files.length) {
            onTextPaste?.(event)
            return
          }

          event.preventDefault()
          if (upload?.state === 'uploading') {
            return
          }

          const textarea = event.currentTarget
          const { selectionStart, selectionEnd } = textarea
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
                headers.set(
                  'x-treeport-file-extension',
                  extension.toLowerCase()
                )
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
                  message: `Couldn’t paste file: ${errorMessage(cause)}`
                })
              }
            )
            .finally(() => onUploadingChange(false))
        }}
      />
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
