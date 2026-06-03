export class CliError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly causeText?: string,
    readonly data?: unknown,
  ) {
    super(message);
  }
}

export function toCliError(error: unknown): CliError {
  if (error instanceof CliError) {
    return error;
  }
  if (error instanceof Error) {
    return new CliError("UNEXPECTED_ERROR", error.message);
  }
  return new CliError("UNEXPECTED_ERROR", String(error));
}
