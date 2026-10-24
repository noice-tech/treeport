import { Toaster as Sonner, type ToasterProps } from 'sonner'

function Toaster(props: ToasterProps) {
  return (
    <Sonner
      theme="dark"
      position="top-right"
      visibleToasts={3}
      expand
      closeButton
      containerAriaLabel="Notifications"
      toastOptions={{
        classNames: {
          toast:
            'group border-zinc-700! bg-zinc-900! text-zinc-100! shadow-2xl!',
          title: 'text-zinc-100!',
          description: 'text-zinc-400!',
          actionButton:
            'bg-accent-solid! text-on-accent! hover:bg-accent-solid-hover! active:bg-accent-solid!',
          cancelButton:
            'bg-zinc-800! text-zinc-200! hover:bg-zinc-700! active:bg-zinc-800!'
        }
      }}
      {...props}
    />
  )
}

export { Toaster }
