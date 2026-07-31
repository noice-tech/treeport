import type { ReactNode } from 'react'
import { Button } from '../../components/ui/button'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger
} from '../../components/ui/tooltip'

export function SidebarAction({
  label,
  tooltip = label,
  className,
  disabled,
  keyShortcuts,
  onClick,
  children
}: {
  label: string
  tooltip?: string
  className?: string
  disabled?: boolean
  keyShortcuts?: string
  onClick: (trigger: HTMLButtonElement) => void
  children: ReactNode
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          className={className}
          aria-label={label}
          aria-keyshortcuts={keyShortcuts}
          disabled={disabled}
          onClick={(event) => onClick(event.currentTarget)}
        >
          {children}
          <span className="touch-target" aria-hidden="true" />
        </Button>
      </TooltipTrigger>
      <TooltipContent side="top">{tooltip}</TooltipContent>
    </Tooltip>
  )
}
