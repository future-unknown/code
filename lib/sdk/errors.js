/**
 * SDK error classes. These mirror the API's structured error codes so
 * callers can catch typed errors without knowing about JSON-RPC.
 * The SDK is environment-neutral, so it defines its own classes rather
 * than importing server-side packages.
 */

export class CodeClientError extends Error {
  /**
   * @param {string} message
   * @param {{ code?: string, details?: object, rpcCode?: number }} [options]
   */
  constructor (message, { code, details, rpcCode } = {}) {
    super(message)
    this.name = this.constructor.name
    this.code = code || 'CLIENT_ERROR'
    this.details = details || {}
    this.rpcCode = rpcCode
  }
}

export class ValidationError extends CodeClientError {}
export class NotFoundError extends CodeClientError {}
export class AlreadyExistsError extends CodeClientError {}
export class RevisionConflictError extends CodeClientError {}
export class EditMismatchError extends CodeClientError {}
export class PathConflictError extends CodeClientError {}
export class InvalidMoveError extends CodeClientError {}
export class LimitError extends CodeClientError {}
export class UnauthenticatedError extends CodeClientError {}
export class UnauthorizedError extends CodeClientError {}
export class NetworkError extends CodeClientError {}
export class RpcError extends CodeClientError {}

const classByCode = {
  VALIDATION_ERROR: ValidationError,
  NOT_FOUND: NotFoundError,
  ALREADY_EXISTS: AlreadyExistsError,
  REVISION_CONFLICT: RevisionConflictError,
  EDIT_MISMATCH: EditMismatchError,
  PATH_CONFLICT: PathConflictError,
  INVALID_MOVE: InvalidMoveError,
  LIMIT: LimitError,
  UNAUTHENTICATED: UnauthenticatedError,
  UNAUTHORIZED: UnauthorizedError
}

/**
 * Map a JSON-RPC error object to a typed SDK error.
 *
 * @param {{ code: number, message: string, data?: { code?: string, details?: object } }} error
 */
export function errorFromRpc (error) {
  const domainCode = error.data?.code
  const ErrorClass = (domainCode && classByCode[domainCode]) || RpcError
  return new ErrorClass(error.message, {
    code: domainCode || 'RPC_ERROR',
    details: error.data?.details,
    rpcCode: error.code
  })
}
