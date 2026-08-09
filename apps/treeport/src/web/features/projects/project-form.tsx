import { useEffect, useRef, useState } from 'react'
import { useMutation, useQuery } from '@tanstack/react-query'
import {
  ArrowUpIcon,
  ChevronRightIcon,
  FolderIcon,
  HomeIcon
} from '@heroicons/react/16/solid'
import type { ProjectRecord } from '@treeport/shared'
import { parseResponse } from 'hono/client'
import { rpc } from '../../api'
import { errorMessage } from '../../error-message'
import { Button } from '../../components/ui/button'
import { FormField } from '../../components/ui/form-field'
import { Input } from '../../components/ui/input'
import { Label } from '../../components/ui/label'
import { cn } from '../../lib/utils'
import { notifyError } from '../notifications/error-notifications'

export function ProjectForm({
  onOpened
}: {
  onOpened: (project: ProjectRecord) => Promise<void>
}) {
  const pathInputRef = useRef<HTMLInputElement>(null)
  const [pathValue, setPathValue] = useState('~')
  const [debouncedPath, setDebouncedPath] = useState('~')
  const [showHidden, setShowHidden] = useState(false)

  useEffect(() => {
    const timeout = window.setTimeout(
      () => setDebouncedPath(pathValue.trim()),
      250
    )
    return () => window.clearTimeout(timeout)
  }, [pathValue])

  const directoryQuery = useQuery({
    queryKey: ['filesystem-directories', debouncedPath, showHidden],
    queryFn: () =>
      parseResponse(
        rpc.api.filesystem.directories.$get({
          query: {
            input: debouncedPath,
            ...(showHidden ? { hidden: 'true' } : {})
          }
        })
      ),
    enabled: Boolean(debouncedPath),
    retry: false
  })
  const openProject = useMutation({
    mutationFn: async (path: string) =>
      (await parseResponse(rpc.api.projects.$post({ json: { path } }))).project,
    onSuccess: onOpened,
    onError: notifyError
  })

  const inputSettled = pathValue.trim() === debouncedPath
  const data =
    inputSettled &&
    !directoryQuery.isError &&
    directoryQuery.data?.input === debouncedPath
      ? directoryQuery.data
      : undefined
  const validRepository =
    inputSettled &&
    directoryQuery.isSuccess &&
    !directoryQuery.isFetching &&
    data?.exact &&
    data.repository.state === 'valid'
      ? data.repository
      : null
  const busy = openProject.isPending

  const navigate = (nextPath: string) => {
    setPathValue(nextPath)
    setDebouncedPath(nextPath)
    window.requestAnimationFrame(() => pathInputRef.current?.focus())
  }

  return (
    <form
      className="flex flex-col gap-3 max-[700px]:gap-4"
      onSubmit={(event) => {
        event.preventDefault()
        if (!validRepository || busy) {
          return
        }

        openProject.mutate(validRepository.repositoryPath)
      }}
    >
      <FormField>
        <Label htmlFor="repository-path">Server folder</Label>
        <Input
          ref={pathInputRef}
          id="repository-path"
          name="repository-path"
          value={pathValue}
          onChange={(event) => setPathValue(event.target.value)}
          onKeyDown={(event) => {
            if (event.nativeEvent.isComposing) {
              return
            }

            if (event.key === 'Enter' && !validRepository) {
              event.preventDefault()
              setDebouncedPath(pathValue.trim())
              return
            }

            if (event.key === 'ArrowDown') {
              const firstDirectory = document.querySelector<HTMLElement>(
                '#project-directory-list button'
              )
              if (firstDirectory) {
                event.preventDefault()
                firstDirectory.focus()
              }

              return
            }

            if (
              event.key === 'Escape' &&
              data &&
              pathValue.trim() !== data.directory.path
            ) {
              event.preventDefault()
              event.stopPropagation()
              navigate(data.directory.path)
            }
          }}
          placeholder="/Users/you/Projects/example"
          aria-label="Server folder path"
          aria-describedby="repository-path-status"
          aria-invalid={directoryQuery.isError}
          autoFocus
          disabled={busy}
        />
      </FormField>

      <div className="flex min-h-8 flex-wrap items-center gap-2 min-[701px]:min-h-7">
        {data && (
          <>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => navigate(data.directory.homePath)}
              disabled={busy}
            >
              <HomeIcon data-icon="inline-start" />
              Home
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => navigate(data.directory.rootPath)}
              disabled={busy}
            >
              Root
            </Button>
            <label className="ml-auto flex cursor-pointer items-center gap-2 text-base text-zinc-400 min-[701px]:text-sm">
              <input
                type="checkbox"
                checked={showHidden}
                onChange={(event) => setShowHidden(event.target.checked)}
                disabled={busy}
              />
              Show hidden folders
            </label>
          </>
        )}
      </div>

      <div className="overflow-hidden rounded-lg bg-zinc-950/50 ring-1 ring-white/10">
        <div className="flex min-h-10 items-center gap-1 overflow-x-auto border-b border-white/8 px-2 py-1.5 min-[701px]:min-h-8 min-[701px]:p-1">
          {data && (
            <>
              {data.directory.parentPath && (
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  aria-label="Parent folder"
                  onClick={() => navigate(data.directory.parentPath!)}
                  disabled={busy}
                >
                  <ArrowUpIcon />
                </Button>
              )}
              {data.directory.breadcrumbs.map((breadcrumb, index) => (
                <div key={breadcrumb.path} className="flex items-center gap-1">
                  {index > 0 && (
                    <ChevronRightIcon className="size-3.5 shrink-0 fill-zinc-600" />
                  )}
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="max-w-48"
                    title={breadcrumb.path}
                    onClick={() => navigate(breadcrumb.path)}
                    disabled={busy}
                  >
                    <span className="truncate">{breadcrumb.name}</span>
                  </Button>
                </div>
              ))}
            </>
          )}
        </div>

        <div
          id="project-directory-list"
          className="grid h-64 content-start gap-0.5 overflow-y-auto p-1.5 min-[701px]:h-56 min-[701px]:p-1 [scrollbar-color:var(--color-zinc-700)_transparent]"
          aria-label="Folders"
        >
          {directoryQuery.isFetching && (
            <p className="form-note p-3" role="status">
              Looking for folders…
            </p>
          )}
          {directoryQuery.isError && (
            <div className="flex items-center justify-between gap-3 p-3">
              <p
                className="text-base text-rose-300 min-[701px]:text-sm"
                role="alert"
              >
                {errorMessage(directoryQuery.error)}
              </p>
              <Button
                type="button"
                variant="secondary"
                size="sm"
                onClick={() => directoryQuery.refetch()}
              >
                Retry
              </Button>
            </div>
          )}
          {!directoryQuery.isFetching &&
            data?.directory.entries.map((entry) => (
              <button
                key={entry.path}
                type="button"
                className="flex min-w-0 items-center gap-2 rounded-md px-2.5 py-2 text-left text-base text-zinc-200 outline-none hover:bg-white/6 focus-visible:bg-white/6 focus-visible:outline-2 focus-visible:outline-cyan-400 min-[701px]:px-2 min-[701px]:py-1.5 min-[701px]:text-sm"
                title={entry.path}
                onClick={() => navigate(entry.path)}
                onKeyDown={(event) => {
                  if (event.key === 'Escape') {
                    event.preventDefault()
                    event.stopPropagation()
                    pathInputRef.current?.focus()
                    return
                  }

                  if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') {
                    return
                  }

                  event.preventDefault()
                  const buttons = [
                    ...document.querySelectorAll<HTMLButtonElement>(
                      '#project-directory-list button'
                    )
                  ]
                  const index = buttons.indexOf(event.currentTarget)
                  const nextIndex =
                    event.key === 'ArrowDown'
                      ? Math.min(index + 1, buttons.length - 1)
                      : index - 1
                  if (nextIndex >= 0) {
                    buttons[nextIndex]?.focus()
                  } else {
                    pathInputRef.current?.focus()
                  }
                }}
                disabled={busy}
              >
                <FolderIcon className="size-4 shrink-0 fill-cyan-500/80" />
                <span className="truncate">{entry.name}</span>
              </button>
            ))}
          {!directoryQuery.isFetching &&
            data &&
            data.directory.entries.length === 0 && (
              <p className="form-note p-3" role="status">
                {data.exact
                  ? 'This folder has no subfolders.'
                  : 'No matching folders.'}
              </p>
            )}
          {data?.directory.truncated && (
            <p className="form-note p-3" role="status">
              More folders are available. Type more of the path to narrow the
              list.
            </p>
          )}
        </div>
      </div>

      <p
        id="repository-path-status"
        className={cn(
          'form-note min-h-5 truncate',
          data?.repository.state === 'valid'
            ? 'text-emerald-300'
            : directoryQuery.isError ||
                data?.repository.state === 'not-repository'
              ? 'text-rose-300'
              : undefined
        )}
        title={
          data?.repository.state === 'valid'
            ? data.repository.repositoryPath
            : undefined
        }
        aria-live="polite"
      >
        {!debouncedPath
          ? 'Enter a folder path on the Treeport server.'
          : directoryQuery.isFetching || !inputSettled
            ? 'Checking folder…'
            : directoryQuery.isError
              ? errorMessage(directoryQuery.error)
              : data?.repository.state === 'valid'
                ? `Will open repository: ${data.repository.repositoryPath}`
                : data?.repository.message}
      </p>

      <Button
        type="submit"
        className="self-end"
        disabled={!validRepository || busy}
      >
        {busy ? 'Opening…' : 'Open project'}
      </Button>
    </form>
  )
}
