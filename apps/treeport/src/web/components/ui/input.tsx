import * as React from 'react'
import { cn } from '../../lib/utils'

function Input({ className, type, ...props }: React.ComponentProps<'input'>) {
  return (
    <input
      type={type}
      data-slot="input"
      className={cn(
        'h-9 w-full rounded-md bg-zinc-950/70 px-3 py-2 text-base text-zinc-100 ring-1 ring-white/12 outline-none transition-shadow placeholder:text-zinc-600 focus-visible:ring-2 focus-visible:ring-cyan-400 disabled:cursor-not-allowed disabled:opacity-50 sm:text-sm max-[700px]:h-8 max-[700px]:px-2 max-[700px]:py-1',
        className
      )}
      {...props}
    />
  )
}

export { Input }
