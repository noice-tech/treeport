import * as React from 'react'
import { Slot } from '@radix-ui/react-slot'
import { cva, type VariantProps } from 'class-variance-authority'
import { cn } from '../../lib/utils'

// Popovers anchor to their trigger's transformed rect, so popup triggers skip the press scale.
const buttonVariants = cva(
  'relative inline-flex shrink-0 items-center justify-center gap-1.5 rounded-md text-sm font-medium whitespace-nowrap outline-none transition-[opacity,transform] duration-100 ease-out [&[aria-haspopup]]:active:scale-100 disabled:pointer-events-none disabled:opacity-45 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-400',
  {
    variants: {
      variant: {
        default:
          'bg-accent-400 text-accent-950 ring-1 ring-accent-400 hover:bg-accent-300 hover:ring-accent-300 active:scale-[0.97] active:bg-accent-400 active:ring-accent-400',
        secondary:
          'bg-zinc-800 text-zinc-100 ring-1 ring-white/8 hover:bg-zinc-700 active:scale-[0.97] active:bg-zinc-800',
        destructive:
          'bg-rose-700 text-white ring-1 ring-rose-700 hover:bg-rose-600 active:scale-[0.97] active:bg-rose-700',
        outline:
          'bg-transparent text-zinc-200 ring-1 ring-white/12 hover:bg-white/6 active:scale-[0.97] active:bg-white/10',
        ghost:
          'bg-transparent text-zinc-400 hover:bg-white/6 hover:text-zinc-100 active:bg-white/10',
        link: 'h-auto rounded-none p-0 text-zinc-400 hover:text-zinc-100 active:text-zinc-300'
      },
      size: {
        default:
          'h-9 px-3 py-2 has-[>svg:first-child]:pl-2 has-[>svg:last-child]:pr-2 max-[700px]:h-8 max-[700px]:px-2 max-[700px]:py-1 max-[700px]:text-[0.8125rem]',
        sm: 'h-7 px-2.5 text-sm has-[>svg:first-child]:pl-1.5 has-[>svg:last-child]:pr-1.5',
        icon: 'size-9 p-0 active:scale-[0.92] max-[700px]:size-8',
        'icon-sm': 'size-7 p-0 active:scale-[0.92]'
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
