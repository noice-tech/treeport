import * as React from 'react'
import { Slot } from '@radix-ui/react-slot'
import { cva, type VariantProps } from 'class-variance-authority'
import { cn } from '../../lib/utils'

const badgeVariants = cva(
  'inline-flex shrink-0 items-center justify-center rounded-full font-medium whitespace-nowrap',
  {
    variants: {
      variant: {
        default: 'bg-cyan-600 text-white',
        secondary: 'bg-zinc-800 text-zinc-200',
        outline: 'text-zinc-200 ring-1 ring-white/12'
      },
      size: {
        default: 'px-1.5 py-0.5 text-xs',
        counter: 'h-4 min-w-4 px-1 text-[0.625rem] font-semibold tabular-nums'
      }
    },
    defaultVariants: { variant: 'default', size: 'default' }
  }
)

function Badge({
  className,
  variant,
  size,
  asChild = false,
  ...props
}: React.ComponentProps<'span'> &
  VariantProps<typeof badgeVariants> & { asChild?: boolean }) {
  const Component = asChild ? Slot : 'span'
  return (
    <Component
      data-slot="badge"
      className={cn(badgeVariants({ variant, size, className }))}
      {...props}
    />
  )
}

export { Badge, badgeVariants }
