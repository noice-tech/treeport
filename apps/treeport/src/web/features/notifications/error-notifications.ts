import { toast } from 'sonner'
import { errorDescription, errorDetails } from '../../error-message'

export function notifyError(
  cause: unknown,
  { operation }: { operation: string }
): void {
  const details = errorDetails(cause)
  toast.error(`Couldn’t ${operation}`, {
    description: errorDescription(details)
  })
}
