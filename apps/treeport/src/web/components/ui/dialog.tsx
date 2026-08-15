import * as React from 'react'
import * as DialogPrimitive from '@radix-ui/react-dialog'
import { XIcon } from 'lucide-react'
import { cn } from '../../lib/utils'

const Dialog = DialogPrimitive.Root
const DialogPortal = DialogPrimitive.Portal

function subscribeToVisualViewport(onChange: () => void) {
  const viewport = window.visualViewport
  if (!viewport) {
    return () => undefined
  }

  viewport.addEventListener('resize', onChange)
  viewport.addEventListener('scroll', onChange)
  return () => {
    viewport.removeEventListener('resize', onChange)
    viewport.removeEventListener('scroll', onChange)
  }
}

function getVisualViewportSnapshot() {
  const viewport = window.visualViewport
  return viewport ? `${viewport.offsetTop}:${viewport.height}` : null
}

const DialogOverlay = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Overlay>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Overlay>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Overlay
    ref={ref}
    className={cn('fixed inset-0 z-50 bg-black/70 backdrop-blur-sm', className)}
    {...props}
  />
))
DialogOverlay.displayName = DialogPrimitive.Overlay.displayName

const DialogContent = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Content> & {
    restoreFocusTo?: HTMLElement | null
    mobilePresentation?: 'sheet' | 'dialog'
    overlayClassName?: string
  }
>(
  (
    {
      className,
      children,
      restoreFocusTo,
      mobilePresentation = 'sheet',
      overlayClassName,
      onCloseAutoFocus,
      style,
      ...props
    },
    ref
  ) => {
    const viewportSnapshot = React.useSyncExternalStore(
      subscribeToVisualViewport,
      getVisualViewportSnapshot,
      () => null
    )
    const [viewportTop, viewportHeight] = viewportSnapshot
      ?.split(':')
      .map(Number) ?? [null, null]

    return (
      <DialogPortal>
        <DialogOverlay className={overlayClassName} />
        <DialogPrimitive.Content
          ref={ref}
          className={cn(
            'fixed top-1/2 left-1/2 z-50 grid max-h-[calc(100dvh-2rem)] w-[calc(100%-2rem)] max-w-lg -translate-x-1/2 -translate-y-1/2 gap-4 overflow-y-auto rounded-xl bg-zinc-900 p-6 text-zinc-200 shadow-2xl ring-1 ring-white/10 outline-none max-[700px]:top-auto max-[700px]:bottom-0 max-[700px]:left-0 max-[700px]:max-h-[90dvh] max-[700px]:w-full max-[700px]:max-w-none max-[700px]:translate-x-0 max-[700px]:translate-y-0 max-[700px]:rounded-b-none max-[700px]:p-5 max-[700px]:pb-[calc(1.25rem+env(safe-area-inset-bottom))]',
            mobilePresentation === 'dialog' && 'keyboard-safe-dialog',
            className
          )}
          style={
            // SAFETY: The component contract supplies the asserted browser value used here.
            {
              ...style,
              '--dialog-visual-viewport-top':
                mobilePresentation === 'dialog' && viewportTop !== null
                  ? `${viewportTop}px`
                  : undefined,
              '--dialog-visual-viewport-height':
                mobilePresentation === 'dialog' && viewportHeight !== null
                  ? `${viewportHeight}px`
                  : undefined
            } as React.CSSProperties
          }
          onCloseAutoFocus={(event) => {
            onCloseAutoFocus?.(event)
            if (!event.defaultPrevented && restoreFocusTo?.isConnected) {
              event.preventDefault()
              restoreFocusTo.focus()
            }
          }}
          {...props}
        >
          {children}
          <DialogPrimitive.Close className="absolute top-3 right-3 inline-flex size-9 items-center justify-center rounded-md text-zinc-500 outline-none hover:bg-white/5 hover:text-zinc-100 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan-400 disabled:pointer-events-none [&_svg]:size-4">
            <XIcon />
            <span className="sr-only">Close</span>
          </DialogPrimitive.Close>
        </DialogPrimitive.Content>
      </DialogPortal>
    )
  }
)
DialogContent.displayName = DialogPrimitive.Content.displayName

function DialogHeader({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn('flex flex-col gap-1.5 pr-12 text-left', className)}
      {...props}
    />
  )
}

const DialogTitle = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Title>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Title>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Title
    ref={ref}
    className={cn(
      'text-balance text-xl font-semibold tracking-tight text-zinc-50 sm:text-2xl',
      className
    )}
    {...props}
  />
))
DialogTitle.displayName = DialogPrimitive.Title.displayName

const DialogDescription = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Description>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Description>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Description
    ref={ref}
    className={cn('text-base text-pretty text-zinc-400 sm:text-sm', className)}
    {...props}
  />
))
DialogDescription.displayName = DialogPrimitive.Description.displayName

export { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription }
