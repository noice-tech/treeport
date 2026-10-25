import * as DialogPrimitive from '@radix-ui/react-dialog'
import { XIcon } from 'lucide-react'
import {
  forwardRef,
  useId,
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode
} from 'react'

export function cn(...values: Array<string | undefined | false>): string {
  return values.filter(Boolean).join(' ')
}

const buttonVariants = {
  default:
    'bg-accent-solid text-on-accent ring-1 ring-accent-solid hover:bg-accent-solid-hover hover:ring-accent-solid-hover active:scale-[0.97] active:bg-accent-solid active:ring-accent-solid',
  secondary:
    'bg-zinc-800 text-zinc-100 ring-1 ring-white/8 hover:bg-zinc-700 active:scale-[0.97] active:bg-zinc-800',
  destructive:
    'bg-rose-600 text-white ring-1 ring-rose-600 hover:bg-rose-500 hover:ring-rose-500 active:scale-[0.97] active:bg-rose-600 active:ring-rose-600',
  outline:
    'bg-transparent text-zinc-200 ring-1 ring-white/12 hover:bg-white/6 active:scale-[0.97] active:bg-white/10',
  ghost:
    'bg-transparent text-zinc-400 hover:bg-white/6 hover:text-zinc-100 active:bg-white/10',
  link: 'h-auto rounded-none p-0 text-zinc-400 hover:text-zinc-100 active:text-zinc-300'
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
      children,
      ...props
    },
    ref
  ) => {
    return (
      <button
        ref={ref}
        type={type}
        className={cn(
          'relative inline-flex shrink-0 cursor-pointer items-center justify-center gap-1.5 rounded-md font-medium whitespace-nowrap outline-none transition-[opacity,transform] duration-100 ease-out disabled:pointer-events-none disabled:cursor-default disabled:opacity-45 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-400 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0',
          buttonVariants[variant],
          size ? buttonSizes[size] : undefined,
          className
        )}
        {...props}
      >
        {children}
        {size !== 'xs' && size !== null ? (
          <span
            className="absolute top-1/2 left-1/2 size-[max(100%,3rem)] -translate-1/2 pointer-fine:hidden"
            aria-hidden="true"
          />
        ) : null}
      </button>
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
      'h-9 w-full rounded-md bg-zinc-950/70 px-3 py-2 text-sm text-zinc-100 ring-1 ring-white/12 outline-none placeholder:text-zinc-600 focus-visible:ring-2 focus-visible:ring-accent-400 disabled:cursor-not-allowed disabled:opacity-50',
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
    <label
      className="text-base font-medium text-zinc-200 sm:text-sm"
      htmlFor={htmlFor}
    >
      {children}
    </label>
  )
}

export function Dialog({
  children,
  description,
  footer,
  onClose,
  onCloseAutoFocus,
  role = 'dialog',
  showCloseButton = true,
  size = 'default',
  title
}: {
  children: ReactNode
  description?: string
  footer?: ReactNode
  onClose: () => void
  onCloseAutoFocus?: (event: Event) => void
  role?: 'dialog' | 'alertdialog'
  showCloseButton?: boolean
  size?: 'default' | 'large'
  title: string
}) {
  const descriptionId = useId()

  return (
    <DialogPrimitive.Root open onOpenChange={(open) => !open && onClose()}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 bg-zinc-950/80" />
        <DialogPrimitive.Content
          className={cn(
            'fixed top-1/2 left-1/2 flex max-h-[calc(100dvh-2rem)] w-[calc(100vw-2rem)] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-xl bg-zinc-900 text-zinc-200 ring-1 ring-white/10 outline-none',
            size === 'large' ? 'max-w-2xl' : 'max-w-md'
          )}
          role={role}
          aria-describedby={description ? descriptionId : undefined}
          onCloseAutoFocus={(event) => onCloseAutoFocus?.(event)}
          onInteractOutside={(event) => {
            if (role === 'alertdialog') {
              event.preventDefault()
            }
          }}
        >
          <header
            className={cn(
              'flex shrink-0 justify-between gap-3 border-b border-white/8',
              description ? 'items-start p-4 sm:p-5' : 'h-11 items-center px-4'
            )}
          >
            <div className="flex min-w-0 flex-col gap-1.5">
              <DialogPrimitive.Title
                className={cn(
                  'font-medium text-balance text-zinc-50',
                  description ? 'text-lg' : 'text-base'
                )}
              >
                {title}
              </DialogPrimitive.Title>
              {description ? (
                <DialogPrimitive.Description
                  id={descriptionId}
                  className="text-base text-pretty text-zinc-400 sm:text-sm"
                >
                  {description}
                </DialogPrimitive.Description>
              ) : null}
            </div>
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
          {footer ? (
            <footer className="shrink-0 border-t border-white/8 p-4 sm:px-5">
              {footer}
            </footer>
          ) : null}
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  )
}
