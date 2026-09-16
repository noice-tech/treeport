import {
  CopyIcon,
  PowerIcon,
  RefreshCwIcon,
  RotateCwIcon,
  SquareIcon
} from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import type {
  ComputerDetails,
  ComputerSummary,
  LocalControlAction
} from '../desktop-contract'
import { Button, Dialog } from './ui'

function DetailRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="grid grid-cols-[8rem_minmax(0,1fr)] gap-3 py-1 text-sm">
      <dt className="text-zinc-500">{label}</dt>
      <dd className="min-w-0 break-words text-zinc-200">{value}</dd>
    </div>
  )
}

function compatibilityLabel(details: ComputerDetails): string {
  switch (details.compatibility) {
    case 'compatible':
      return 'Compatible'
    case 'backend-outdated':
      return 'Backend update required'
    case 'desktop-outdated':
      return 'Desktop update required'
    case 'unknown-version':
      return 'Unknown version'
    case null:
      return 'Unknown'
  }
}

function localControlLabel(
  state: ComputerDetails['localControl']['state']
): string {
  switch (state) {
    case 'remote':
      return 'Remote inspection only'
    case 'external':
      return 'Managed externally'
    case 'unverified':
      return 'Unverified'
    case 'running':
      return 'Verified and running'
    case 'stopped':
      return 'Verified and stopped'
    case 'unhealthy':
      return 'Verified but unhealthy'
  }
}

function lifecycleLabel(
  lifecycle: 'treeport' | 'service' | 'external' | null
): string {
  switch (lifecycle) {
    case 'treeport':
      return 'Treeport managed'
    case 'service':
      return 'OS service'
    case 'external':
      return 'Managed externally'
    case null:
      return 'Unknown'
  }
}

export function ComputerDetailsDialog({
  computer,
  onClose
}: {
  computer: ComputerSummary
  onClose: () => void
}) {
  const [details, setDetails] = useState<ComputerDetails | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  const [copied, setCopied] = useState(false)
  const [operation, setOperation] = useState<LocalControlAction | null>(null)
  const [operationError, setOperationError] = useState<string | null>(null)
  const request = useRef(0)

  const refresh = useCallback(async () => {
    const currentRequest = ++request.current
    setRefreshing(true)
    const next = await window.treeportShell.inspectComputer(computer.id)
    if (
      currentRequest !== request.current ||
      next?.computerId !== computer.id
    ) {
      return
    }

    setDetails((previous) => {
      if (!next || !previous) {
        return next
      }

      const compatibility =
        next.compatibility ??
        (next.health === null ? previous.compatibility : null)
      const preserveInventory =
        next.health === null || compatibility === 'compatible'
      return {
        ...next,
        health: next.health ?? previous.health,
        compatibility,
        inventory: preserveInventory
          ? (next.inventory ?? previous.inventory)
          : null,
        inventoryError:
          next.inventoryError ??
          (preserveInventory && previous.inventory
            ? 'Open project inventory may be stale.'
            : null)
      }
    })
    setRefreshing(false)
  }, [computer.id])

  useEffect(() => {
    void refresh()
    return () => {
      request.current += 1
    }
  }, [refresh])

  const control = async (action: LocalControlAction) => {
    if (
      action !== 'start' &&
      !window.confirm(
        `${action === 'restart' ? 'Restart' : 'Stop'} Treeport on ${computer.name}?\n\nConnected clients will be interrupted. Running terminal processes will remain active.`
      )
    ) {
      return
    }

    setOperation(action)
    setOperationError(null)
    const result = await window.treeportShell.controlComputer(
      computer.id,
      action
    )
    setOperation(null)
    if (!result.ok) {
      setOperationError(result.error ?? `Could not ${action} Treeport.`)
      return
    }

    await refresh()
  }

  const stale = Boolean(details?.health && details.healthError)
  const health = details?.health ?? null
  const inventory = details?.inventory ?? null

  return (
    <Dialog title={`${computer.name} details`} size="large" onClose={onClose}>
      <section className="flex flex-col gap-3" aria-label="Connection">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 className="text-sm font-medium text-zinc-100">Connection</h2>
            <p className="break-all font-mono text-xs text-cyan-200">
              {computer.origin}
            </p>
          </div>
          <div className="flex gap-2">
            <Button
              variant="outline"
              size="sm"
              disabled={refreshing}
              onClick={() => void refresh()}
            >
              <RefreshCwIcon data-icon="inline-start" />
              {refreshing ? 'Refreshing…' : 'Refresh'}
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={async () => {
                if (
                  await window.treeportShell.copyComputerDiagnostics(
                    computer.id
                  )
                ) {
                  setCopied(true)
                }
              }}
            >
              <CopyIcon data-icon="inline-start" />
              {copied ? 'Copied' : 'Copy diagnostics'}
            </Button>
          </div>
        </div>

        {!details ? (
          <p className="text-sm text-zinc-400">Checking Treeport…</p>
        ) : null}
        {details && !health ? (
          <p className="text-sm text-rose-300" role="alert">
            {details.healthError ?? 'Treeport is unavailable.'}
          </p>
        ) : null}
        {stale ? (
          <p className="text-sm text-amber-300" role="status">
            Latest check failed. Showing details from the last successful
            refresh.
          </p>
        ) : null}

        {details ? (
          <div className="flex flex-col gap-2 rounded-lg bg-zinc-950/50 px-3 py-2 ring-1 ring-white/8">
            <dl>
              <DetailRow
                label="Local control"
                value={localControlLabel(details.localControl.state)}
              />
            </dl>
            {details.localControl.reason ? (
              <p className="pb-1 text-xs text-zinc-500">
                {details.localControl.reason}
              </p>
            ) : null}
            {details.localControl.canStart ||
            details.localControl.canStop ||
            details.localControl.canRestart ? (
              <div className="flex flex-wrap gap-2 pb-1">
                {details.localControl.canStart ? (
                  <Button
                    variant="default"
                    size="sm"
                    disabled={operation !== null}
                    onClick={() => void control('start')}
                  >
                    <PowerIcon data-icon="inline-start" />
                    {operation === 'start' ? 'Starting…' : 'Start'}
                  </Button>
                ) : null}
                {details.localControl.canRestart ? (
                  <Button
                    variant="secondary"
                    size="sm"
                    disabled={operation !== null}
                    onClick={() => void control('restart')}
                  >
                    <RotateCwIcon data-icon="inline-start" />
                    {operation === 'restart' ? 'Restarting…' : 'Restart'}
                  </Button>
                ) : null}
                {details.localControl.canStop ? (
                  <Button
                    variant="outline"
                    size="sm"
                    className="text-rose-300 hover:text-rose-200"
                    disabled={operation !== null}
                    onClick={() => void control('stop')}
                  >
                    <SquareIcon data-icon="inline-start" />
                    {operation === 'stop' ? 'Stopping…' : 'Stop'}
                  </Button>
                ) : null}
              </div>
            ) : null}
            {operationError ? (
              <p className="pb-1 text-sm text-rose-300" role="alert">
                {operationError}
              </p>
            ) : null}
          </div>
        ) : null}

        {health ? (
          <dl className="rounded-lg bg-zinc-950/50 px-3 py-2 ring-1 ring-white/8">
            <DetailRow
              label="Reachability"
              value={stale ? 'Unavailable (cached details)' : 'Reachable'}
            />
            <DetailRow
              label="Compatibility"
              value={details ? compatibilityLabel(details) : 'Unknown'}
            />
            <DetailRow label="Version" value={health.version ?? 'Unknown'} />
            <DetailRow label="Hostname" value={health.hostname ?? 'Unknown'} />
            <DetailRow
              label="Lifecycle"
              value={lifecycleLabel(health.daemonLifecycle)}
            />
            <DetailRow
              label="Installation"
              value={health.installationMethod ?? 'Unknown'}
            />
            <DetailRow
              label="PID"
              value={health.pid === null ? 'Unknown' : String(health.pid)}
            />
            <DetailRow
              label="Instance ID"
              value={health.instanceId ?? 'Unknown'}
            />
            <DetailRow
              label="Last successful check"
              value={new Date(health.fetchedAt).toLocaleString()}
            />
          </dl>
        ) : null}
      </section>

      <section className="flex flex-col gap-3" aria-label="Open projects">
        <div>
          <h2 className="text-sm font-medium text-zinc-100">Open projects</h2>
          <p className="text-xs text-zinc-500">
            Projects currently open in this Treeport workspace, not connected
            clients.
          </p>
        </div>
        {details?.compatibility && details.compatibility !== 'compatible' ? (
          <p className="text-sm text-zinc-400">
            Project inventory is unavailable for an incompatible backend.
          </p>
        ) : null}
        {details?.inventoryError ? (
          <p className="text-sm text-amber-300" role="status">
            {details.inventoryError}
          </p>
        ) : null}
        {inventory ? (
          <>
            <p className="text-sm text-zinc-300 tabular-nums">
              {inventory.projects.length} projects · {inventory.worktrees} trees
              · {inventory.terminals} terminals
            </p>
            {inventory.projects.length > 0 ? (
              <ul className="flex max-h-64 flex-col overflow-y-auto rounded-lg bg-zinc-950/50 ring-1 ring-white/8 divide-y divide-white/8">
                {inventory.projects.map((project) => (
                  <li
                    className="flex flex-col gap-1 px-3 py-2"
                    key={project.id}
                  >
                    <div className="flex items-center justify-between gap-3 text-sm">
                      <span className="truncate font-medium text-zinc-200">
                        {project.name}
                      </span>
                      <span className="shrink-0 text-xs text-zinc-500 tabular-nums">
                        {project.worktrees} trees · {project.terminals}{' '}
                        terminals
                      </span>
                    </div>
                    <p className="truncate font-mono text-xs text-zinc-500">
                      {project.rootPath}
                    </p>
                    {project.availability === 'unavailable' ? (
                      <p className="text-xs text-amber-300">Unavailable</p>
                    ) : null}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-zinc-500">No projects are open.</p>
            )}
          </>
        ) : null}
      </section>
    </Dialog>
  )
}
