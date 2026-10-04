import { after,before,test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes,randomUUID } from 'node:crypto';
import { mkdir,mkdtemp,readdir } from 'node:fs/promises';
import path from 'node:path';
import EmbeddedPostgres from 'embedded-postgres';
import type pg from 'pg';
import sharp from 'sharp';
import OSS from 'ali-oss';
import type { Actor } from '../src/shared/contracts';
import { PRIVACY_VERSION } from '../src/shared/privacy';

const base='http://localhost:3198',maxBytes=50*1024*1024;
const author:Actor={userId:'video-author'},other:Actor={userId:'video-other'},admin:Actor={userId:'video-admin'};
const cookies=new Map<string,string>();
let engine:EmbeddedPostgres,pool:pg.Pool,root:string,agentToken:string,readerToken:string;
let query:typeof import('../src/server/db').query,execute:typeof import('../src/server/service').execute;
let http:typeof import('../src/server/http').handleApi,auth:typeof import('../src/server/auth').auth;
let moderation:typeof import('../src/server/moderation');

// Container-only fixtures exercise upload signatures and byte serving, not codecs.
// No external videos, personal files, or network media are used by this suite.
function box(type:string,data:Buffer) {
  const header=Buffer.alloc(8);header.writeUInt32BE(data.length+8);header.write(type,4,'ascii');return Buffer.concat([header,data]);
}
const mp4=Buffer.concat([box('ftyp',Buffer.from('isom\0\0\0\0isommp42','binary')),box('mdat',Buffer.from('local-video-fixture-payload'))]);

before(async()=>{
  await mkdir('.local',{recursive:true});root=await mkdtemp(path.resolve('.local','video-upload-test-'));
  Object.assign(process.env,{DEV_MODE:'true',INVITE_ONLY:'false',ADMIN_PHONE:'',APP_URL:base,
    DATABASE_URL:'postgresql://postgres:test-password@127.0.0.1:54342/postgres',BETTER_AUTH_SECRET:randomBytes(40).toString('hex'),AUTH_IP_HEADER:'x-forwarded-for',
    STORAGE_DRIVER:'local',LOCAL_STORAGE_DIR:path.join(root,'uploads'),REDIS_URL:'',MEILI_URL:'',DB_POOL_SIZE:'20',
    SMS_DAILY_LIMIT:'1000',USER_DAILY_IMAGE_LIMIT:'1000',USER_DAILY_VIDEO_LIMIT:'1000',IMAGE_UPLOAD_CONCURRENCY:'1',
    CONTENT_MODERATION_PROVIDER:'manual',CONTENT_MODERATION_ACCESS_KEY_ID:'',CONTENT_MODERATION_ACCESS_KEY_SECRET:''});
  engine=new EmbeddedPostgres({databaseDir:path.join(root,'db'),user:'postgres',password:'test-password',port:54342,persistent:true,
    initdbFlags:['--encoding=UTF8','--locale=C'],postgresFlags:['-h','127.0.0.1'],onLog:()=>{},onError:()=>{}});
  await engine.initialise();await engine.start();
  ({pool,query}=await import('../src/server/db'));({execute}=await import('../src/server/service'));({auth}=await import('../src/server/auth'));
  await (await import('../scripts/migrate')).migrate();({handleApi:http}=await import('../src/server/http'));moderation=await import('../src/server/moderation');
  for(const [index,actor] of [author,other,admin].entries()) {
    const phoneNumber=`+861391800000${index}`;
    await query(`INSERT INTO "user"(id,name,email,"emailVerified","phoneNumber","phoneNumberVerified","createdAt","updatedAt") VALUES($1,$1,$2,true,$3,true,now(),now())`,[actor.userId,`${actor.userId}@example.invalid`,phoneNumber]);
    await query('INSERT INTO profiles(user_id,handle,role) VALUES($1,$1,$2)',[actor.userId,actor===admin?'admin':'member']);
    await success(await authRequest('/phone-number/send-otp',{phoneNumber}));
    const [otp]=await query('SELECT count FROM usage_counters WHERE key=$1',[`dev-otp:${phoneNumber}`]);
    const response=await authRequest('/phone-number/verify',{phoneNumber,code:String(otp.count).padStart(6,'0')});await success(response.clone());
    cookies.set(actor.userId!,response.headers.getSetCookie().map(value=>value.split(';')[0]).join('; '));
  }
  agentToken=(await execute('grants_create',{name:'视频权限测试',scopes:['content:read','posts:write'],days:1},author)).token;
  readerToken=(await execute('grants_create',{name:'只读视频测试',scopes:['content:read'],days:1},author)).token;
},{timeout:120000});
after(async()=>{if(pool)await pool.end();if(engine)await engine.stop();});

function authRequest(endpoint:string,body:Record<string,unknown>) {
  return auth.handler(new Request(`${base}/api/auth${endpoint}`,{method:'POST',headers:{Origin:base,'Content-Type':'application/json','X-Privacy-Version':PRIVACY_VERSION,'X-Forwarded-For':'198.51.100.142'},body:JSON.stringify(body)}));
}
function request(endpoint:string,actor?:Actor,method='GET',headers:Record<string,string>={}) {
  return http(new Request(`${base}/api/v1/${endpoint}`,{method,headers:{Origin:base,...(actor?{Cookie:cookies.get(actor.userId!)!}:{}),...headers}}));
}
function rawRequest(bytes:BodyInit=new Uint8Array(mp4),actor:Actor|null=author,headers:Record<string,string>={}) {
  return new Request(`${base}/api/v1/media/video`,{method:'POST',headers:{Origin:base,'Content-Type':'video/mp4',...(actor?{Cookie:cookies.get(actor.userId!)!}:{}),...headers},body:bytes,duplex:'half'} as RequestInit);
}
async function success(response:Response){const data=await response.json();assert.equal(response.status,200,JSON.stringify(data));return data;}
async function denied(response:Response,statuses=[401,403,404]){assert.ok(statuses.includes(response.status),`${response.status}: ${await response.text()}`);}
async function upload(actor:Actor=author){return success(await http(rawRequest(new Uint8Array(mp4),actor)));}
async function imageUpload() {
  const bytes=await sharp({create:{width:4,height:4,channels:3,background:'#345678'}}).png().toBuffer();
  const form=new FormData();form.set('file',new File([new Uint8Array(bytes)],'video-mixed-image.png',{type:'image/png'}));
  return success(await http(new Request(`${base}/api/v1/media`,{method:'POST',headers:{Origin:base,Cookie:cookies.get(author.userId!)!},body:form})));
}
async function caseFor(postId:string){return (await query("SELECT * FROM moderation_cases WHERE target_type='post' AND target_id=$1",[postId]))[0];}
async function approve(id:string){return moderation.moderationDecide(admin,{id,decision:'approve',reason:'人工查看视频画面、声音和正文后通过'});}
async function publish(mediaId:string,approved=false,extra:Record<string,unknown>={}) {
  const post=await execute('posts_create',{body:'本地视频上传测试',mediaIds:[mediaId],...extra},author);if(approved)await approve(post.moderationId);return post;
}
async function assertPrivate(id:string) {
  for(const actor of [undefined,other,admin])for(const method of ['GET','HEAD'])await denied(await request(`media/${id}`,actor,method,{Range:'bytes=0-7'}));
  await denied(await request(`media/${id}`,undefined,'GET',{Authorization:`Bearer ${agentToken}`}));
}
async function fileList(directory:string):Promise<string[]> {
  let entries;try{entries=await readdir(directory,{withFileTypes:true});}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return [];throw error;}
  const result:string[]=[];for(const entry of entries){const file=path.join(directory,entry.name);result.push(...(entry.isDirectory()?await fileList(file):[file]));}return result.sort();
}

test('video upload requires an active writer and same-origin browser request',async()=>{
  await denied(await http(rawRequest(new Uint8Array(mp4),null)));
  assert.equal((await http(rawRequest(new Uint8Array(mp4),author,{Origin:'https://other.example'}))).status,403);
  assert.equal((await http(rawRequest(new Uint8Array(mp4),null,{Authorization:`Bearer ${readerToken}`}))).status,403);
  await query('UPDATE profiles SET banned=true WHERE user_id=$1',[other.userId]);
  try{await denied(await http(rawRequest(new Uint8Array(mp4),other)),[403]);}finally{await query('UPDATE profiles SET banned=false WHERE user_id=$1',[other.userId]);}
  assert.equal((await query('SELECT count(*)::int AS n FROM media'))[0].n,0);
});

test('MIME and container checks reject fake video without persisting an object',async()=>{
  const before=await fileList(path.join(root,'uploads'));
  for(const [bytes,mime] of [[Buffer.from('not a video'),'video/mp4'],[mp4,'video/webm'],[mp4,'text/html'],[Buffer.alloc(0),'video/mp4']] as const) {
    await denied(await http(rawRequest(new Uint8Array(bytes),author,{'Content-Type':mime})),[400,415]);
  }
  assert.equal((await query('SELECT count(*)::int AS n FROM media'))[0].n,0);
  assert.deepEqual(await fileList(path.join(root,'uploads')),before);
});

test('declared and actual upload limits reject before storing oversized bodies',{timeout:30000},async()=>{
  let reads=0,cancelled=false;
  const declared=new ReadableStream<Uint8Array>({pull(){reads++;},cancel(){cancelled=true;}},{highWaterMark:0});
  assert.equal((await http(rawRequest(declared,author,{'Content-Length':String(maxBytes+1)}))).status,413);
  assert.equal(reads,0);assert.equal(cancelled,true);
  const before=await fileList(path.join(root,'uploads'));let chunks=0,stopped=false;
  const streaming=new ReadableStream<Uint8Array>({pull(controller){chunks++;controller.enqueue(chunks===1?new Uint8Array(mp4):new Uint8Array(1024*1024));},cancel(){stopped=true;}},{highWaterMark:0});
  assert.equal((await http(rawRequest(streaming))).status,413);assert.equal(stopped,true);assert.ok(chunks<=52,`Read ${chunks} oversized chunks`);
  assert.deepEqual(await fileList(path.join(root,'uploads')),before);
  assert.equal((await query('SELECT count(*)::int AS n FROM media'))[0].n,0);
});

test('video uploads share the image semaphore and never buffer a busy request',async()=>{
  const {withImageUploadSlot}=await import('../src/server/image-privacy');let release!:()=>void,reads=0,cancelled=false;
  const held=withImageUploadSlot(new Request(`${base}/upload`),()=>new Promise<void>(resolve=>{release=resolve;}));
  try {
    const body=new ReadableStream<Uint8Array>({pull(){reads++;},cancel(){cancelled=true;}},{highWaterMark:0});
    assert.equal((await http(rawRequest(body))).status,503);assert.equal(reads,0);assert.equal(cancelled,true);
  }finally{release();await held;}
});

test('WebM uses its verified MIME and original bytes',async()=>{
  const bytes=Buffer.from('1a45dfa3874282847765626d','hex');
  const video=await success(await http(rawRequest(new Uint8Array(bytes),author,{'Content-Type':'video/webm'})));
  assert.equal(video.mime,'video/webm');const response=await request(`media/${video.id}`,author);
  assert.equal(response.headers.get('content-type'),'video/webm');assert.deepEqual(Buffer.from(await response.arrayBuffer()),bytes);
});

test('an unattached video is owner-only; pending video is readable only through authorized moderation preview',async()=>{
  const video=await upload();assert.equal(video.mime,'video/mp4');assert.equal(video.url,`/api/v1/media/${video.id}`);
  const row=(await query('SELECT * FROM media WHERE id=$1',[video.id]))[0];assert.equal(row.bytes,String(mp4.length));assert.equal(row.ai_consent,false);assert.equal(row.post_id,null);
  await assertPrivate(video.id);
  const own=await request(`media/${video.id}`,author);assert.equal(own.status,200);assert.deepEqual(Buffer.from(await own.arrayBuffer()),mp4);
  await denied(await request(`moderation/media/${video.id}`,admin));
  const post=await publish(video.id);
  await assertPrivate(video.id);await denied(await request(`media/${video.id}`,author));
  await denied(await request(`moderation/media/${video.id}`));await denied(await request(`moderation/media/${video.id}`,other));
  await denied(await request(`moderation/media/${video.id}`,undefined,'GET',{Authorization:`Bearer ${agentToken}`}));
  for(const actor of [author,admin]) {
    const preview=await request(`moderation/media/${video.id}`,actor,'GET',{Range:'bytes=0-7'});assert.equal(preview.status,206);assert.deepEqual(Buffer.from(await preview.arrayBuffer()),mp4.subarray(0,8));
  }
  for(const actor of [author,admin]) {
    const item=(await moderation.moderationList(actor,{mine:actor!==admin})).items.find(item=>item.id===post.moderationId)!;
    assert.deepEqual(item.images,[]);assert.deepEqual(item.videos,[{id:video.id,mime:'video/mp4'}]);
    if(actor===author)for(const field of ['labels','reason','provider','history','reviewedBy'])assert.ok(!(field in item));
  }
});

test('safe cloud text results cannot auto-approve a video or enqueue it for image OCR',async()=>{
  const video=await upload(),post=await publish(video.id,false,{imageAnalysisConsent:true});
  assert.equal((await query('SELECT ai_consent FROM media WHERE id=$1',[video.id]))[0].ai_consent,false);
  assert.equal((await query("SELECT count(*)::int AS n FROM jobs WHERE kind='image' AND target_id=$1",[video.id]))[0].n,0);
  const savedFetch=globalThis.fetch,keys=['CONTENT_MODERATION_PROVIDER','CONTENT_MODERATION_ACCESS_KEY_ID','CONTENT_MODERATION_ACCESS_KEY_SECRET'] as const;
  const saved=keys.map(key=>process.env[key]);const actions:string[]=[];
  try {
    Object.assign(process.env,{CONTENT_MODERATION_PROVIDER:'aliyun',CONTENT_MODERATION_ACCESS_KEY_ID:randomUUID(),CONTENT_MODERATION_ACCESS_KEY_SECRET:'video-fixture-cloud-secret'});
    globalThis.fetch=async(_url,init)=>{const action=new URLSearchParams(String(init?.body)).get('Action')||'';actions.push(action);return Response.json({Code:200,Data:{RiskLevel:'none',Result:[{Label:'nonLabel'}]}});};
    await moderation.processModeration(post.moderationId);
  }finally{globalThis.fetch=savedFetch;keys.forEach((key,index)=>{if(saved[index]===undefined)delete process.env[key];else process.env[key]=saved[index];});}
  assert.equal((await caseFor(post.id)).status,'review');assert.deepEqual(actions,[]);
  await denied(await request(`media/${video.id}`));await assert.rejects(execute('posts_get',{id:post.id},{}));
  await approve(post.moderationId);assert.equal((await execute('posts_get',{id:post.id},{})).media[0].mime,'video/mp4');
});

test('approved video streams byte ranges, suffixes, full bodies and bodyless HEAD',async()=>{
  const video=await upload();await publish(video.id,true);
  const full=await request(`media/${video.id}`);assert.equal(full.status,200);assert.equal(full.headers.get('content-type'),'video/mp4');
  assert.equal(full.headers.get('accept-ranges'),'bytes');assert.equal(full.headers.get('content-length'),String(mp4.length));assert.match(full.headers.get('cache-control')||'',/no-store/);
  assert.deepEqual(Buffer.from(await full.arrayBuffer()),mp4);
  for(const [range,start,end] of [['bytes=0-7',0,7],['bytes=8-',8,mp4.length-1],['bytes=-5',mp4.length-5,mp4.length-1],['bytes=0-9999',0,mp4.length-1]] as const) {
    const response=await request(`media/${video.id}`,undefined,'GET',{Range:range});assert.equal(response.status,206,range);
    assert.equal(response.headers.get('content-range'),`bytes ${start}-${end}/${mp4.length}`);assert.equal(response.headers.get('content-length'),String(end-start+1));
    assert.deepEqual(Buffer.from(await response.arrayBuffer()),mp4.subarray(start,end+1));
  }
  for(const range of [`bytes=${mp4.length}-`,'bytes=9-2','bytes=-0','bytes=0-1,4-5','bytes=9007199254740993-']) {
    const response=await request(`media/${video.id}`,undefined,'GET',{Range:range});assert.equal(response.status,416,range);assert.equal(response.headers.get('content-range'),`bytes */${mp4.length}`);
  }
  const head=await request(`media/${video.id}`,undefined,'HEAD');assert.equal(head.status,200);assert.equal(head.headers.get('content-length'),String(mp4.length));assert.equal((await head.arrayBuffer()).byteLength,0);
  const rangedHead=await request(`media/${video.id}`,undefined,'HEAD',{Range:'bytes=0-7'});assert.equal(rangedHead.status,206);
  assert.equal(rangedHead.headers.get('content-range'),`bytes 0-7/${mp4.length}`);assert.equal(rangedHead.headers.get('content-length'),'8');assert.equal((await rangedHead.arrayBuffer()).byteLength,0);
});

test('media claiming enforces owner, one video, and no mixed images atomically',async()=>{
  const first=await upload(),second=await upload(),image=await imageUpload();
  const before=(await query('SELECT count(*)::int AS n FROM posts'))[0].n;
  await assert.rejects(execute('posts_create',{body:'越权视频',mediaIds:[first.id]},other));
  for(const mediaIds of [[first.id,second.id],[first.id,image.id],[image.id,first.id],[first.id,first.id]])await assert.rejects(execute('posts_create',{body:'附件限制',mediaIds},author));
  assert.equal((await query('SELECT count(*)::int AS n FROM posts'))[0].n,before);
  for(const id of [first.id,second.id,image.id])assert.equal((await query('SELECT post_id FROM media WHERE id=$1',[id]))[0].post_id,null);
  await assert.rejects(execute('profile_update',{name:'视频不能作为头像',bio:'',city:'',avatarMediaId:first.id},author));
  assert.equal((await query('SELECT usage_kind FROM media WHERE id=$1',[first.id]))[0].usage_kind,'post');
  await publish(first.id,true);await assert.rejects(publish(first.id));
});

test('hide and delete immediately revoke video GET, HEAD, ranges and quote-chain visibility',async()=>{
  const video=await upload(),post=await publish(video.id,true);
  const quote=await execute('posts_create',{body:'视频转发测试',originalId:post.id},other);await approve(quote.moderationId);
  await execute('admin_content_moderate',{targetType:'post',targetId:post.id,decision:'hide'},admin);
  for(const actor of [undefined,author,other,admin])for(const method of ['GET','HEAD'])await denied(await request(`media/${video.id}`,actor,method,{Range:'bytes=0-7'}),[403,404]);
  await assert.rejects(execute('posts_get',{id:quote.id},{}));
  const review=await request(`moderation/media/${video.id}`,admin);assert.equal(review.status,200);await review.arrayBuffer();
  await execute('admin_content_moderate',{targetType:'post',targetId:post.id,decision:'restore'},admin);
  assert.equal((await request(`media/${video.id}`,undefined,'HEAD')).status,200);
  await execute('admin_content_moderate',{targetType:'post',targetId:post.id,decision:'delete'},admin);
  for(const endpoint of [`media/${video.id}`,`moderation/media/${video.id}`])for(const actor of [undefined,author,admin])for(const method of ['GET','HEAD'])await denied(await request(endpoint,actor,method,{Range:'bytes=0-7'}),[403,404]);
});

test('privacy export includes video metadata without storage keys or internal moderation results',async()=>{
  const video=await upload();const exported=await (await import('../src/server/privacy')).exportOwnData(author);
  const item=exported.media.find(item=>item.id===video.id);assert.ok(item);assert.equal(item.mime,'video/mp4');assert.equal(item.bytes,String(mp4.length));
  assert.ok(!('storage_key' in item));assert.ok(!('provider' in item));assert.ok(!('labels' in item));
});

test('cancelling after OSS receives the video rolls back media and queues object cleanup',async()=>{
  const {config}=await import('../src/server/config');
  const originalStorage=config.storage,originalPut=OSS.prototype.putStream;
  const keys=['OSS_REGION','OSS_BUCKET','ALI_ACCESS_KEY_ID','ALI_ACCESS_KEY_SECRET'] as const;
  const saved=keys.map(key=>process.env[key]);const controller=new AbortController();let uploadedKey='';
  const before=(await query('SELECT count(*)::int AS n FROM media'))[0].n;
  try {
    config.storage='oss';Object.assign(process.env,{OSS_REGION:'oss-cn-hangzhou',OSS_BUCKET:'video-abort-fixture',ALI_ACCESS_KEY_ID:'fixture-id',ALI_ACCESS_KEY_SECRET:'fixture-secret'});
    OSS.prototype.putStream=async function(key,stream,options) {
      uploadedKey=key;const chunks:Buffer[]=[];for await(const chunk of stream)chunks.push(Buffer.from(chunk));
      assert.deepEqual(Buffer.concat(chunks),mp4);assert.equal(options!.mime,'video/mp4');
      assert.equal((options!.headers as Record<string,string>)['x-oss-object-acl'],'private');
      controller.abort();return {name:key,res:{status:200,headers:{}}} as any;
    };
    const response=await http(new Request(rawRequest(),{signal:controller.signal}));
    assert.equal(response.status,400);assert.match((await response.json()).error,/取消/);
    assert.ok(uploadedKey.startsWith('videos/'));assert.equal((await query('SELECT count(*)::int AS n FROM media'))[0].n,before);
    const [cleanup]=await query(`SELECT d.storage_backend,d.storage_location,j.status FROM privacy_object_deletions d
      JOIN jobs j ON j.kind='delete-object' AND j.target_id=d.id WHERE d.storage_key=$1`,[uploadedKey]);
    assert.ok(cleanup);assert.equal(cleanup.storage_backend,'oss');assert.equal(cleanup.storage_location,'oss-cn-hangzhou/video-abort-fixture');assert.equal(cleanup.status,'pending');
  } finally {
    config.storage=originalStorage;OSS.prototype.putStream=originalPut;
    keys.forEach((key,index)=>{if(saved[index]===undefined)delete process.env[key];else process.env[key]=saved[index];});
  }
});

test('account closure removes video upload counters and media while retaining durable object cleanup',async()=>{
  const videos=await query("SELECT id,storage_key FROM media WHERE owner_id=$1 AND mime IN ('video/mp4','video/webm')",[author.userId]);
  assert.ok(videos.length>0);
  assert.ok((await query("SELECT 1 FROM usage_counters WHERE key LIKE 'upload-video:'||$1||':%'",[author.userId])).length>0);
  const result=await (await import('../src/server/privacy')).closeAccount(author);assert.equal(result.closed,true);
  assert.equal((await query("SELECT count(*)::int AS n FROM usage_counters WHERE key LIKE 'upload-video:'||$1||':%'",[author.userId]))[0].n,0);
  assert.equal((await query('SELECT count(*)::int AS n FROM media WHERE owner_id=$1',[author.userId]))[0].n,0);
  const cleanups=await query(`SELECT d.storage_key,d.storage_backend,j.status FROM privacy_object_deletions d
    JOIN jobs j ON j.kind='delete-object' AND j.target_id=d.id WHERE d.storage_key=ANY($1::text[])`,[videos.map(video=>video.storage_key)]);
  assert.deepEqual(cleanups.map(item=>item.storage_key).sort(),videos.map(video=>video.storage_key).sort());
  assert.ok(cleanups.every(item=>item.storage_backend==='local'&&item.status==='pending'));
  await denied(await request(`media/${videos[0].id}`,undefined,'HEAD'),[404]);
});
