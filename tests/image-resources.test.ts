import { afterEach,test } from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { AppError } from '../src/shared/contracts';
import { readImageUploadForm,stripImageMetadata,withImageUploadSlot } from '../src/server/image-privacy';

const settings=['IMAGE_UPLOAD_CONCURRENCY','IMAGE_MAX_PIXELS','IMAGE_MAX_ANIMATION_PIXELS','IMAGE_MAX_ANIMATION_FRAMES'] as const;
const original=Object.fromEntries(settings.map(key=>[key,process.env[key]]));
afterEach(()=>{for(const key of settings){if(original[key]===undefined)delete process.env[key];else process.env[key]=original[key];}});

async function animation(format:'gif'|'webp') {
  const pixels=Buffer.concat([Buffer.alloc(4*4*3,32),Buffer.alloc(4*4*3,210)]);
  return sharp(pixels,{raw:{width:4,height:8,channels:3,pageHeight:4}})[format]({loop:0,delay:[100,200]}).toBuffer();
}
function isStatus(status:number){return (error:unknown)=>error instanceof AppError&&error.status===status;}

test('re-encoding preserves formats and all animation frames while stripping private metadata',async()=>{
  for(const format of ['png','jpeg','webp'] as const) {
    const input=await sharp({create:{width:8,height:6,channels:3,background:'#123456'}})[format]().withExif({IFD0:{Artist:'PRIVATE-CAMERA-OWNER'}}).toBuffer();
    assert.ok((await sharp(input).metadata()).exif);
    const output=await stripImageMetadata(input),metadata=await sharp(output).metadata();
    assert.equal(metadata.format,format);assert.equal(metadata.width,8);assert.equal(metadata.height,6);
    assert.equal(metadata.exif,undefined);assert.equal(metadata.xmp,undefined);assert.equal(metadata.iptc,undefined);
    assert.equal(output.includes(Buffer.from('PRIVATE-CAMERA-OWNER')),false);
  }
  for(const format of ['gif','webp'] as const) {
    const output=await stripImageMetadata(await animation(format));
    const metadata=await sharp(output,{animated:true}).metadata();
    assert.equal(metadata.format,format);assert.equal(metadata.pages,2);assert.equal(metadata.pageHeight,4);
    assert.deepEqual(metadata.delay,[100,200]);
  }
});

test('pixel, total animated pixel and frame budgets reject before decoding large images',async()=>{
  const still=await sharp({create:{width:8,height:8,channels:3,background:'#234'}}).png().toBuffer();
  process.env.IMAGE_MAX_PIXELS='63';
  await assert.rejects(stripImageMetadata(still),isStatus(413));
  process.env.IMAGE_MAX_PIXELS='64';
  await stripImageMetadata(still);
  for(const format of ['gif','webp'] as const) {
    const input=await animation(format);
    process.env.IMAGE_MAX_ANIMATION_FRAMES='1';
    await assert.rejects(stripImageMetadata(input),/帧数/);
    process.env.IMAGE_MAX_ANIMATION_FRAMES='2';process.env.IMAGE_MAX_ANIMATION_PIXELS='31';
    await assert.rejects(stripImageMetadata(input),isStatus(413));
    process.env.IMAGE_MAX_ANIMATION_PIXELS='32';
    assert.equal((await sharp(await stripImageMetadata(input),{animated:true}).metadata()).pages,2);
  }
  await assert.rejects(stripImageMetadata(Buffer.from('invalid image')),isStatus(400));
});

test('concurrent uploads reject without running or buffering the waiting request and always release the slot',async()=>{
  process.env.IMAGE_UPLOAD_CONCURRENCY='1';
  let release!:()=>void,attempted=false,cancelled=false;
  const held=withImageUploadSlot(new Request('http://localhost/upload'),()=>new Promise<void>(resolve=>{release=resolve;}));
  const body=new ReadableStream<Uint8Array>({cancel(){cancelled=true;}},{highWaterMark:0});
  const request=new Request('http://localhost/upload',{method:'POST',body,duplex:'half'} as RequestInit);
  await assert.rejects(withImageUploadSlot(request,async()=>{attempted=true;}),isStatus(503));
  assert.equal(attempted,false);assert.equal(cancelled,true);
  release();await held;
  await assert.rejects(withImageUploadSlot(new Request('http://localhost/upload'),async()=>{throw new Error('upload failure');}),/upload failure/);
  assert.equal(await withImageUploadSlot(new Request('http://localhost/upload'),async()=>42),42);
});

test('multipart reader preserves the file and consent field',async()=>{
  const form=new FormData();form.set('file',new File(['image content'],'image.png',{type:'image/png'}));form.set('aiConsent','true');
  const parsed=await readImageUploadForm(new Request('http://localhost/upload',{method:'POST',body:form}));
  assert.equal(parsed.get('aiConsent'),'true');assert.ok(parsed.get('file') instanceof File);
  assert.equal(await (parsed.get('file') as File).text(),'image content');
});

test('oversized streamed multipart is cancelled without relying on Content-Length',async()=>{
  let chunks=0,cancelled=false;
  const encoder=new TextEncoder();
  const body=new ReadableStream<Uint8Array>({
    pull(controller){chunks++;controller.enqueue(chunks===1?encoder.encode('--test\r\nContent-Disposition: form-data; name="file"; filename="image.png"\r\nContent-Type: image/png\r\n\r\n'):new Uint8Array(1024*1024));},
    cancel(){cancelled=true;}
  },{highWaterMark:0});
  const request=new Request('http://localhost/upload',{method:'POST',headers:{'Content-Type':'multipart/form-data; boundary=test'},body,duplex:'half'} as RequestInit);
  await assert.rejects(readImageUploadForm(request),isStatus(413));
  assert.ok(chunks<=13,`Reader consumed ${chunks} chunks`);assert.equal(cancelled,true);
});

test('declared oversized uploads are rejected before the stream is read',async()=>{
  let reads=0,cancelled=false;
  const body=new ReadableStream<Uint8Array>({pull(){reads++;},cancel(){cancelled=true;}},{highWaterMark:0});
  const request=new Request('http://localhost/upload',{method:'POST',headers:{'Content-Type':'multipart/form-data; boundary=test','Content-Length':String(11*1024*1024)},body,duplex:'half'} as RequestInit);
  await assert.rejects(readImageUploadForm(request),isStatus(413));
  assert.equal(reads,0);assert.equal(cancelled,true);
});
