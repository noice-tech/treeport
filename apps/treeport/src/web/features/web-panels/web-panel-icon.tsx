import { useState } from 'react'
import { WindowIcon } from '@heroicons/react/16/solid'
import { cn } from '../../lib/utils'

export function WebPanelIcon({
  icon,
  className
}: {
  icon: string | null
  className?: string
}) {
  const [failedIcon, setFailedIcon] = useState<string | null>(null)

  return icon && icon !== failedIcon ? (
    <img
      src={icon}
      alt=""
      data-icon="inline-start"
      className={cn('size-4 shrink-0 object-contain', className)}
      aria-hidden="true"
      onError={() => setFailedIcon(icon)}
    />
  ) : (
    <WindowIcon
      data-icon="inline-start"
      className={className}
      aria-hidden="true"
    />
  )
}
