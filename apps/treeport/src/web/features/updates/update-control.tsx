import { useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { DownloadIcon, LoaderCircleIcon, TriangleAlertIcon } from 'lucide-react'
import { parseResponse, rpc } from '../../api'
import { Button } from '../../components/ui/button'
import { errorMessage } from '../../error-message'
import {
  Popover,
  PopoverContent,
  PopoverTrigger
} from '../../components/ui/popover'

const pendingUpdateStorageKey = 'treeport:pending-application-update'

async function getApplicationUpdate() {
  return parseResponse(rpc.api.update.$get())
}

async function startApplicationUpdate() {
  return parseResponse(rpc.api.update.$post())
}

type ApplicationUpdateStatus = Awaited<ReturnType<typeof getApplicationUpdate>>

const activePhases = new Set<ApplicationUpdateStatus['phase']>([
  'starting',
  'inspect',
  'resolve',
  'stage',
  'verify',
  'stop',
  'activate',
  'restart',
  'health_check',
  'rollback'
])

function backendUpdateEnabled(
  desktopClient: boolean,
  hostname: string
): boolean {
  return (
    !desktopClient ||
    ['127.0.0.1', 'localhost', '::1', '[::1]'].includes(hostname)
  )
}

export function UpdateControl() {
  const enabled = backendUpdateEnabled(
    Boolean(window.treeportDesktop),
    window.location.hostname
  )
  const queryClient = useQueryClient()
  const [open, setOpen] = useState(false)
  const [requestError, setRequestError] = useState<string | null>(null)
  const statusQuery = useQuery({
    queryKey: ['application-update'],
    queryFn: getApplicationUpdate,
    enabled,
    refetchInterval: (query) => {
      const data = query.state.data
      return activePhases.has(data?.phase ?? 'idle')
        ? 1_000
        : data?.checkedAt
          ? 60_000
          : 5_000
    },
    refetchIntervalInBackground: true,
    staleTime: 30_000
  })
  const status = statusQuery.data
  const update = useMutation({
    mutationFn: startApplicationUpdate,
    onMutate: () => {
      setRequestError(null)
      if (status?.latestVersion) {
        sessionStorage.setItem(pendingUpdateStorageKey, status.latestVersion)
      }
    },
    onSuccess: (nextStatus) => {
      queryClient.setQueryData<ApplicationUpdateStatus>(
        ['application-update'],
        nextStatus
      )
    },
    onError: (error) => {
      sessionStorage.removeItem(pendingUpdateStorageKey)
      setRequestError(errorMessage(error))
    }
  })

  useEffect(() => {
    const targetVersion = sessionStorage.getItem(pendingUpdateStorageKey)
    if (!targetVersion || !status) {
      return
    }

    if (
      status.currentVersion === (status.targetVersion ?? targetVersion) &&
      status.phase === 'complete'
    ) {
      sessionStorage.removeItem(pendingUpdateStorageKey)
      window.location.reload()
      return
    }

    if (status.phase === 'failed' || status.phase === 'recovery_required') {
      sessionStorage.removeItem(pendingUpdateStorageKey)
    }
  }, [status])

  const updating = Boolean(
    update.isPending || (status && activePhases.has(status.phase))
  )
  const failed = Boolean(
    requestError ||
    status?.phase === 'failed' ||
    status?.phase === 'recovery_required'
  )
  const visible = Boolean(
    enabled && (status?.updateAvailable || updating || failed)
  )
  const error = requestError ?? status?.error ?? null
  const progress =
    update.isPending || status?.phase === 'starting'
      ? 'Starting the update…'
      : status?.phase === 'inspect' || status?.phase === 'resolve'
        ? 'Preparing the update…'
        : status?.phase === 'stage'
          ? 'Downloading the update…'
          : status?.phase === 'verify'
            ? 'Verifying the update…'
            : status?.phase === 'stop' || status?.phase === 'activate'
              ? 'Installing the update…'
              : status?.phase === 'restart' || status?.phase === 'health_check'
                ? 'Restarting Treeport and reconnecting…'
                : status?.phase === 'rollback'
                  ? 'Restoring the previous version…'
                  : null

  if (!visible) {
    return <div className="size-9 shrink-0" aria-hidden />
  }

  return (
    <div className="size-9 shrink-0">
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button
            type="button"
            size="icon"
            variant="ghost"
            className={
              failed
                ? 'icon-button text-amber-300 hover:bg-white/5 hover:text-amber-100'
                : 'icon-button text-cyan-300 hover:bg-white/5 hover:text-cyan-100'
            }
            aria-label={
              failed
                ? 'Treeport update failed'
                : updating
                  ? 'Treeport update in progress'
                  : `Treeport ${status?.latestVersion ?? ''} update available`
            }
          >
            {failed ? (
              <TriangleAlertIcon />
            ) : updating ? (
              <LoaderCircleIcon className="animate-spin" />
            ) : (
              <DownloadIcon />
            )}
            <span className="touch-target" aria-hidden />
          </Button>
        </PopoverTrigger>
        <PopoverContent
          align="end"
          className="flex w-[min(20rem,calc(100vw-1rem))] flex-col gap-3"
          aria-label="Treeport update"
        >
          <div className="flex flex-col gap-1">
            <h2 className="text-sm font-semibold text-zinc-100">
              {failed
                ? 'Treeport update failed'
                : updating
                  ? 'Updating Treeport'
                  : `Treeport ${status?.latestVersion} is available`}
            </h2>
            {status?.latestVersion ? (
              <p className="text-sm text-zinc-400">
                Installed {status.currentVersion} · Available{' '}
                {status.latestVersion}
              </p>
            ) : null}
          </div>

          <div aria-live="polite">
            {progress ? (
              <p className="text-sm text-zinc-300">{progress}</p>
            ) : error ? (
              <p className="text-sm text-amber-200">{error}</p>
            ) : status?.canUpdate ? (
              <p className="text-sm text-zinc-300">
                Treeport will restart. Running terminals will stay active.
              </p>
            ) : (
              <p className="text-sm text-amber-200">
                {status?.blockedReason ??
                  'Treeport cannot install this update.'}
              </p>
            )}
          </div>

          {!updating && status?.updateAvailable ? (
            <Button
              type="button"
              disabled={!status.canUpdate}
              onClick={() => update.mutate()}
            >
              <DownloadIcon data-icon="inline-start" />
              Update Treeport
            </Button>
          ) : null}
        </PopoverContent>
      </Popover>
    </div>
  )
}
