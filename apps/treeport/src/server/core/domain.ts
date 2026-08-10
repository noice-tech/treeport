export class DomainError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 400,
    readonly details?: unknown
  ) {
    super(message)
    this.name = 'DomainError'
  }
}
