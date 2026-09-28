import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import OSS from 'ali-oss';
import { config } from './config';
const root=path.resolve(config.storageDir);
function localPath(key:string) {
  if(!/^[a-zA-Z0-9/_-]+\.(png|jpg|webp|gif)$/.test(key)) throw new Error('Invalid object key');
  const full=path.resolve(root,key);if(!full.startsWith(root+path.sep)) throw new Error('Invalid storage path');return full;
}
function oss() { return new OSS({region:process.env.OSS_REGION,bucket:process.env.OSS_BUCKET,accessKeyId:process.env.ALI_ACCESS_KEY_ID||'',accessKeySecret:process.env.ALI_ACCESS_KEY_SECRET||'',secure:true}); }
export async function putObject(key:string,data:Buffer,mime:string) {
  if(config.storage==='oss') {await oss().put(key,data,{mime,headers:{'x-oss-object-acl':'private'}});return;}
  const file=localPath(key);await mkdir(path.dirname(file),{recursive:true});await writeFile(file,data);
}
export async function getObject(key:string):Promise<Buffer> {
  if(config.storage==='oss') return (await oss().get(key)).content as Buffer;
  return readFile(localPath(key));
}
export function imageMime(bytes:Buffer):string|null {
  if(bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) return 'image/png';
  if(bytes[0]===255&&bytes[1]===216&&bytes[2]===255) return 'image/jpeg';
  if(bytes.toString('ascii',0,4)==='RIFF'&&bytes.toString('ascii',8,12)==='WEBP') return 'image/webp';
  if(['GIF87a','GIF89a'].includes(bytes.toString('ascii',0,6))) return 'image/gif';
  return null;
}
