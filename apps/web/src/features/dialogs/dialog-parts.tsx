import type { ReactNode } from 'react'

export function ModalHeading({
  eyebrow,
  title
}: {
  eyebrow?: string
  title: string
}) {
  return (
    <div className="grid gap-1.5 pr-12">
      {eyebrow ? <p className="eyebrow">{eyebrow}</p> : null}
      <h2
        id="modal-title"
        className="text-balance text-xl font-semibold tracking-tight text-zinc-50 sm:text-2xl"
      >
        {title}
      </h2>
    </div>
  )
}

export function FormField({ children }: { children: ReactNode }) {
  return <div className="grid gap-2">{children}</div>
}
