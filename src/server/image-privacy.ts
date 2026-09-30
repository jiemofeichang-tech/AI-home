import sharp from 'sharp';
import { AppError,fail } from '../shared/contracts';

const MAX_IMAGE_BYTES=10*1024*1024;
const MAX_UPLOAD_BYTES=MAX_IMAGE_BYTES+100_000;
let activeUploads=0;

function budget(name:string,fallback:number):number {
  const value=Number(process.env[name]||fallback);
  if(!Number.isSafeInteger(value)||value<1)throw new Error(`${name} must be a positive integer`);
  return value;
}

/** Acquire before reading the request body; excess requests never queue buffers. */
export async function withImageUploadSlot<T>(request:Request,operation:()=>Promise<T>):Promise<T> {
  if(activeUploads>=budget('IMAGE_UPLOAD_CONCURRENCY',2)) {
    void request.body?.cancel().catch(()=>{});
    fail(503,'图片上传繁忙，请稍后重试','IMAGE_UPLOAD_BUSY');
  }
  activeUploads++;
  try{return await operation();}finally{activeUploads--;}
}

/** Bound the actual multipart stream too, including when Content-Length is absent. */
export async function readImageUploadForm(request:Request):Promise<FormData> {
  if(Number(request.headers.get('content-length')||0)>MAX_UPLOAD_BYTES) {
    void request.body?.cancel().catch(()=>{});
    fail(413,'单张图片不能超过 10 MB');
  }
  if(!request.body)fail(400,'请上传图片');
  let received=0;
  const body=request.body.pipeThrough(new TransformStream<Uint8Array,Uint8Array>({
    transform(chunk,controller) {
      received+=chunk.byteLength;
      if(received>MAX_UPLOAD_BYTES)fail(413,'单张图片不能超过 10 MB');
      controller.enqueue(chunk);
    }
  }));
  try{return await new Response(body,{headers:{'Content-Type':request.headers.get('content-type')||''}}).formData();}
  catch(error){if(error instanceof AppError)throw error;fail(400,'无法读取上传内容，请重新选择图片');}
}

/** Re-encode accepted images to strip EXIF/GPS, XMP and other hidden metadata. */
export async function stripImageMetadata(input:Buffer):Promise<Buffer> {
  const pixels=budget('IMAGE_MAX_PIXELS',40_000_000);
  const animationPixels=budget('IMAGE_MAX_ANIMATION_PIXELS',40_000_000);
  const animationFrames=budget('IMAGE_MAX_ANIMATION_FRAMES',200);
  try {
    // metadata() reads headers without decoding pixel data. Check all frames
    // before re-encoding, and retain libvips' input limit during decoding.
    const metadata=await sharp(input,{animated:true,limitInputPixels:Math.max(pixels,animationPixels)}).metadata();
    const frames=metadata.pages||1;
    const framePixels=metadata.width*(metadata.pageHeight||metadata.height);
    if(framePixels>pixels)fail(413,'图片像素过大，请缩小后再上传');
    if(frames>animationFrames)fail(413,'动图帧数过多，请缩短后再上传');
    if(frames>1&&framePixels*frames>animationPixels)fail(413,'动图总像素过大，请缩小或缩短后再上传');
    const output=await sharp(input,{animated:true,limitInputPixels:frames>1?animationPixels:pixels}).rotate().toBuffer();
    if(output.length>MAX_IMAGE_BYTES)fail(413,'处理后的图片超过 10 MB，请缩小后再上传');
    return output;
  }catch(error){if(error instanceof AppError)throw error;if(error instanceof Error&&error.message.includes('pixel limit'))fail(413,'图片或动图总像素过大，请缩小后再上传');fail(400,'无法读取该图片，请上传有效的 PNG、JPG、WebP 或 GIF');}
}
