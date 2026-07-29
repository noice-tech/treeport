import * as React from 'react'
import { Slot } from '@radix-ui/react-slot'
import { cva, type VariantProps } from 'class-variance-authority'
import { cn } from '../../lib/utils'

const buttonVariants = cva(
  'relative inline-flex shrink-0 items-center justify-center gap-1.5 rounded-md text-sm font-medium whitespace-nowrap outline-none disabled:pointer-events-none disabled:opacity-45 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan-400',
  {
    variants: {
      variant: {
        default:
          'bg-cyan-600 text-white ring-1 ring-cyan-600 hover:bg-cyan-500 hover:ring-cyan-500',
        secondary:
          'bg-zinc-800 text-zinc-100 ring-1 ring-white/8 hover:bg-zinc-700',
        destructive:
          'bg-rose-700 text-white ring-1 ring-rose-700 hover:bg-rose-600',
        outline:
          'bg-transparent text-zinc-200 ring-1 ring-white/12 hover:bg-white/6',
        ghost:
          'bg-transparent text-zinc-400 hover:bg-white/6 hover:text-zinc-100',
        link: 'h-auto rounded-none p-0 text-zinc-400 hover:text-zinc-100'
      },
      size: {
        default:
          'h-9 px-3 py-2 has-[>svg:first-child]:pl-2 has-[>svg:last-child]:pr-2',
        sm: 'h-7 px-2.5 text-sm has-[>svg:first-child]:pl-1.5 has-[>svg:last-child]:pr-1.5',
        icon: 'size-9 p-0',
        'icon-sm': 'size-7 p-0'
      }
    },
    defaultVariants: {
      variant: 'default',
      size: 'default'
    }
  }
)

function Button({
  className,
  variant,
  size,
  asChild = false,
  ...props
}: React.ComponentProps<'button'> &
  VariantProps<typeof buttonVariants> & {
    asChild?: boolean
  }) {
  const Component = asChild ? Slot : 'button'
  return (
    <Component
      data-slot="button"
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    />
  )
}

export { Button, buttonVariants }
