import type { ErrorComponentProps } from '@tanstack/react-router'
import { Button } from './components/ui/button'

export function AppErrorFallback({ reset }: ErrorComponentProps) {
  return (
    <main
      className="grid min-h-dvh place-items-center bg-zinc-950 p-6 text-zinc-100"
      aria-labelledby="app-error-title"
    >
      <section
        className="w-full max-w-lg rounded-xl bg-zinc-900 p-6 shadow-2xl ring-1 ring-white/10"
        role="alert"
      >
        <p className="text-sm font-medium text-rose-300">Unexpected error</p>
        <h1 id="app-error-title" className="mt-2 text-xl font-semibold">
          Treeport couldn’t display this workspace
        </h1>
        <p className="mt-3 text-sm text-zinc-400">
          Try recovering the interface. If the problem continues, reload
          Treeport; your persistent terminal sessions will keep running.
        </p>
        <div className="mt-6 flex flex-wrap gap-3">
          <Button type="button" onClick={reset}>
            Try again
          </Button>
          <Button
            type="button"
            variant="secondary"
            onClick={() => window.location.reload()}
          >
            Reload Treeport
          </Button>
        </div>
      </section>
    </main>
  )
}
