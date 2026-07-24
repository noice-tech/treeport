import { Toaster as Sonner, type ToasterProps } from 'sonner'

function Toaster(props: ToasterProps) {
  return (
    <Sonner
      theme="dark"
      position="top-right"
      visibleToasts={3}
      expand
      containerAriaLabel="Terminal notifications"
      toastOptions={{
        classNames: {
          toast:
            'group border-zinc-700! bg-zinc-900! text-zinc-100! shadow-2xl!',
          title: 'text-zinc-100!',
          description: 'text-zinc-400!',
          actionButton: 'bg-cyan-600! text-white! hover:bg-cyan-500!',
          cancelButton: 'bg-zinc-800! text-zinc-200! hover:bg-zinc-700!'
        }
      }}
      {...props}
    />
  )
}

export { Toaster }
