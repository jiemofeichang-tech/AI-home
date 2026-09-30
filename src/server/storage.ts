import { mkdir, readFile, writeFile, unlink } from 'node:fs/promises';
import path from 'node:path';
import OSS from 'ali-oss';
import { config } from './config';
const root=path.resolve(config.storageDir);
function localPath(key:string) {
  if(!/^[a-zA-Z0-9/_-]+\.(png|jpg|webp|gif)$/.test(key)) throw new Error('Invalid object key');
  const full=path.resolve(root,key);if(!full.startsWith(root+path.sep)) throw new Error('Invalid storage path');return full;
}
function oss() { return new OSS({region:process.env.OSS_REGION,bucket:process.env.OSS_BUCKET,accessKeyId:process.env.ALI_ACCESS_KEY_ID||'',accessKeySecret:process.env.ALI_ACCESS_KEY_SECRET||'',secure:true}); }
export function objectStorageLocation(backend:string=config.storage) {
  return backend==='local'?root:`${process.env.OSS_REGION||''}/${process.env.OSS_BUCKET||''}`;
}
export async function putObject(key:string,data:Buffer,mime:string) {
  if(config.storage==='oss') {await oss().put(key,data,{mime,headers:{'x-oss-object-acl':'private'}});return;}
  const file=localPath(key);await mkdir(path.dirname(file),{recursive:true});await writeFile(file,data);
}
export async function getObject(key:string):Promise<Buffer> {
  if(config.storage==='oss') return (await oss().get(key)).content as Buffer;
  return readFile(localPath(key));
}
/** Use the backend recorded when removal was requested, not today's default. */
export async function deleteObject(key:string,backend:string=config.storage,location?:string) {
  if(location&&location!==objectStorageLocation(backend)) throw new Error('Object storage location has changed; restore deletion target configuration');
  if(backend==='oss') {
    try {await oss().delete(key);}
    catch(error) {if((error as {status?:number}).status!==404) throw error;}
    return;
  }
  if(backend!=='local') throw new Error('Unknown object storage backend');
  try {await unlink(localPath(key));}
  catch(error) {if((error as NodeJS.ErrnoException).code!=='ENOENT') throw error;}
}
export function imageMime(bytes:Buffer):string|null {
  if(bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) return 'image/png';
  if(bytes[0]===255&&bytes[1]===216&&bytes[2]===255) return 'image/jpeg';
  if(bytes.toString('ascii',0,4)==='RIFF'&&bytes.toString('ascii',8,12)==='WEBP') return 'image/webp';
  if(['GIF87a','GIF89a'].includes(bytes.toString('ascii',0,6))) return 'image/gif';
  return null;
}
