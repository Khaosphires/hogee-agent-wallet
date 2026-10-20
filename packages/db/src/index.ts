import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import * as schema from './schema/index';

export * from './schema/index';
export { insertRationale, type RationaleQueryable, type RationaleRecord } from './rationales';
export {
  consumeEnrolmentCode,
  isFounderKeyRejected,
  issueEnrolmentCode,
  lockFounder,
  openEnrolmentCode,
  rejectPendingFounderKey,
  type EnrolmentQueryable,
  type FounderKeyIdentity,
  type FounderKeyRejection,
  type IssueEnrolmentCode,
  type OpenEnrolmentCode,
} from './founder-enrolment';
export { schema };

export interface CreateDbOptions {
  /** Max pool size (default 10). */
  maxConnections?: number;
  /** Max wait (ms) for a pooled connection before the query fails; default none (node-postgres waits forever). */
  connectionTimeoutMillis?: number;
}

const DEFAULT_MAX_CONNECTIONS = 10;

/**
 * One node-postgres `Pool` wrapped by drizzle. Nothing connects until the first query, so importing
 * this package or calling `createDb` never touches the network. The pool is `db.$client`; callers
 * should attach `db.$client.on('error', …)` and call `db.$client.end()` on shutdown.
 *
 * Note for tasks 1.5/1.6: allocate the nonce (`SELECT … FOR UPDATE` on `nonces`) and store the raw
 * signed tx inside one `db.transaction(async (tx) => …)`; see `schema/payments.ts`.
 */
export function createDb(databaseUrl: string, options: CreateDbOptions = {}) {
  if (typeof databaseUrl !== 'string' || databaseUrl.trim() === '') {
    throw new Error('createDb: databaseUrl is required (set DATABASE_URL)');
  }
  const maxConnections = options.maxConnections ?? DEFAULT_MAX_CONNECTIONS;
  if (!Number.isInteger(maxConnections) || maxConnections < 1) {
    throw new Error('createDb: maxConnections must be a positive integer');
  }
  const timeout = options.connectionTimeoutMillis;
  if (timeout !== undefined && (!Number.isInteger(timeout) || timeout < 1)) {
    throw new Error('createDb: connectionTimeoutMillis must be a positive integer');
  }
  const pool = new pg.Pool({ connectionString: databaseUrl, max: maxConnections, ...(timeout !== undefined ? { connectionTimeoutMillis: timeout } : {}) });
  return drizzle(pool, { schema });
}

export type Db = ReturnType<typeof createDb>;

/** The transaction handle passed to `db.transaction(async (tx) => …)`. */
export type DbTx = Parameters<Parameters<Db['transaction']>[0]>[0];
