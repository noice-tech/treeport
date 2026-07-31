import * as React from 'react'
import * as ContextMenuPrimitive from '@radix-ui/react-context-menu'
import { cn } from '../../lib/utils'

function ContextMenu(
  props: React.ComponentProps<typeof ContextMenuPrimitive.Root>
) {
  return <ContextMenuPrimitive.Root {...props} />
}

function ContextMenuTrigger(
  props: React.ComponentProps<typeof ContextMenuPrimitive.Trigger>
) {
  return <ContextMenuPrimitive.Trigger {...props} />
}

function ContextMenuContent({
  className,
  ...props
}: React.ComponentProps<typeof ContextMenuPrimitive.Content>) {
  return (
    <ContextMenuPrimitive.Portal>
      <ContextMenuPrimitive.Content
        className={cn(
          'z-100 min-w-44 max-w-[calc(100vw-1rem)] rounded-md bg-zinc-900 p-1 text-zinc-200 shadow-xl ring-1 ring-white/10 outline-none',
          className
        )}
        {...props}
      />
    </ContextMenuPrimitive.Portal>
  )
}

function ContextMenuGroup(
  props: React.ComponentProps<typeof ContextMenuPrimitive.Group>
) {
  return <ContextMenuPrimitive.Group {...props} />
}

function ContextMenuItem({
  className,
  variant = 'default',
  ...props
}: React.ComponentProps<typeof ContextMenuPrimitive.Item> & {
  variant?: 'default' | 'destructive'
}) {
  return (
    <ContextMenuPrimitive.Item
      data-variant={variant}
      className={cn(
        'relative flex min-h-8 cursor-default items-center gap-1.5 rounded-sm px-2 py-1.5 text-sm outline-none select-none [&_svg]:size-3.5 [&_svg]:shrink-0 data-[disabled]:pointer-events-none data-[disabled]:opacity-45 data-[highlighted]:bg-white/7 data-[highlighted]:text-zinc-50 data-[variant=destructive]:text-rose-300',
        className
      )}
      {...props}
    />
  )
}

export {
  ContextMenu,
  ContextMenuContent,
  ContextMenuGroup,
  ContextMenuItem,
  ContextMenuTrigger
}
