/**
 * Domain error classes for code.
 *
 * Layers above code-kit (API, CLI) match on these classes / codes,
 * never on message strings.
 */

export class CodeError extends Error {
  /**
   * @param {string} message
   * @param {{ code?: string, details?: object }} [options]
   */
  constructor (message, { code, details } = {}) {
    super(message)
    this.name = this.constructor.name
    this.code = code || 'CODE_ERROR'
    this.details = details || {}
  }
}

export class ValidationError extends CodeError {
  constructor (message, details) {
    super(message, { code: 'VALIDATION_ERROR', details })
  }
}

export class NotFoundError extends CodeError {
  constructor (message, details) {
    super(message, { code: 'NOT_FOUND', details })
  }
}

export class AlreadyExistsError extends CodeError {
  constructor (message, details) {
    super(message, { code: 'ALREADY_EXISTS', details })
  }
}

export class RevisionConflictError extends CodeError {
  constructor (message, details) {
    super(message, { code: 'REVISION_CONFLICT', details })
  }
}

export class EditMismatchError extends CodeError {
  constructor (message, details) {
    super(message, { code: 'EDIT_MISMATCH', details })
  }
}

// A file where a folder is (or the other way round): `src` cannot be a
// file while `src/app.js` exists.
export class PathConflictError extends CodeError {
  constructor (message, details) {
    super(message, { code: 'PATH_CONFLICT', details })
  }
}

export class InvalidMoveError extends CodeError {
  constructor (message, details) {
    super(message, { code: 'INVALID_MOVE', details })
  }
}

export class LimitError extends CodeError {
  constructor (message, details) {
    super(message, { code: 'LIMIT', details })
  }
}
