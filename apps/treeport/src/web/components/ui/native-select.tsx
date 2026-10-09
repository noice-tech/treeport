import * as React from 'react'
import { ChevronDownIcon } from '@heroicons/react/16/solid'
import { cn } from '../../lib/utils'

function NativeSelect({
  className,
  children,
  ...props
}: React.ComponentProps<'select'>) {
  return (
    <span className="grid grid-cols-[1fr_--spacing(8)]">
      <select
        data-slot="native-select"
        className={cn(
          'col-span-full row-start-1 h-9 w-full appearance-none rounded-md bg-zinc-950/70 py-2 pr-8 pl-3 text-base text-zinc-100 ring-1 ring-white/12 outline-none focus-visible:ring-2 focus-visible:ring-cyan-400 sm:text-sm max-[700px]:h-8 max-[700px]:py-1 max-[700px]:pl-2',
          className
        )}
        {...props}
      >
        {children}
      </select>
      <ChevronDownIcon className="pointer-events-none col-start-2 row-start-1 size-4 place-self-center text-zinc-500" />
    </span>
  )
}

export { NativeSelect }
