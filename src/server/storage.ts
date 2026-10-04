import { mkdir, readFile, writeFile, unlink,stat,copyFile,chmod } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import type { Readable } from 'node:stream';
import path from 'node:path';
import OSS from 'ali-oss';
import { config } from './config';
const root=path.resolve(config.storageDir);
function localPath(key:string) {
  if(!/^[a-zA-Z0-9/_-]+\.(png|jpg|webp|gif|mp4|webm)$/.test(key)) throw new Error('Invalid object key');
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
export type ObjectRange={start:number;end:number};
export async function putObjectFile(key:string,filePath:string,mime:string) {
  const target=localPath(key);
  if(config.storage==='oss') {
    const size=(await stat(filePath)).size;
    const stream=createReadStream(filePath);
    try {
      // SDK docs make these options optional; its legacy typings overrequire
      // callback/meta. lib/object.js streams the body and honors contentLength.
      await oss().putStream(key,stream,{contentLength:size,mime,timeout:120_000,headers:{'x-oss-object-acl':'private'}} as OSS.PutStreamOptions);
    } finally {stream.destroy();}
    return;
  }
  await mkdir(path.dirname(target),{recursive:true,mode:0o700});await copyFile(filePath,target);await chmod(target,0o600);
}
export async function getObjectSize(key:string):Promise<number> {
  const file=localPath(key);
  const size=config.storage==='oss'?Number(((await oss().head(key)).res.headers as Record<string,string>)['content-length']):(await stat(file)).size;
  if(!Number.isSafeInteger(size)||size<0)throw new Error('Invalid object size');
  return size;
}
export async function getObjectStream(key:string,range?:ObjectRange):Promise<Readable> {
  const file=localPath(key);
  if(range&&(!Number.isSafeInteger(range.start)||!Number.isSafeInteger(range.end)||range.start<0||range.end<range.start))throw new Error('Invalid object range');
  if(config.storage==='oss') {
    const result=await oss().getStream(key,{headers:range?{Range:`bytes=${range.start}-${range.end}`}:{}});
    // The installed SDK supports 206 even though older type comments omit it.
    if(!result.stream||result.res.status!==(range?206:200)) {result.stream?.destroy();throw new Error('Unexpected object stream response');}
    if(range&&(result.res.headers as Record<string,string>)['content-range']?.split('/')[0]!==`bytes ${range.start}-${range.end}`) {result.stream.destroy();throw new Error('Unexpected object range');}
    return result.stream as Readable;
  }
  return createReadStream(file,range?{start:range.start,end:range.end}:undefined);
}
/** Use the backend recorded when removal was requested, not today's default. */
export async function deleteObject(key:string,backend:string=config.storage,location?:string) {
  localPath(key);
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
