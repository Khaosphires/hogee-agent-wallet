/**
 * The worker's PUBLIC role addresses, published per deployment at start-up so the API (which holds no key) can name
 * the agent in a new plan and simulate relayed calls from the relayer. Addresses only; keys never leave keys.ts.
 */
import type { Pool } from 'pg';
import type { WorkerSigners } from '../config/keys';
import { WORKER_SCHEMA } from './schema';

export async function publishRoles(pool: Pool, deployment: { readonly deploymentId: string; readonly chainId: number }, signers: WorkerSigners): Promise<void> {
  const roles = [
    ['agent', signers.agent.address],
    ['oracle', signers.oracle.address],
    ['lender', signers.lender.address],
    ['relayer', signers.relayer.address],
  ] as const;
  for (const [role, address] of roles) {
    await pool.query(
      `insert into ${WORKER_SCHEMA}.roles (deployment_id, chain_id, role, address) values ($1, $2, $3, $4)
       on conflict (deployment_id, chain_id, role) do update set address = excluded.address, updated_at = now()`,
      [deployment.deploymentId, deployment.chainId, role, address.toLowerCase()],
    );
  }
}
