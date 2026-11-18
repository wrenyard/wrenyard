export class SessionError extends Error {
  readonly code: string;

  constructor(code: string, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = new.target.name;
    this.code = code;
  }
}

export class SessionNotFoundError extends SessionError {
  readonly sessionId: string;

  constructor(sessionId: string, message?: string) {
    super('session_not_found', message ?? `Unknown session: ${sessionId}`);
    this.sessionId = sessionId;
  }
}

export class SessionBusyError extends SessionError {
  readonly sessionId: string;

  constructor(sessionId: string, message?: string) {
    super('session_busy', message ?? `Session is busy: ${sessionId}`);
    this.sessionId = sessionId;
  }
}

export class SessionClosedError extends SessionError {
  constructor(message = 'Session is closed') {
    super('session_closed', message);
  }
}

export class SessionReadOnlyError extends SessionError {
  readonly sessionId: string;

  constructor(sessionId: string, message?: string) {
    super('session_read_only', message ?? `Session storage handle is read-only: ${sessionId}`);
    this.sessionId = sessionId;
  }
}

export class SessionAlreadyOwnedError extends SessionError {
  readonly sessionId: string;

  constructor(sessionId: string, message?: string) {
    super('session_already_owned', message ?? `Session already has an active writer: ${sessionId}`);
    this.sessionId = sessionId;
  }
}

export class SessionAlreadyExistsError extends SessionError {
  readonly sessionId: string;

  constructor(sessionId: string, message?: string) {
    super('session_already_exists', message ?? `Session already exists: ${sessionId}`);
    this.sessionId = sessionId;
  }
}

export class SessionCorruptedError extends SessionError {
  constructor(message: string, options?: ErrorOptions) {
    super('session_corrupted', message, options);
  }
}
