import { after,before,test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,readdir,readFile,rm,stat,writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import OSS from 'ali-oss';
import { MAX_VIDEO_BYTES } from '../src/shared/video';

let root:string,video:typeof import('../src/server/video'),storage:typeof import('../src/server/storage'),config:typeof import('../src/server/config').config;
const originalTmp=process.env.TMPDIR;
const mp4=Buffer.from('000000186674797069736f6d0000000069736f6d6d703432000000086d646174','hex');
const webm=Buffer.from('1a45dfa3874282847765626d','hex');
before(async()=>{
  root=await mkdtemp(path.join(tmpdir(),'video-storage-test-'));
  Object.assign(process.env,{TMPDIR:root,STORAGE_DRIVER:'local',LOCAL_STORAGE_DIR:path.join(root,'objects'),OSS_REGION:'oss-cn-hangzhou',OSS_BUCKET:'video-test-bucket',ALI_ACCESS_KEY_ID:'test-id',ALI_ACCESS_KEY_SECRET:'test-secret'});
  video=await import('../src/server/video');storage=await import('../src/server/storage');({config}=await import('../src/server/config'));
});
after(async()=>{if(originalTmp===undefined)delete process.env.TMPDIR;else process.env.TMPDIR=originalTmp;await rm(root,{recursive:true,force:true});});
function request(body:BodyInit|null=new Uint8Array(mp4),headers:Record<string,string>={},signal?:AbortSignal) {
  return new Request('http://localhost/api/v1/media/video',{method:'POST',body,headers:{'Content-Type':'video/mp4',...headers},signal,duplex:'half'} as RequestInit);
}
function generatedBytes(length:number) {
  let remaining=length,first=true;const zero=new Uint8Array(64*1024);
  return new ReadableStream<Uint8Array>({pull(controller){if(!remaining){controller.close();return;}if(first){first=false;controller.enqueue(new Uint8Array(mp4));remaining-=mp4.length;return;}const n=Math.min(remaining,zero.length);controller.enqueue(zero.subarray(0,n));remaining-=n;}});
}
async function noTemporaryFiles(){assert.deepEqual((await readdir(root)).filter(name=>name.startsWith('community-video-')),[]);}
async function bytesOf(stream:Readable){const chunks:Buffer[]=[];for await(const chunk of stream)chunks.push(Buffer.from(chunk));return Buffer.concat(chunks);}

test('magic validation checks complete MP4 ftyp or WebM EBML header, not MIME names or substrings',()=>{
  assert.equal(video.videoMime(mp4),'video/mp4');assert.equal(video.videoMime(webm),'video/webm');
  const mov=Buffer.from(mp4);mov.write('qt  ',8);
  const oversized=Buffer.from(mp4);oversized.writeUInt32BE(1000);
  const highBit=Buffer.from(mp4);highBit[8]|=0x80;
  for(const bytes of [Buffer.from('<html>isom webm ftyp</html>'),Buffer.alloc(24),mov,oversized,highBit,mp4.subarray(0,15),webm.subarray(0,10),
    Buffer.from('1a45dfa3874282846d6b7620','hex'),Buffer.from('1a45dfa3004282847765626d','hex'),Buffer.from('1a45dfa38e4282847765626d4282847765626d','hex')])assert.equal(video.videoMime(bytes),null,bytes.toString('hex'));
});

test('uploads stream into private temporary files and clean up after use',async()=>{
  const result=await video.readVideoUpload(request(new Uint8Array(mp4),{'Content-Length':String(mp4.length)}));
  try {assert.equal(result.bytes,mp4.length);assert.equal(result.mime,'video/mp4');assert.deepEqual(await readFile(result.filePath),mp4);assert.equal((await stat(result.filePath)).mode&0o777,0o600);assert.equal((await stat(path.dirname(result.filePath))).mode&0o777,0o700);}finally{await result.cleanup();}
  const second=await video.readVideoUpload(request(new Uint8Array(webm),{'Content-Type':'video/webm'}));assert.equal(second.mime,'video/webm');await second.cleanup();await noTemporaryFiles();
});

test('declared lengths, actual byte counts and format mismatches fail with no leftover temporary file',async()=>{
  let cancelled=false;const body=new ReadableStream<Uint8Array>({cancel(){cancelled=true;}});
  await assert.rejects(video.readVideoUpload(request(body,{'Content-Length':String(MAX_VIDEO_BYTES+1)})),(error:any)=>error.status===413);assert.equal(cancelled,true);
  for(const headers of [{'Content-Length':'3'},{'Content-Length':'-1'},{'Content-Length':'bad'},{'Content-Length':'1.5'},{'Content-Length':'999999999999999999999'}])await assert.rejects(video.readVideoUpload(request(new Uint8Array(mp4),headers)),(error:any)=>error.status===400);
  await assert.rejects(video.readVideoUpload(request(new Uint8Array(mp4),{'Content-Type':'video/webm'})),(error:any)=>error.status===415);
  await assert.rejects(video.readVideoUpload(request(new Uint8Array(webm),{'Content-Type':'application/octet-stream'})),(error:any)=>error.status===415);
  await assert.rejects(video.readVideoUpload(request(new Uint8Array())),(error:any)=>error.status===400);
  await assert.rejects(video.readVideoUpload(request(generatedBytes(MAX_VIDEO_BYTES+1))),(error:any)=>error.status===413);
  await noTemporaryFiles();
});

test('exactly 50 MiB is accepted with bounded chunks and request cancellation removes partial files',async()=>{
  const result=await video.readVideoUpload(request(generatedBytes(MAX_VIDEO_BYTES)));assert.equal(result.bytes,MAX_VIDEO_BYTES);assert.equal((await stat(result.filePath)).size,MAX_VIDEO_BYTES);await result.cleanup();
  const controller=new AbortController();let waiting!:()=>void;
  const started=new Promise<void>(resolve=>{waiting=resolve;});
  const body=new ReadableStream<Uint8Array>({start(stream){stream.enqueue(new Uint8Array(mp4));waiting();}});
  const pending=video.readVideoUpload(request(body,{},controller.signal));await started;controller.abort();await assert.rejects(pending,(error:any)=>error.status===400);await noTemporaryFiles();
});

test('single ranges include suffix and open ends and reject invalid or multiple ranges',()=>{
  assert.equal(video.parseVideoRange(null,32),null);
  for(const [header,expected] of [['bytes=0-7',{start:0,end:7}],['bytes=20-',{start:20,end:31}],['bytes=-8',{start:24,end:31}],['bytes=-100',{start:0,end:31}],['bytes=0-999',{start:0,end:31}]] as const)assert.deepEqual(video.parseVideoRange(header,32),expected);
  for(const header of ['bytes=32-','bytes=8-4','bytes=-0','bytes=-','bytes=0-1,5-6','bytes=1.5-2','bytes=0-999999999999999999999','items=0-1'])assert.equal(video.parseVideoRange(header,32),'invalid',header);
});

test('local objects use private files and support streaming full, partial, HEAD and 416 responses',async()=>{
  const source=path.join(root,'source.mp4');await writeFile(source,mp4);await storage.putObjectFile('videos/test.mp4',source,'video/mp4');
  assert.equal(await storage.getObjectSize('videos/test.mp4'),mp4.length);assert.equal((await stat(path.join(root,'objects/videos/test.mp4'))).mode&0o777,0o600);
  assert.deepEqual(await bytesOf(await storage.getObjectStream('videos/test.mp4',{start:4,end:7})),Buffer.from('ftyp'));
  const media={storage_key:'videos/test.mp4',mime:'video/mp4'};
  const full=await video.videoResponse(new Request('http://localhost/media'),media);assert.equal(full.status,200);assert.match(full.headers.get('Cache-Control')!,/no-store/);assert.deepEqual(Buffer.from(await full.arrayBuffer()),mp4);
  const partial=await video.videoResponse(new Request('http://localhost/media',{headers:{Range:'bytes=4-7'}}),media);assert.equal(partial.status,206);assert.equal(partial.headers.get('Content-Range'),`bytes 4-7/${mp4.length}`);assert.equal(await partial.text(),'ftyp');
  const head=await video.videoResponse(new Request('http://localhost/media',{method:'HEAD',headers:{Range:'bytes=4-7'}}),media);assert.equal(head.status,206);assert.equal(head.headers.get('Content-Length'),'4');assert.equal(await head.text(),'');
  const invalid=await video.videoResponse(new Request('http://localhost/media',{headers:{Range:'bytes=500-'}}),media);assert.equal(invalid.status,416);assert.equal(invalid.headers.get('Content-Range'),`bytes */${mp4.length}`);
  await storage.deleteObject('videos/test.mp4');await assert.rejects(storage.getObjectSize('videos/test.mp4'));
});

test('storage rejects traversal and unexpected extensions before opening files or an OSS request',async()=>{
  for(const key of ['../outside.mp4','/outside.mp4','videos/../../outside.webm','videos/evil.html','videos/%2e%2e/evil.mp4','videos/file.mp4?x=1']) {
    await assert.rejects(storage.getObjectSize(key));await assert.rejects(storage.getObjectStream(key));await assert.rejects(storage.putObjectFile(key,path.join(root,'source.mp4'),'video/mp4'));await assert.rejects(storage.deleteObject(key));
  }
});

test('OSS writes and reads streams with private ACL and explicit verified ranges',async()=>{
  const original={put:OSS.prototype.putStream,head:OSS.prototype.head,get:OSS.prototype.getStream};config.storage='oss';
  let readRange='';let forceBadResponse=false;let rejectedStream:Readable|undefined;
  try {
    OSS.prototype.putStream=async function(name,stream,options){assert.equal(name,'videos/test.mp4');assert.equal(options!.contentLength,mp4.length);assert.equal(options!.mime,'video/mp4');assert.equal((options!.headers as Record<string,string>)['x-oss-object-acl'],'private');assert.deepEqual(await bytesOf(stream),mp4);return {name,res:{status:200,headers:{}}} as any;};
    OSS.prototype.head=async()=>({status:200,res:{status:200,headers:{'content-length':String(mp4.length)}}}) as any;
    OSS.prototype.getStream=async function(_name,options){readRange=(options?.headers as Record<string,string>)?.Range;const stream=Readable.from([Buffer.from('ftyp')]);if(forceBadResponse)rejectedStream=stream;return {stream,res:{status:forceBadResponse?200:206,headers:{'content-range':`bytes 4-7/${mp4.length}`}}} as any;};
    await storage.putObjectFile('videos/test.mp4',path.join(root,'source.mp4'),'video/mp4');assert.equal(await storage.getObjectSize('videos/test.mp4'),mp4.length);
    assert.equal((await bytesOf(await storage.getObjectStream('videos/test.mp4',{start:4,end:7}))).toString(),'ftyp');assert.equal(readRange,'bytes=4-7');
    forceBadResponse=true;await assert.rejects(storage.getObjectStream('videos/test.mp4',{start:4,end:7}));assert.equal(rejectedStream!.destroyed,true);
  }finally{config.storage='local';OSS.prototype.putStream=original.put;OSS.prototype.head=original.head;OSS.prototype.getStream=original.get;}
});

test('media request aborts and response cancellation destroy the upstream object stream',async()=>{
  const original={head:OSS.prototype.head,get:OSS.prototype.getStream};config.storage='oss';let upstream:Readable;
  try {
    OSS.prototype.head=async()=>({status:200,res:{status:200,headers:{'content-length':'1024'}}}) as any;
    OSS.prototype.getStream=async()=>{let sent=false;upstream=new Readable({read(){if(!sent){sent=true;this.push(Buffer.alloc(64));}}});return {stream:upstream,res:{status:200,headers:{}}} as any;};
    const controller=new AbortController(),response=await video.videoResponse(new Request('http://localhost/media',{signal:controller.signal}),{storage_key:'videos/test.mp4',mime:'video/mp4'});
    const reader=response.body!.getReader();await reader.read();controller.abort();await assert.rejects(reader.read());assert.equal(upstream!.destroyed,true);
    const cancelled=await video.videoResponse(new Request('http://localhost/media'),{storage_key:'videos/test.mp4',mime:'video/mp4'});await cancelled.body!.cancel();assert.equal(upstream!.destroyed,true);
  }finally{config.storage='local';OSS.prototype.head=original.head;OSS.prototype.getStream=original.get;}
});
