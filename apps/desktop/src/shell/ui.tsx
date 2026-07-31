import * as DialogPrimitive from '@radix-ui/react-dialog'
import { XIcon } from 'lucide-react'
import {
  forwardRef,
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode
} from 'react'

function cn(...values: Array<string | undefined | false>): string {
  return values.filter(Boolean).join(' ')
}

const buttonVariants = {
  default:
    'bg-cyan-600 text-white ring-1 ring-cyan-600 hover:bg-cyan-500 hover:ring-cyan-500',
  secondary: 'bg-zinc-800 text-zinc-100 ring-1 ring-white/8 hover:bg-zinc-700',
  outline: 'bg-transparent text-zinc-200 ring-1 ring-white/12 hover:bg-white/6',
  ghost: 'bg-transparent text-zinc-400 hover:bg-white/6 hover:text-zinc-100',
  link: 'h-auto rounded-none p-0 text-zinc-400 hover:text-zinc-100'
} as const

const buttonSizes = {
  default: 'h-9 px-3 py-2 text-sm',
  sm: 'h-7 px-2.5 text-sm',
  xs: 'h-6 px-1.5 text-xs'
} as const

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: keyof typeof buttonVariants
  size?: keyof typeof buttonSizes | null
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  (
    {
      className,
      variant = 'secondary',
      size = variant === 'link' ? null : 'default',
      type = 'button',
      ...props
    },
    ref
  ) => {
    return (
      <button
        ref={ref}
        type={type}
        className={cn(
          'relative inline-flex shrink-0 cursor-pointer items-center justify-center gap-1.5 rounded-md font-medium whitespace-nowrap outline-none disabled:pointer-events-none disabled:cursor-default disabled:opacity-45 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan-400 [&_svg]:pointer-events-none [&_svg]:size-3 [&_svg]:shrink-0',
          buttonVariants[variant],
          size ? buttonSizes[size] : undefined,
          className
        )}
        {...props}
      />
    )
  }
)
Button.displayName = 'Button'

export const Input = forwardRef<
  HTMLInputElement,
  InputHTMLAttributes<HTMLInputElement>
>(({ className, ...props }, ref) => (
  <input
    ref={ref}
    className={cn(
      'h-9 w-full rounded-md bg-zinc-950/70 px-3 py-2 text-sm text-zinc-100 ring-1 ring-white/12 outline-none placeholder:text-zinc-600 focus-visible:ring-2 focus-visible:ring-cyan-400 disabled:cursor-not-allowed disabled:opacity-50',
      className
    )}
    {...props}
  />
))
Input.displayName = 'Input'

export function Field({
  children,
  className
}: {
  children: ReactNode
  className?: string
}) {
  return <div className={cn('grid gap-2', className)}>{children}</div>
}

export function FieldLabel({
  children,
  htmlFor
}: {
  children: ReactNode
  htmlFor: string
}) {
  return (
    <label className="text-sm font-medium text-zinc-200" htmlFor={htmlFor}>
      {children}
    </label>
  )
}

export function Dialog({
  children,
  onClose,
  showCloseButton = true,
  size = 'default',
  title
}: {
  children: ReactNode
  onClose: () => void
  showCloseButton?: boolean
  size?: 'default' | 'large'
  title: string
}) {
  return (
    <DialogPrimitive.Root open onOpenChange={(open) => !open && onClose()}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 bg-zinc-950/80" />
        <DialogPrimitive.Content
          className={cn(
            'fixed top-1/2 left-1/2 flex max-h-[calc(100dvh-2rem)] w-[calc(100vw-2rem)] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-xl bg-zinc-900 text-zinc-200 shadow-2xl ring-1 ring-white/10 outline-none',
            size === 'large' ? 'max-w-2xl' : 'max-w-md'
          )}
        >
          <header className="flex h-11 shrink-0 items-center justify-between gap-3 border-b border-white/8 px-4">
            <DialogPrimitive.Title className="text-balance text-base font-medium text-zinc-50">
              {title}
            </DialogPrimitive.Title>
            {showCloseButton ? (
              <DialogPrimitive.Close asChild>
                <Button variant="ghost" size="sm" aria-label="Close">
                  <XIcon data-icon="inline-start" />
                </Button>
              </DialogPrimitive.Close>
            ) : null}
          </header>
          <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-4 sm:p-5">
            {children}
          </div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  )
}
