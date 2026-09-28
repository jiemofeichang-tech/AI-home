import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir,open,readFile,writeFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import path from 'node:path';
import type { Pool } from 'pg';
import { getObject,putObject } from './storage';

type Manifest={version:2;createdAt:string;tables:{name:string;file:string;rows:number;sha256:string}[];objects:{key:string;file:string;mime:string;sha256:string}[]};
const ident=(s:string)=>{if(!/^[a-zA-Z_][\w]*$/.test(s))throw new Error('Unsafe identifier');return `"${s}"`;};
const safePath=(root:string,file:string)=>{const absolute=path.resolve(root,file);if(!absolute.startsWith(path.resolve(root)+path.sep))throw new Error('Invalid backup path');return absolute;};
async function fileHash(file:string){const hash=createHash('sha256');for await(const chunk of createReadStream(file))hash.update(chunk);return hash.digest('hex');}
async function* rowsFrom(file:string){const reader=createInterface({input:createReadStream(file),crlfDelay:Infinity});for await(const line of reader)if(line)yield JSON.parse(line) as Record<string,unknown>;}

/** Stream table rows; keep images in separate files instead of one huge JSON string. */
export async function createBackup(directory:string,pool:Pool):Promise<Manifest>{
  await mkdir(directory,{recursive:false,mode:0o700});
  await mkdir(path.join(directory,'tables'));await mkdir(path.join(directory,'objects'));
  const client=await pool.connect();
  try{
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const {rows:tables}=await client.query(`SELECT tablename AS name FROM pg_tables WHERE schemaname='public' ORDER BY tablename`);
    const {rows:dependencies}=await client.query(`SELECT tc.table_name AS child,ccu.table_name AS parent FROM information_schema.table_constraints tc JOIN information_schema.constraint_column_usage ccu ON ccu.constraint_name=tc.constraint_name AND ccu.constraint_schema=tc.constraint_schema WHERE tc.constraint_type='FOREIGN KEY' AND tc.table_schema='public'`);
    const ordered:string[]=[];const pending=new Set<string>(tables.map(t=>t.name));
    while(pending.size){let progress=false;for(const name of pending){if(dependencies.some(d=>d.child===name&&d.parent!==name&&pending.has(d.parent)))continue;ordered.push(name);pending.delete(name);progress=true;}if(!progress)throw new Error('Circular table dependencies prevent portable backup');}
    const manifest:Manifest={version:2,createdAt:new Date().toISOString(),tables:[],objects:[]};
    for(const name of ordered){
      const file=`tables/${name}.ndjson`;const handle=await open(safePath(directory,file),'wx',0o600);let count=0;
      await client.query(`DECLARE backup_rows NO SCROLL CURSOR FOR SELECT * FROM ${ident(name)}${name==='posts'?' ORDER BY created_at,id':''}`);
      try{while(true){const {rows}=await client.query('FETCH 200 FROM backup_rows');if(!rows.length)break;for(const row of rows){await handle.write(`${JSON.stringify(row)}\n`);count++;}}}finally{await handle.close();await client.query('CLOSE backup_rows');}
      manifest.tables.push({name,file,rows:count,sha256:await fileHash(safePath(directory,file))});
    }
    const media=manifest.tables.find(t=>t.name==='media');
    if(media)for await(const row of rowsFrom(safePath(directory,media.file))){
      const key=String(row.storage_key);const bytes=await getObject(key);const file=`objects/${createHash('sha256').update(key).digest('hex')}`;
      await writeFile(safePath(directory,file),bytes,{mode:0o600,flag:'wx'});
      manifest.objects.push({key,file,mime:String(row.mime),sha256:createHash('sha256').update(bytes).digest('hex')});
    }
    await client.query('COMMIT');
    // Manifest last: interrupted backups cannot be mistaken for complete ones.
    await writeFile(path.join(directory,'manifest.json'),JSON.stringify(manifest,null,2),{mode:0o600,flag:'wx'});return manifest;
  }catch(e){await client.query('ROLLBACK');throw e;}finally{client.release();}
}

export async function restoreBackup(directory:string,pool:Pool,writeObject=putObject){
  const manifest=JSON.parse(await readFile(path.join(directory,'manifest.json'),'utf8')) as Manifest;
  if(manifest.version!==2)throw new Error('Unsupported backup format');
  for(const item of [...manifest.tables,...manifest.objects])if(await fileHash(safePath(directory,item.file))!==item.sha256)throw new Error(`Backup checksum mismatch: ${item.file}`);
  const client=await pool.connect();
  try{
    await client.query('BEGIN');
    for(const table of manifest.tables){await client.query(`LOCK TABLE ${ident(table.name)} IN ACCESS EXCLUSIVE MODE`);if(table.name==='schema_migrations')continue;const {rows}=await client.query(`SELECT count(*)::int AS count FROM ${ident(table.name)}`);if(rows[0].count)throw new Error(`Restore refused: target table ${table.name} is not empty. Use a fresh database.`);}
    await client.query('DELETE FROM schema_migrations');let totalRows=0;
    for(const table of manifest.tables){
      const types=(await client.query(`SELECT column_name,data_type FROM information_schema.columns WHERE table_schema='public' AND table_name=$1`,[table.name])).rows;let count=0;
      for await(const row of rowsFrom(safePath(directory,table.file))){
        const columns=Object.keys(row);const values=columns.map(k=>['json','jsonb'].includes(types.find(t=>t.column_name===k)?.data_type)?JSON.stringify(row[k]):row[k]);
        await client.query(`INSERT INTO ${ident(table.name)}(${columns.map(ident).join(',')}) VALUES(${columns.map((_,i)=>`$${i+1}`).join(',')})`,values);count++;
      }
      if(count!==table.rows)throw new Error(`Row count mismatch: ${table.name}`);totalRows+=count;
    }
    for(const object of manifest.objects)await writeObject(object.key,await readFile(safePath(directory,object.file)),object.mime);
    await client.query('COMMIT');return {tables:manifest.tables.length,rows:totalRows,objects:manifest.objects.length};
  }catch(e){await client.query('ROLLBACK');throw e;}finally{client.release();}
}
