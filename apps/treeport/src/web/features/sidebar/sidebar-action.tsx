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
  tooltipSide = 'top',
  className,
  disabled,
  keyShortcuts,
  onClick,
  children
}: {
  label: string
  tooltip?: string
  tooltipSide?: 'top' | 'right' | 'bottom' | 'left'
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
      <TooltipContent side={tooltipSide}>{tooltip}</TooltipContent>
    </Tooltip>
  )
}
