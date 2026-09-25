export class SupportPagesError extends Error {
  constructor(public code: string, message: string, public details?: unknown) { super(message); }
}
export function fail(code: string, message: string, details?: unknown): never {
  throw new SupportPagesError(code, message, details);
}
export function publicError(error: unknown) {
  if (error instanceof SupportPagesError) return { code: error.code, message: error.message, details: error.details };
  return { code: 'internal_error', message: 'The operation failed. Check the local configuration and retry.' };
}
