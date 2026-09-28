import 'dotenv/config';
export const config = {
  url: process.env.APP_URL || 'http://localhost:3100',
  database: process.env.DATABASE_URL || (process.env.PGHOST ? undefined : 'postgresql://postgres:postgres@127.0.0.1:54329/postgres'),
  dev: process.env.DEV_MODE === 'true',
  secret: process.env.BETTER_AUTH_SECRET || '',
  redis: process.env.REDIS_URL || '',
  meili: process.env.MEILI_URL || '',
  storage: process.env.STORAGE_DRIVER || 'local',
  storageDir: process.env.LOCAL_STORAGE_DIR || '.local/uploads',
};
export function validateProduction() {
  if (process.env.NODE_ENV !== 'production' || process.env.NEXT_PHASE === 'phase-production-build') return;
  if (config.dev || config.secret.length < 32 || (!process.env.DATABASE_URL && !process.env.PGHOST) || config.storage !== 'oss' || !config.redis || !config.meili) {
    throw new Error('Production requires DEV_MODE=false, a secret, PostgreSQL, Redis, Meilisearch and OSS.');
  }
}
