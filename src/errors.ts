import type { ConnectionAttempt } from './types.ts'

/**
 * Structured Local Dream failure.
 *
 * `code` classifies the failure, `status` is the HTTP status when the phone's
 * backend answered (0 for local failures with no HTTP response), `connection`
 * marks failures that a reconnect may fix (the connection manager retries
 * those), and `fatal` marks configuration errors that retrying cannot fix.
 */
export type LocalDreamErrorCode =
  | 'config'
  | 'args'
  | 'connection'
  | 'timeout'
  | 'protocol'
  | 'adb'
  | 'device'
  | 'http'
  | 'output'
  | 'cancelled'

export interface LocalDreamErrorOptions {
  status?: number
  /** A reconnect may fix this failure, so the connection manager may retry. */
  connection?: boolean
  /** Retrying cannot fix this failure (ambiguous device, bad config). */
  fatal?: boolean
  /** Every connection attempt, in order, when the wait budget expired. */
  attempts?: ConnectionAttempt[]
  cause?: unknown
}

export class LocalDreamError extends Error {
  readonly code: LocalDreamErrorCode
  readonly status: number
  readonly connection: boolean
  readonly fatal: boolean
  readonly attempts?: ConnectionAttempt[]

  constructor(code: LocalDreamErrorCode, message: string, options: LocalDreamErrorOptions = {}) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined)
    this.name = 'LocalDreamError'
    this.code = code
    this.status = options.status ?? 0
    this.connection = options.connection ?? code === 'connection'
    this.fatal = options.fatal ?? false
    this.attempts = options.attempts
  }
}

/** Node errno values that mean "the socket/backend is not there (any more)". */
const CONNECTION_ERRNOS = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ECONNABORTED',
  'EPIPE',
  'ETIMEDOUT',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ENETDOWN',
  'EAI_AGAIN',
  'UND_ERR_SOCKET',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
])

const CONNECTION_PATTERNS = [
  /socket hang up/i,
  /other side closed/i,
  /fetch failed/i,
  /ECONNREFUSED/,
  /ECONNRESET/,
  /EPIPE/,
  /device (?:is )?offline/i,
  /stream (?:stalled|silent|ended without)/i,
  /terminated/i,
]

/**
 * Whether a mid-call failure is connection-level, i.e. worth a stale-mark and
 * a reconnect+retry. Exported for unit tests.
 */
export function isConnectionError(error: unknown): boolean {
  if (error instanceof LocalDreamError) {
    if (error.connection) return true
    if (error.code === 'http' || error.code === 'args' || error.code === 'config') return false
  }
  const code = (error as NodeJS.ErrnoException | undefined)?.code
  if (typeof code === 'string' && CONNECTION_ERRNOS.has(code)) return true
  const message = error instanceof Error ? error.message : String(error)
  return CONNECTION_PATTERNS.some((pattern) => pattern.test(message))
}

/** Normalize any thrown value into a readable message. */
export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}
