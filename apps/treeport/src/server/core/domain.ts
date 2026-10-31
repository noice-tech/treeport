export class DomainError<Details = never> extends Error {
  readonly code: string
  readonly status: number
  readonly details: Details | undefined

  constructor(code: string, message: string, status = 400, details?: Details) {
    super(message)
    this.code = code
    this.status = status
    this.details = details
    this.name = 'DomainError'
  }
}
