import type { TerminalProgram, TerminalProgress } from '@treeport/shared'
import { cn } from '../lib/utils'

export function TerminalStatusIcon({
  program,
  progress,
  attention,
  exited,
  className,
  title
}: {
  program: TerminalProgram | null
  progress: TerminalProgress | null
  attention: boolean
  exited: boolean
  className?: string
  title?: string
}) {
  const working =
    progress !== null &&
    !attention &&
    progress.state !== 'paused' &&
    progress.state !== 'error'
  const iconColor = attention
    ? 'text-amber-300'
    : progress?.state === 'error'
      ? 'text-rose-300'
      : progress?.state === 'paused'
        ? 'text-amber-300'
        : exited && !progress
          ? 'text-rose-300'
          : working
            ? 'text-cyan-400'
            : 'text-zinc-500'

  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      className={cn('shrink-0 overflow-visible', className)}
      aria-hidden={title ? undefined : true}
    >
      {title ? <title>{title}</title> : null}
      <g
        className={cn(
          'origin-center transition-[color,transform] duration-500',
          iconColor,
          working && 'scale-[0.62]'
        )}
      >
        {program === 'pi' ? (
          <svg viewBox="0 0 800 800" width="24" height="24">
            <path
              fill="currentColor"
              fillRule="evenodd"
              d="M165.29 165.29H517.36V400H400V517.36H282.65V634.72H165.29ZM282.65 282.65V400H400V282.65Z"
            />
            <path fill="currentColor" d="M517.36 400H634.72V634.72H517.36Z" />
          </svg>
        ) : program === 'claude' ? (
          <path
            fill="currentColor"
            fillRule="evenodd"
            clipRule="evenodd"
            d="M20.998 10.949H24v3.102h-3v3.028h-1.487V20H18v-2.921h-1.487V20H15v-2.921H9V20H7.488v-2.921H6V20H4.487v-2.921H3V14.05H0V10.95h3V5h17.998v5.949zM6 10.949h1.488V8.102H6v2.847zm10.51 0H18V8.102h-1.49v2.847z"
          />
        ) : program === 'codex' ? (
          <path
            fill="currentColor"
            fillRule="evenodd"
            clipRule="evenodd"
            d="M8.086.457a6.105 6.105 0 013.046-.415c1.333.153 2.521.72 3.564 1.7a.117.117 0 00.107.029c1.408-.346 2.762-.224 4.061.366l.063.03.154.076c1.357.703 2.33 1.77 2.918 3.198.278.679.418 1.388.421 2.126a5.655 5.655 0 01-.18 1.631.167.167 0 00.04.155 5.982 5.982 0 011.578 2.891c.385 1.901-.01 3.615-1.183 5.14l-.182.22a6.063 6.063 0 01-2.934 1.851.162.162 0 00-.108.102c-.255.736-.511 1.364-.987 1.992-1.199 1.582-2.962 2.462-4.948 2.451-1.583-.008-2.986-.587-4.21-1.736a.145.145 0 00-.14-.032c-.518.167-1.04.191-1.604.185a5.924 5.924 0 01-2.595-.622 6.058 6.058 0 01-2.146-1.781c-.203-.269-.404-.522-.551-.821a7.74 7.74 0 01-.495-1.283 6.11 6.11 0 01-.017-3.064.166.166 0 00.008-.074.115.115 0 00-.037-.064 5.958 5.958 0 01-1.38-2.202 5.196 5.196 0 01-.333-1.589 6.915 6.915 0 01.188-2.132c.45-1.484 1.309-2.648 2.577-3.493.282-.188.55-.334.802-.438.286-.12.573-.22.861-.304a.129.129 0 00.087-.087A6.016 6.016 0 015.635 2.31C6.315 1.464 7.132.846 8.086.457zm-.804 7.85a.848.848 0 00-1.473.842l1.694 2.965-1.688 2.848a.849.849 0 001.46.864l1.94-3.272a.849.849 0 00.007-.854l-1.94-3.393zm5.446 6.24a.849.849 0 000 1.695h4.848a.849.849 0 000-1.696h-4.848z"
          />
        ) : (
          <g
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <polyline points="4 17 10 11 4 5" />
            <line x1="12" y1="19" x2="20" y2="19" />
          </g>
        )}
      </g>

      <g
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        className="text-cyan-400"
      >
        <rect
          x="3"
          y="3"
          width="18"
          height="18"
          rx="5"
          className={cn(
            'opacity-0 transition-opacity duration-500',
            working && 'opacity-25'
          )}
        />
        <rect
          x="3"
          y="3"
          width="18"
          height="18"
          rx="5"
          pathLength="100"
          strokeDasharray="30 70"
          className={cn(
            'opacity-0 transition-opacity duration-500',
            working && 'animate-comet opacity-100 motion-reduce:animate-none'
          )}
        />
      </g>
    </svg>
  )
}
