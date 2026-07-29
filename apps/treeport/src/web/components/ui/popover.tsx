import * as React from 'react'
import * as PopoverPrimitive from '@radix-ui/react-popover'
import { cn } from '../../lib/utils'

function Popover(props: React.ComponentProps<typeof PopoverPrimitive.Root>) {
  return <PopoverPrimitive.Root {...props} />
}

function PopoverTrigger(
  props: React.ComponentProps<typeof PopoverPrimitive.Trigger>
) {
  return <PopoverPrimitive.Trigger {...props} />
}

function PopoverContent({
  className,
  align = 'start',
  sideOffset = 6,
  portalled = true,
  ...props
}: React.ComponentProps<typeof PopoverPrimitive.Content> & {
  portalled?: boolean
}) {
  const content = (
    <PopoverPrimitive.Content
      align={align}
      sideOffset={sideOffset}
      className={cn(
        'z-100 w-52 rounded-lg bg-zinc-900 p-3 text-zinc-200 shadow-xl ring-1 ring-white/10 outline-none',
        className
      )}
      {...props}
    />
  )

  return portalled ? (
    <PopoverPrimitive.Portal>{content}</PopoverPrimitive.Portal>
  ) : (
    content
  )
}

export { Popover, PopoverContent, PopoverTrigger }
