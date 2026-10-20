import { defineConfig } from 'drizzle-kit';

/**
 * `db:generate` needs no database. The fallback URL is the local docker-compose value from
 * `.env.example` and is only there so `generate` runs without env; `db:migrate` should always get
 * DATABASE_URL from the environment.
 */
const LOCAL_DEV_DATABASE_URL = 'postgres://hogee:hogee@localhost:5432/hogee';

export default defineConfig({
  dialect: 'postgresql',
  schema: './src/schema/index.ts',
  out: './drizzle',
  dbCredentials: {
    url: process.env.DATABASE_URL ?? LOCAL_DEV_DATABASE_URL,
  },
  strict: true,
  verbose: true,
});
