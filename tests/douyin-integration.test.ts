import { after,before,test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdir,mkdtemp } from 'node:fs/promises';
import path from 'node:path';
import EmbeddedPostgres from 'embedded-postgres';
import type pg from 'pg';

const videoId='7356906132482428172',videoUrl=`https://www.douyin.com/video/${videoId}`;
const author={userId:'douyin-author'},admin={userId:'douyin-admin'};
let engine:EmbeddedPostgres,pool:pg.Pool;
let query:typeof import('../src/server/db').query,execute:typeof import('../src/server/service').execute;
let processLink:typeof import('../src/server/worker').processLink,moderation:typeof import('../src/server/moderation');
type FetchPage=typeof import('../src/server/providers').safeFetch;
const successfulApi={err_no:0,data:{video_title:'公开技术视频',video_width:720,video_height:1280,iframe_code:`<iframe src="https://open.douyin.com/player/video?vid=${videoId}&autoplay=0" allowfullscreen></iframe>`}};
const fetchVideo:FetchPage=async url=>({url,headers:{},body:url.startsWith('https://open.douyin.com/api/')?JSON.stringify(successfulApi):'<title>技术分享</title>'});

before(async()=>{
  await mkdir('.local',{recursive:true});const root=await mkdtemp(path.resolve('.local','douyin-integration-'));
  Object.assign(process.env,{DEV_MODE:'true',INVITE_ONLY:'false',ADMIN_PHONE:'',APP_URL:'http://localhost:3195',
    DATABASE_URL:'postgresql://postgres:test-password@127.0.0.1:54341/postgres',BETTER_AUTH_SECRET:randomBytes(40).toString('hex'),
    STORAGE_DRIVER:'local',LOCAL_STORAGE_DIR:path.join(root,'uploads'),REDIS_URL:'',MEILI_URL:'',CONTENT_MODERATION_PROVIDER:'manual'});
  engine=new EmbeddedPostgres({databaseDir:path.join(root,'db'),user:'postgres',password:'test-password',port:54341,persistent:true,initdbFlags:['--encoding=UTF8','--locale=C'],postgresFlags:['-h','127.0.0.1'],onLog:()=>{},onError:()=>{}});
  await engine.initialise();await engine.start();
  ({pool,query}=await import('../src/server/db'));await (await import('../scripts/migrate')).migrate();
  ({execute}=await import('../src/server/service'));({processLink}=await import('../src/server/worker'));moderation=await import('../src/server/moderation');
  for(const actor of [author,admin]){
    await query(`INSERT INTO "user"(id,name,email,"emailVerified","createdAt","updatedAt") VALUES($1,$1,$2,true,now(),now())`,[actor.userId,`${actor.userId}@example.invalid`]);
    await query('INSERT INTO profiles(user_id,handle,role) VALUES($1,$1,$2)',[actor.userId,actor===admin?'admin':'member']);
  }
},{timeout:120000});
after(async()=>{if(pool)await pool.end();if(engine)await engine.stop();});

async function fixture(url=videoUrl){
  const post=await execute('posts_create',{body:`抖音视频测试 ${url}`},author);
  // Model an existing automated approval; no human decision is overwritten.
  await query("UPDATE posts SET moderation_status='approved' WHERE id=$1",[post.id]);
  await query("UPDATE link_resources SET moderation_status='approved' WHERE post_id=$1",[post.id]);
  await query("UPDATE moderation_cases SET status='approved',provider='aliyun' WHERE id=$1",[post.moderationId]);
  const [link]=await query('SELECT id FROM link_resources WHERE post_id=$1',[post.id]);
  return {...post,linkId:link.id};
}
async function resource(id:string){return (await query('SELECT * FROM link_resources WHERE id=$1',[id]))[0];}
async function approvePreview(id:string){
  const [entry]=await query("SELECT id FROM moderation_cases WHERE target_type='link' AND target_id=$1",[id]);
  await moderation.moderationDecide(admin,{id:entry.id,decision:'approve',reason:'核对视频标题和预览信息通过'});
}

test('a parsed player stays private until derived review passes, while the original post remains visible',async()=>{
  const post=await fixture();await processLink(post.linkId,fetchVideo);
  const link=await resource(post.linkId);assert.equal(link.metadata.douyinEmbed.videoId,videoId);
  assert.equal(link.derivation_status,'pending');assert.equal(link.moderation_status,'approved');
  assert.deepEqual((await execute('posts_get',{id:post.id},{})).links[0].metadata,{});
  await approvePreview(post.linkId);
  const publicLink=(await execute('posts_get',{id:post.id},{})).links[0];
  assert.deepEqual(publicLink.metadata.douyinEmbed,{videoId,width:720,height:1280});
  assert.ok(!JSON.stringify(publicLink.metadata).includes('<iframe'));
});

test('short shares use the safely resolved video ID and keep their original external link',async()=>{
  const short='https://v.douyin.com/test-share/';const post=await fixture(short);const requested:string[]=[];
  await processLink(post.linkId,async url=>{requested.push(url);return url===short?{url:`https://www.iesdouyin.com/share/video/${videoId}/`,headers:{},body:'<title>技术分享</title>'}:fetchVideo(url);});
  assert.equal(requested[0],short);assert.ok(requested.some(url=>url.includes(`video_id=${videoId}`)));
  await approvePreview(post.linkId);const link=(await execute('posts_get',{id:post.id},{})).links[0];
  assert.equal(link.url,short);assert.equal(link.metadata.douyinEmbed.videoId,videoId);
});

test('non-public videos never expose a player and do not change the original post approval',async()=>{
  const post=await fixture();
  await processLink(post.linkId,async url=>url.startsWith('https://open.douyin.com/api/')?{url,headers:{},body:JSON.stringify({err_no:28003004,err_msg:'非公开视频'})}:fetchVideo(url));
  assert.equal((await resource(post.linkId)).metadata.douyinEmbed,undefined);
  const view=await execute('posts_get',{id:post.id},{});assert.equal(view.moderation_status,'approved');assert.equal(view.links[0].url,videoUrl);
});

test('an in-flight player response cannot overwrite a subsequent human post approval',async()=>{
  const post=await fixture();let release!:()=>void,reached!:()=>void;
  const held=new Promise<void>(resolve=>{release=resolve;}),started=new Promise<void>(resolve=>{reached=resolve;});
  const running=processLink(post.linkId,async url=>{reached();await held;return fetchVideo(url);});
  await started;await moderation.moderationDecide(admin,{id:post.moderationId,decision:'approve',reason:'人工核对原始链接'});
  const before=await resource(post.linkId);release();await running;
  const after=await resource(post.linkId);assert.deepEqual(after.metadata,before.metadata);assert.equal(after.derivation_status,before.derivation_status);
  assert.equal((await execute('posts_get',{id:post.id},{})).links[0].metadata.douyinEmbed,undefined);
});

test('hidden and deleted posts cannot expose an approved player through detail or feeds',async()=>{
  const post=await fixture();await processLink(post.linkId,fetchVideo);await approvePreview(post.linkId);
  await execute('admin_content_moderate',{targetType:'post',targetId:post.id,decision:'hide'},admin);
  await assert.rejects(execute('posts_get',{id:post.id},{}));
  assert.ok(!(await execute('posts_list',{},{})).items.some((item:any)=>item.id===post.id));
  await execute('admin_content_moderate',{targetType:'post',targetId:post.id,decision:'restore'},admin);
  assert.equal((await execute('posts_get',{id:post.id},{})).links[0].metadata.douyinEmbed.videoId,videoId);
  await execute('admin_content_moderate',{targetType:'post',targetId:post.id,decision:'delete'},admin);
  await assert.rejects(execute('posts_get',{id:post.id},{}));
  let fetched=false;await processLink(post.linkId,async url=>{fetched=true;return fetchVideo(url);});assert.equal(fetched,false);
});
