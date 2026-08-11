import { toast } from 'sonner'
import { errorDetails } from '../../error-message'

export function notifyError(
  error: unknown,
  { operation }: { operation: string }
): void {
  const details = errorDetails(error)
  const description = [
    details.message,
    details.recoveryHint,
    details.requestId ? `Reference: ${details.requestId}.` : null
  ]
    .filter((part): part is string => Boolean(part))
    .join(' ')

  toast.error(`Couldn’t ${operation}`, { description })
}
