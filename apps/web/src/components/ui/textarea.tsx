import * as React from 'react'
import { cn } from '../../lib/utils.js'

function Textarea({ className, ...props }: React.ComponentProps<'textarea'>) {
  return (
    <textarea
      data-slot="textarea"
      className={cn(
        'min-h-24 w-full resize-y rounded-md bg-zinc-950/70 px-3 py-2.5 text-base text-zinc-100 ring-1 ring-white/12 outline-none transition-shadow placeholder:text-zinc-600 focus-visible:ring-2 focus-visible:ring-cyan-400 disabled:cursor-not-allowed disabled:opacity-50 sm:min-h-20 sm:py-2 sm:text-sm',
        className
      )}
      {...props}
    />
  )
}

export { Textarea }
