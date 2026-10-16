export type RepoErrorCode =
  | 'forbidden' // 403
  | 'conflict' // 409（version 不一致）
  | 'idempotency_mismatch' // 409（同じ operation_id で異なる内容）
  | 'validation' // 422
  | 'invariant' // 422（数量の不変条件違反）
  | 'not_found' // 404（別組織も含む）
  | 'session_expired' // 401
  | 'network' // 要求がサーバーに届いていない
  | 'timeout'; // 応答が返らない（サーバー側で確定した可能性あり）

export class RepoError extends Error {
  constructor(
    public readonly code: RepoErrorCode,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'RepoError';
  }
}

export function isRepoError(e: unknown): e is RepoError {
  return e instanceof RepoError;
}

export function httpStatusOf(code: RepoErrorCode): number | null {
  switch (code) {
    case 'forbidden':
      return 403;
    case 'conflict':
    case 'idempotency_mismatch':
      return 409;
    case 'validation':
    case 'invariant':
      return 422;
    case 'not_found':
      return 404;
    case 'session_expired':
      return 401;
    default:
      return null;
  }
}
