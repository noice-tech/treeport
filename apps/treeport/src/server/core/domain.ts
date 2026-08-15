export class DomainError<Details = never> extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 400,
    readonly details?: Details
  ) {
    super(message)
    this.name = 'DomainError'
  }
}
