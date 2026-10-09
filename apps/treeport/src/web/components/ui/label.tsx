import * as React from 'react'
import { cn } from '../../lib/utils'

function Label({ className, ...props }: React.ComponentProps<'label'>) {
  return (
    <label
      data-slot="label"
      className={cn(
        'flex text-sm font-medium text-zinc-300 max-[700px]:text-[0.8125rem]/4',
        className
      )}
      {...props}
    />
  )
}

export { Label }
