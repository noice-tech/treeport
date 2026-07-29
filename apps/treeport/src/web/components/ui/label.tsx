import * as React from 'react'
import { cn } from '../../lib/utils'

function Label({ className, ...props }: React.ComponentProps<'label'>) {
  return (
    <label
      data-slot="label"
      className={cn(
        'flex text-base font-medium text-zinc-300 sm:text-sm',
        className
      )}
      {...props}
    />
  )
}

export { Label }
