import { toast } from 'sonner'
import { errorMessage } from '../../error-message'

export function notifyError(error: unknown): void {
  toast.error(errorMessage(error))
}
