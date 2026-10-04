import { createWriteStream } from 'node:fs';
import { mkdtemp,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable,Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { AppError,fail } from '../shared/contracts';
import { isVideoMime,MAX_VIDEO_BYTES,type VideoMime } from '../shared/video';
import { getObjectSize,getObjectStream,type ObjectRange } from './storage';

function ebmlNumber(bytes:Buffer,offset:number,keepMarker=false):{value:number;length:number}|null {
  const first=bytes[offset];if(!first)return null;
  let length=1,mask=0x80;while(!(first&mask)&&length<=8){length++;mask>>=1;}
  if(length>8||offset+length>bytes.length)return null;
  let value=keepMarker?first:first&(mask-1);
  for(let i=1;i<length;i++)value=value*256+bytes[offset+i];
  return Number.isSafeInteger(value)?{value,length}:null;
}

/** Container signatures are checked from a bounded prefix; no codecs execute. */
export function videoMime(prefix:Buffer):VideoMime|null {
  if(prefix.length>=16&&prefix.toString('latin1',4,8)==='ftyp') {
    const size=prefix.readUInt32BE(0),brand=prefix.toString('latin1',8,12);
    if(size<16||size>4096||size>prefix.length||size%4!==0||brand==='qt  ')return null;
    if(/^(?:isom|iso[0-9]|mp4[12]|avc1|M4V |dash)$/.test(brand))return 'video/mp4';
    return null;
  }
  if(prefix.length<5||!prefix.subarray(0,4).equals(Buffer.from([0x1a,0x45,0xdf,0xa3])))return null;
  const size=ebmlNumber(prefix,4);if(!size)return null;
  const end=4+size.length+size.value;if(end>prefix.length||end>4096)return null;
  let offset=4+size.length,doctype=false;
  while(offset<end) {
    const id=ebmlNumber(prefix,offset,true);if(!id||id.length>4)return null;
    offset+=id.length;const length=ebmlNumber(prefix,offset);if(!length)return null;
    offset+=length.length;if(offset+length.value>end)return null;
    if(id.value===0x4282) {
      if(doctype||length.value!==4||prefix.toString('latin1',offset,offset+length.value)!=='webm')return null;
      doctype=true;
    }
    offset+=length.value;
  }
  return doctype?'video/webm':null;
}

export async function readVideoUpload(request:Request) {
  const mime=request.headers.get('content-type')?.split(';')[0].trim().toLowerCase();
  const reject=(status:number,message:string):never=>{void request.body?.cancel().catch(()=>{});return fail(status,message);};
  if(!isVideoMime(mime))reject(415,'仅支持 MP4 和 WebM 视频');
  const declared=request.headers.get('content-length');
  if(declared!==null&&(!/^[0-9]+$/.test(declared)||!Number.isSafeInteger(Number(declared))))reject(400,'视频大小无效');
  if(declared!==null&&Number(declared)>MAX_VIDEO_BYTES)reject(413,'单个视频不能超过 50 MB');
  if(!request.body)reject(400,'请上传视频');
  const directory=await mkdtemp(path.join(tmpdir(),'community-video-'));
  const filePath=path.join(directory,'upload');
  const cleanup=()=>rm(directory,{recursive:true,force:true});
  let bytes=0,prefix=Buffer.alloc(0);
  try {
    const counter=new Transform({transform(chunk:Buffer,_encoding,callback) {
      bytes+=chunk.length;
      if(bytes>MAX_VIDEO_BYTES){callback(new AppError(413,'单个视频不能超过 50 MB'));return;}
      if(prefix.length<4096)prefix=Buffer.concat([prefix,chunk.subarray(0,4096-prefix.length)]);
      callback(null,chunk);
    }});
    await pipeline(Readable.fromWeb(request.body! as import('node:stream/web').ReadableStream<Uint8Array>),counter,
      createWriteStream(filePath,{flags:'wx',mode:0o600}),{signal:request.signal});
    if(!bytes)fail(400,'视频文件为空');
    if(declared!==null&&Number(declared)!==bytes)fail(400,'视频大小与上传内容不一致');
    if(videoMime(prefix)!==mime)fail(415,'无法识别视频格式，请上传有效的 MP4 或 WebM 文件');
    return {filePath,bytes,mime:mime as VideoMime,cleanup};
  } catch(error) {
    await cleanup();
    if(error instanceof AppError)throw error;
    if(request.signal.aborted)fail(400,'视频上传已取消');
    fail(400,'无法读取视频，请重新上传');
  }
}

/** A single byte range only; multipart and malformed requests fail closed. */
export function parseVideoRange(value:string|null,size:number):ObjectRange|null|'invalid' {
  if(value===null)return null;
  const match=value.trim().match(/^bytes=([0-9]*)-([0-9]*)$/i);
  if(!match||(!match[1]&&!match[2])||!Number.isSafeInteger(size)||size<1)return 'invalid';
  if(!match[1]) {
    const suffix=Number(match[2]);if(!Number.isSafeInteger(suffix)||suffix<1)return 'invalid';
    return {start:Math.max(0,size-suffix),end:size-1};
  }
  const start=Number(match[1]),end=match[2]?Number(match[2]):size-1;
  if(!Number.isSafeInteger(start)||!Number.isSafeInteger(end)||start>=size||end<start)return 'invalid';
  return {start,end:Math.min(end,size-1)};
}

/** Call only after live authentication and content/owner ACL checks. */
export async function videoResponse(request:Request,media:{storage_key:string;mime:string}) {
  const size=await getObjectSize(media.storage_key),range=parseVideoRange(request.headers.get('range'),size);
  const headers:Record<string,string>={'Content-Type':media.mime,'Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff','Accept-Ranges':'bytes'};
  if(range==='invalid')return new Response(null,{status:416,headers:{...headers,'Content-Range':`bytes */${size}`,'Content-Length':'0'}});
  headers['Content-Length']=String(range?range.end-range.start+1:size);
  if(range)headers['Content-Range']=`bytes ${range.start}-${range.end}/${size}`;
  if(request.method==='HEAD')return new Response(null,{status:range?206:200,headers});
  const stream=await getObjectStream(media.storage_key,range||undefined);
  const abort=()=>stream.destroy(new Error('Media request cancelled'));
  request.signal.addEventListener('abort',abort,{once:true});
  stream.once('close',()=>request.signal.removeEventListener('abort',abort));
  const body=Readable.toWeb(stream) as ReadableStream<Uint8Array>;
  if(request.signal.aborted)abort();
  return new Response(body,{status:range?206:200,headers});
}
