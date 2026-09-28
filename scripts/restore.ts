import { pool } from '../src/server/db';
import { restoreBackup } from '../src/server/backup';
try{const directory=process.argv[2];if(!directory)throw new Error('Usage: npm run restore -- backups/<backup-directory>. Use a freshly migrated empty database and a new storage target.');console.log(await restoreBackup(directory,pool));}finally{await pool.end();}
