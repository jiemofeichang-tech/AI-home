import { readdir,readFile } from 'node:fs/promises';
import { getMigrations } from 'better-auth/db/migration';
import { auth } from '../src/server/auth';
import { pool,query,transaction } from '../src/server/db';
export async function migrate() {
  const migration=await getMigrations(auth.options);await migration.runMigrations();
  await query('CREATE TABLE IF NOT EXISTS schema_migrations(name text PRIMARY KEY,applied_at timestamptz DEFAULT now())');
  for(const file of (await readdir('migrations')).filter(f=>f.endsWith('.sql')).sort()) {
    if((await query('SELECT 1 FROM schema_migrations WHERE name=$1',[file])).length) continue;
    const sql=await readFile(`migrations/${file}`,'utf8');await transaction(async client=>{await client.query(sql);await client.query('INSERT INTO schema_migrations(name) VALUES($1)',[file]);});console.log(`Applied ${file}`);
  }
}
if(process.argv[1]?.endsWith('migrate.ts')) {await migrate();await pool.end();}
