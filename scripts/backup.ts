import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { pool } from '../src/server/db';
import { createBackup } from '../src/server/backup';
try{
  const root=process.env.BACKUP_DIR||'backups';await mkdir(root,{recursive:true,mode:0o700});
  const directory=path.join(root,`community-${new Date().toISOString().replace(/[:.]/g,'-')}`);
  const backup=await createBackup(directory,pool);console.log(JSON.stringify({directory,tables:backup.tables.length,objects:backup.objects.length}));
}finally{await pool.end();}
