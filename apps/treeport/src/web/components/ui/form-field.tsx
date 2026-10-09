import type { ReactNode } from 'react'

export function FormField({ children }: { children: ReactNode }) {
  return <div className="grid gap-2 max-[700px]:gap-1">{children}</div>
}
