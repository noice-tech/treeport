import { toast } from 'sonner'

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function notifyError(error: unknown): void {
  toast.error(errorMessage(error))
}
