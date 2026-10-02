import { after,before,test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes,randomUUID } from 'node:crypto';
import { mkdir,mkdtemp,readdir,readFile } from 'node:fs/promises';
import path from 'node:path';
import EmbeddedPostgres from 'embedded-postgres';
import pg from 'pg';
import sharp from 'sharp';
import type { Actor } from '../src/shared/contracts';
import { PRIVACY_VERSION } from '../src/shared/privacy';

const base='http://localhost:3197',author:Actor={userId:'admin-content-author'},other:Actor={userId:'admin-content-other'},admin:Actor={userId:'admin-content-admin'};
const actors=[author,other,admin],cookies=new Map<string,string>();
let engine:EmbeddedPostgres,root:string,pool:pg.Pool;
let query:typeof import('../src/server/db').query,execute:typeof import('../src/server/service').execute;
let http:typeof import('../src/server/http').handleApi,auth:typeof import('../src/server/auth').auth;
let moderation:typeof import('../src/server/moderation'),privacy:typeof import('../src/server/privacy');
let agentToken:string;
let worker:typeof import('../src/server/worker');
const indexed=new Map<string,any>();let failDelete=false;let pauseIndex:(()=>Promise<void>)|undefined;

before(async()=>{
  await mkdir('.local',{recursive:true});root=await mkdtemp(path.resolve('.local','admin-content-test-'));
  Object.assign(process.env,{DEV_MODE:'true',INVITE_ONLY:'false',ADMIN_PHONE:'',APP_URL:base,DATABASE_URL:'postgresql://postgres:test-password@127.0.0.1:54340/postgres',
    BETTER_AUTH_SECRET:randomBytes(40).toString('hex'),AUTH_IP_HEADER:'x-forwarded-for',STORAGE_DRIVER:'local',LOCAL_STORAGE_DIR:path.join(root,'uploads'),
    REDIS_URL:'',MEILI_URL:'http://127.0.0.1:1',DB_POOL_SIZE:'20',SMS_DAILY_LIMIT:'1000',USER_DAILY_IMAGE_LIMIT:'1000',CONTENT_MODERATION_PROVIDER:'manual',CONTENT_MODERATION_ACCESS_KEY_ID:'',CONTENT_MODERATION_ACCESS_KEY_SECRET:''});
  engine=new EmbeddedPostgres({databaseDir:path.join(root,'db'),user:'postgres',password:'test-password',port:54340,persistent:true,initdbFlags:['--encoding=UTF8','--locale=C'],postgresFlags:['-h','127.0.0.1'],onLog:()=>{},onError:()=>{}});
  await engine.initialise();await engine.start();
  ({pool,query}=await import('../src/server/db'));({execute}=await import('../src/server/service'));({auth}=await import('../src/server/auth'));
  await (await import('../scripts/migrate')).migrate();({handleApi:http}=await import('../src/server/http'));
  moderation=await import('../src/server/moderation');privacy=await import('../src/server/privacy');worker=await import('../src/server/worker');
  const meili=worker.meili!;
  meili.index=(()=>({addDocuments:async(docs:any[])=>{if(pauseIndex)await pauseIndex();for(const doc of docs)indexed.set(doc.id,doc);return {taskUid:1};},deleteDocument:async(id:string)=>{if(failDelete)throw new Error('test search service unavailable');indexed.delete(id);return {taskUid:1};},search:async()=>({hits:[...indexed.keys()].map(id=>({id}))})})) as any;
  meili.tasks.waitForTask=(async()=>({status:'succeeded'})) as any;
  for(const [index,actor] of actors.entries()) {
    const phoneNumber=`+861390900000${index}`;
    await query(`INSERT INTO "user"(id,name,email,"emailVerified","phoneNumber","phoneNumberVerified","createdAt","updatedAt") VALUES($1,$1,$2,true,$3,true,now(),now())`,[actor.userId,`${actor.userId}@example.invalid`,phoneNumber]);
    await query('INSERT INTO profiles(user_id,handle,role) VALUES($1,$1,$2)',[actor.userId,actor===admin?'admin':'member']);
    await success(await authRequest('/phone-number/send-otp',{phoneNumber}));
    const [otp]=await query('SELECT count FROM usage_counters WHERE key=$1',[`dev-otp:${phoneNumber}`]);
    const response=await authRequest('/phone-number/verify',{phoneNumber,code:String(otp.count).padStart(6,'0')});await success(response.clone());
    cookies.set(actor.userId!,response.headers.getSetCookie().map(value=>value.split(';')[0]).join('; '));
  }
  agentToken=(await execute('grants_create',{name:'头像权限测试',scopes:['content:read','posts:write'],days:1},admin)).token;
},{timeout:120000});
after(async()=>{if(pool)await pool.end();if(engine)await engine.stop();});
function authRequest(endpoint:string,body:Record<string,unknown>,actor?:Actor) {
  return auth.handler(new Request(`${base}/api/auth${endpoint}`,{method:'POST',headers:{Origin:base,'Content-Type':'application/json','X-Privacy-Version':PRIVACY_VERSION,'X-Forwarded-For':'198.51.100.139',...(actor?{Cookie:cookies.get(actor.userId!)!}:{})},body:JSON.stringify(body)}));
}
function request(endpoint:string,actor?:Actor,method='GET',body?:unknown,headers:Record<string,string>={}) {
  return http(new Request(`${base}/api/v1/${endpoint}`,{method,headers:{Origin:base,...(actor?{Cookie:cookies.get(actor.userId!)!}:{}),...headers,...(body!==undefined?{'Content-Type':'application/json'}:{})},body:body===undefined?undefined:JSON.stringify(body)}));
}
async function success(response:Response){const result=await response.json();assert.equal(response.status,200,JSON.stringify(result));return result;}
async function denied(response:Response){assert.ok(response.status>=400&&response.status<500,`${response.status}: ${await response.text()}`);}
async function upload(actor:Actor=author) {
  const bytes=await sharp({create:{width:4,height:4,channels:3,background:'#234567'}}).png().toBuffer();
  const form=new FormData();form.set('file',new File([new Uint8Array(bytes)],'admin-content.png',{type:'image/png'}));
  return success(await http(new Request(`${base}/api/v1/media`,{method:'POST',headers:{Origin:base,Cookie:cookies.get(actor.userId!)!},body:form})));
}
async function approve(id:string){return moderation.moderationDecide(admin,{id,decision:'approve',reason:'人工核对资料和原图通过'});}
async function caseFor(targetId:string,type='post'){return (await query('SELECT * FROM moderation_cases WHERE target_type=$1 AND target_id=$2',[type,targetId]))[0];}
async function publicImage(id:string,expected=200){const response=await request(`media/${id}`);assert.equal(response.status,expected);return response;}
function cloudAnswer(action:string|null) {
  return Response.json({Code:200,Data:action==='DescribeUploadToken'?{AccessKeyId:'temporary-test-id',AccessKeySecret:'temporary-test-secret',SecurityToken:'temporary-test-token',BucketName:'moderation-test-bucket',FileNamePrefix:'admin-contents/',OssInternetEndPoint:'https://oss-cn-shanghai.aliyuncs.com',Expiration:Math.floor(Date.now()/1000)+3600}:{RiskLevel:'none',Result:[{Label:'nonLabel'}]}});
}
async function delayedApproval(id:string,change:()=>Promise<unknown>) {
  const originalFetch=globalThis.fetch,keys=['CONTENT_MODERATION_PROVIDER','CONTENT_MODERATION_ACCESS_KEY_ID','CONTENT_MODERATION_ACCESS_KEY_SECRET'] as const;
  const saved=keys.map(key=>process.env[key]);let reached!:()=>void,release!:()=>void,first=true;
  const started=new Promise<void>(resolve=>{reached=resolve;}),held=new Promise<void>(resolve=>{release=resolve;});
  Object.assign(process.env,{CONTENT_MODERATION_PROVIDER:'aliyun',CONTENT_MODERATION_ACCESS_KEY_ID:randomUUID(),CONTENT_MODERATION_ACCESS_KEY_SECRET:'admin-content-race-secret'});
  globalThis.fetch=async(_url,init)=>{
    if(first){first=false;reached();await held;}
    return init?.method==='PUT'?new Response('',{status:200}):cloudAnswer(new URLSearchParams(String(init?.body)).get('Action'));
  };
  const running=moderation.processModeration(id);
  try {await started;await change();} finally {release();await running;globalThis.fetch=originalFetch;keys.forEach((key,index)=>{if(saved[index]===undefined)delete process.env[key];else process.env[key]=saved[index];});}
}
async function migratedDatabase(name:string,legacy=false) {
  await engine.createDatabase(name);const target=new pg.Pool({connectionString:`postgresql://postgres:test-password@127.0.0.1:54340/${name}`});
  const {getMigrations}=await import('better-auth/db/migration');await (await getMigrations({...auth.options,database:target})).runMigrations();
  await target.query('CREATE TABLE schema_migrations(name text PRIMARY KEY,applied_at timestamptz DEFAULT now())');
  for(const file of (await readdir('migrations')).filter(name=>name.endsWith('.sql')&&(!legacy||name<'011')).sort()) {
    await target.query(await readFile(path.join('migrations',file),'utf8'));await target.query('INSERT INTO schema_migrations(name) VALUES($1)',[file]);
  }
  return target;
}

async function post(body:string,actor:Actor=author,extra:Record<string,unknown>={},approved=true) {
  const result=await execute('posts_create',{body,...extra},actor);if(approved)await approve(result.moderationId);return result;
}
async function comment(postId:string,approved=true) {
  const result=await execute('comments_create',{id:postId,body:'回复可见性测试'},other);if(approved)await approve(result.moderationId);return result;
}
async function manage(targetId:string,decision:'hide'|'restore'|'delete',targetType:'post'|'comment'='post') {
  return execute('admin_content_moderate',{targetId,targetType,decision},admin);
}
async function absent(id:string,actor:Actor={}) {await assert.rejects(execute('posts_get',{id},actor),(error:any)=>[403,404].includes(error.status));}

test('only active human platform administrators can list or manage any content',async()=>{
  const p=await post('管理权限测试');
  for(const actor of [{},author,other]) {
    await assert.rejects(execute('admin_content_list',{},actor));
    await assert.rejects(execute('admin_content_moderate',{targetType:'post',targetId:p.id,decision:'hide'},actor));
  }
  assert.equal((await request('admin/content')).status,401);
  assert.equal((await request('admin/content',author)).status,403);
  assert.equal((await request('admin/content',undefined,'GET',undefined,{Authorization:`Bearer ${agentToken}`})).status,403);
  assert.equal((await request('admin/content/moderate',undefined,'POST',{targetType:'post',targetId:p.id,decision:'delete'},{Authorization:`Bearer ${agentToken}`})).status,403);
  await query('UPDATE profiles SET banned=true WHERE user_id=$1',[admin.userId]);
  await assert.rejects(execute('admin_content_list',{},admin));await assert.rejects(manage(p.id,'hide'));
  await query('UPDATE profiles SET banned=false WHERE user_id=$1',[admin.userId]);
  const body=await success(await request('admin/content',admin));assert.ok(body.items.some((item:any)=>item.id===p.id));
  await success(await request('admin/content/moderate',admin,'POST',{targetType:'post',targetId:p.id,decision:'hide'}));
  assert.equal((await caseFor(p.id)).status,'approved');
  const [audit]=await query("SELECT * FROM audit_logs WHERE action='admin_content_hide' AND target_id=$1",[p.id]);assert.equal(audit.user_id,admin.userId);
});

test('admin management bypasses private-community membership and block ACL without changing public access',async()=>{
  const id=randomUUID();await query(`INSERT INTO communities(id,name,description,city,visibility,owner_id) VALUES($1,'私密管理测试','私密说明','杭州','private',$2)`,[id,author.userId]);
  await query("INSERT INTO memberships(community_id,user_id,role,status) VALUES($1,$2,'admin','active')",[id,author.userId]);
  const image=await upload(),p=await post('私密帖子',{...author},{communityId:id,mediaIds:[image.id]});
  await query('INSERT INTO blocks(blocker_id,blocked_id) VALUES($1,$2)',[author.userId,admin.userId]);
  await absent(p.id,admin);
  const list=await execute('admin_content_list',{q:'私密帖子'},admin);assert.equal(list.items[0].id,p.id);assert.equal(list.items[0].communityVisibility,'private');assert.deepEqual(list.items[0].images,[image.id]);
  assert.equal((await request(`moderation/media/${image.id}`,admin)).status,200);
  await assert.rejects(execute('admin_content_moderate',{targetType:'post',targetId:p.id,decision:'delete'},author));
  await manage(p.id,'hide');await absent(p.id,author);await manage(p.id,'restore');await execute('posts_get',{id:p.id},author);await absent(p.id,admin);
  await query('DELETE FROM blocks WHERE blocker_id=$1 AND blocked_id=$2',[author.userId,admin.userId]);
});

test('hidden posts disappear from feeds, search, quote chains, media and owner publication state',async()=>{
  const image=await upload(),p=await post('隐藏链路唯一正文',author,{mediaIds:[image.id]});
  const quote=await post('隐藏链路第一转发',other,{originalId:p.id}),nested=await post('隐藏链路第二转发',author,{originalId:quote.id});
  const reply=await comment(p.id);
  for(const id of [p.id,quote.id,nested.id])await worker.indexPost(id);
  assert.equal((await request(`media/${image.id}`)).status,200);
  assert.ok((await execute('notifications_list',{},author)).items.some((item:any)=>item.comment_id===reply.id));
  await manage(p.id,'hide');
  for(const id of [p.id,quote.id,nested.id])await absent(id);
  assert.equal((await request(`media/${image.id}`)).status,404);
  assert.equal((await request(`media/${image.id}`,author)).status,404);
  assert.equal((await request(`moderation/media/${image.id}`,admin)).status,200);
  for(const action of ['posts_list','search'] as const){const list=await execute(action,action==='search'?{q:'隐藏链路'}:{},{});assert.ok(!(list.items||list.posts).some((item:any)=>[p.id,quote.id,nested.id].includes(item.id)));}
  assert.ok(!(await execute('notifications_list',{},author)).items.some((item:any)=>item.comment_id===reply.id));
  const mine=await moderation.moderationList(other,{mine:true});for(const item of mine.items.filter(item=>[quote.id,reply.id].includes(item.targetId))){assert.ok(item.hiddenAt);assert.ok(item.unavailable);assert.match(item.userReason,/隐藏/);}
  const adminReply=(await execute('admin_content_list',{targetType:'comment'},admin)).items.find((item:any)=>item.id===reply.id);assert.ok(adminReply.postHiddenAt);assert.ok(adminReply.unavailable);
  const indexJobs=await query("SELECT target_id FROM jobs WHERE kind='index' AND status='pending' AND target_id=ANY($1::text[])",[[p.id,quote.id,nested.id]]);assert.equal(indexJobs.length,3);
  for(const id of [p.id,quote.id,nested.id]){await worker.indexPost(id);assert.equal(indexed.has(id),false);}
  const exported=await privacy.exportOwnData(author);assert.ok(exported.posts.find(item=>item.id===p.id)?.hidden_at);assert.ok(!JSON.stringify(exported).includes('admin_content_hide'));
  await manage(p.id,'restore');await execute('posts_get',{id:nested.id},{});assert.equal((await request(`media/${image.id}`)).status,200);
  await manage(quote.id,'hide');assert.equal((await execute('posts_get',{id:p.id},{})).repostCount,0);
});

test('comments hide independently, remove their own notification and can restore without approving pending replies',async()=>{
  const p=await post('评论管理测试'),first=await comment(p.id),second=await comment(p.id);
  await manage(first.id,'hide','comment');
  const view=await execute('posts_get',{id:p.id},{});assert.deepEqual(view.comments.map((item:any)=>item.id),[second.id]);
  const notifications=(await execute('notifications_list',{},author)).items;assert.ok(!notifications.some((item:any)=>item.comment_id===first.id));assert.ok(notifications.some((item:any)=>item.comment_id===second.id));
  await manage(first.id,'restore','comment');assert.equal((await execute('posts_get',{id:p.id},{})).comments.length,2);
  const pending=await comment(p.id,false);await manage(pending.id,'hide','comment');await manage(pending.id,'restore','comment');
  assert.equal((await query('SELECT moderation_status FROM comments WHERE id=$1',[pending.id]))[0].moderation_status,'pending');assert.equal((await execute('posts_get',{id:p.id},{})).comments.length,2);
  await manage(first.id,'delete','comment');await assert.rejects(manage(first.id,'restore','comment'));await assert.rejects(approve(first.moderationId));
  assert.equal((await execute('posts_get',{id:p.id},{})).comments.length,1);
});

test('restoring reads the latest safety verdict and legacy content does not default to approved',async()=>{
  for(const state of ['pending','review','rejected']) {
    const p=await post(`恢复状态 ${state}`,author,{},false);await query('UPDATE posts SET moderation_status=$2 WHERE id=$1',[p.id,state]);await query('UPDATE moderation_cases SET status=$2 WHERE id=$1',[p.moderationId,state]);
    await manage(p.id,'hide');await manage(p.id,'restore');await absent(p.id);
    assert.equal((await query('SELECT moderation_status FROM posts WHERE id=$1',[p.id]))[0].moderation_status,state);
  }
  const legacy=randomUUID();await query("INSERT INTO posts(id,author_id,body,moderation_status) VALUES($1,$2,'legacy rejected','rejected')",[legacy,author.userId]);
  await manage(legacy,'hide');assert.equal((await caseFor(legacy)).status,'rejected');await manage(legacy,'restore');await absent(legacy);
  const p=await post('当前审核结果',author,{},false);await manage(p.id,'hide');await approve(p.moderationId);await absent(p.id);await manage(p.id,'restore');await execute('posts_get',{id:p.id},{});
});

test('late automated approval, explicit retry and old-worker writes cannot resurrect hidden content',async()=>{
  const p=await post('并发自动审核通过',author,{},false);
  await delayedApproval(p.moderationId,()=>manage(p.id,'hide'));
  assert.equal((await caseFor(p.id)).status,'approved');await absent(p.id);
  await query("UPDATE posts SET moderation_status='approved' WHERE id=$1",[p.id]);assert.equal((await query('SELECT moderation_status FROM posts WHERE id=$1',[p.id]))[0].moderation_status,'review');
  await moderation.moderationRetry(admin,{id:p.moderationId});await moderation.processModeration(p.moderationId);await absent(p.id);
  await manage(p.id,'restore');await absent(p.id);assert.equal((await caseFor(p.id)).status,'review');
  const parent=await post('隐藏回复并发父帖'),reply=await comment(parent.id,false);
  await delayedApproval(reply.moderationId,()=>manage(reply.id,'hide','comment'));
  await query("UPDATE comments SET moderation_status='approved' WHERE id=$1",[reply.id]);
  assert.equal((await query('SELECT moderation_status FROM comments WHERE id=$1',[reply.id]))[0].moderation_status,'review');
  assert.ok(!(await execute('posts_get',{id:parent.id},{})).comments.some((item:any)=>item.id===reply.id));assert.equal((await query('SELECT 1 FROM notifications WHERE comment_id=$1',[reply.id])).length,0);
  await manage(reply.id,'restore','comment');assert.ok((await execute('posts_get',{id:parent.id},{})).comments.some((item:any)=>item.id===reply.id));
});

test('deletion is terminal even during a provider request and clears jobs and image access',async()=>{
  const image=await upload(),p=await post('删除并发审核',author,{mediaIds:[image.id],links:['https://example.com/test']},false);
  await delayedApproval(p.moderationId,()=>manage(p.id,'delete'));await absent(p.id);await assert.rejects(manage(p.id,'restore'));await assert.rejects(approve(p.moderationId));await assert.rejects(moderation.moderationRetry(admin,{id:p.moderationId}));
  assert.equal((await caseFor(p.id)).status,'deleted');assert.equal((await request(`media/${image.id}`)).status,404);assert.equal((await request(`moderation/media/${image.id}`,admin)).status,404);
  const list=await execute('admin_content_list',{status:'deleted'},admin);assert.deepEqual(list.items.find((item:any)=>item.id===p.id).images,[]);
  assert.equal((await query("SELECT count(*)::int AS n FROM jobs WHERE status IN ('processing','pending') AND ((kind='moderation' AND target_id=$1) OR (kind='link' AND target_id IN (SELECT id FROM link_resources WHERE post_id=$2)))",[p.moderationId,p.id]))[0].n,0);
  await manage(p.id,'delete');
});

test('indexing serializes with original hiding and removal retries beyond ordinary attempt limits',async()=>{
  const p=await post('索引并发原文'),quote=await post('索引并发转发',other,{originalId:p.id});
  let entered!:()=>void,release!:()=>void;const started=new Promise<void>(resolve=>{entered=resolve;}),held=new Promise<void>(resolve=>{release=resolve;});
  pauseIndex=async()=>{entered();await held;};const indexing=worker.indexPost(quote.id);await started;
  const hiding=manage(p.id,'hide');release();await Promise.all([indexing,hiding]);pauseIndex=undefined;
  const [job]=await query("SELECT id FROM jobs WHERE kind='index' AND target_id=$1",[quote.id]);
  failDelete=true;await query("UPDATE jobs SET status='pending',attempts=7,available_at=now() WHERE id=$1",[job.id]);await worker.processJob(job.id);
  assert.equal((await query('SELECT status FROM jobs WHERE id=$1',[job.id]))[0].status,'pending');await absent(quote.id);
  failDelete=false;await query('UPDATE jobs SET available_at=now() WHERE id=$1',[job.id]);await worker.processJob(job.id);assert.equal(indexed.has(quote.id),false);
  await manage(p.id,'restore');await worker.indexPost(quote.id);assert.equal(indexed.has(quote.id),true);
});

test('pagination retains sub-millisecond ordering and filters literal search text',async()=>{
  const ids=['page-a','page-b','page-c'];for(const [index,id] of ids.entries())await query("INSERT INTO posts(id,author_id,body,moderation_status,created_at) VALUES($1,$2,'page-literal_%','approved',$3)",[id,author.userId,`2026-01-01 00:00:00.12300${index+1}+00`]);
  const found:string[]=[];let cursor:undefined|string;
  do {const result=await execute('admin_content_list',{q:'page-literal_%',limit:1,cursor},admin);found.push(...result.items.map((item:any)=>item.id));cursor=result.nextCursor;}while(cursor);
  assert.deepEqual(found,[...ids].reverse());
  assert.equal((await execute('admin_content_list',{q:'not-a-wildcard_%'},admin)).items.length,0);
  await assert.rejects(execute('admin_content_list',{cursor:'missing-position'},admin));
});

test('repeatable migrations and portable backups preserve hiding and notification ownership, and restore old snapshots',async()=>{
  await (await import('../scripts/migrate')).migrate();assert.equal((await query("SELECT count(*)::int AS n FROM schema_migrations WHERE name='011_admin_content.sql'"))[0].n,1);
  const p=await post('备份隐藏文章'),reply=await comment(p.id);await manage(p.id,'hide');
  const visible=await post('备份评论引用'),visibleReply=await comment(visible.id);
  const {createBackup,restoreBackup}=await import('../src/server/backup'),backup=path.join(root,'backup');await createBackup(backup,pool);
  const target=await migratedDatabase('admin_content_restored');
  try {await restoreBackup(backup,target,async()=>{});assert.ok((await target.query('SELECT hidden_at FROM posts WHERE id=$1',[p.id])).rows[0].hidden_at);assert.equal((await target.query('SELECT status FROM moderation_cases WHERE id=$1',[p.moderationId])).rows[0].status,'approved');assert.equal((await target.query('SELECT comment_id FROM notifications WHERE comment_id=$1',[visibleReply.id])).rows[0].comment_id,visibleReply.id);
    await target.query("UPDATE posts SET moderation_status='approved' WHERE id=$1",[p.id]);assert.equal((await target.query('SELECT moderation_status FROM posts WHERE id=$1',[p.id])).rows[0].moderation_status,'review');
  }finally{await target.end();}
  const source=await migratedDatabase('admin_content_legacy',true),restored=await migratedDatabase('admin_content_old_restored');
  try {await source.query(`INSERT INTO "user"(id,name,email,"emailVerified","createdAt","updatedAt") VALUES('legacy','旧成员','legacy@example.invalid',true,now(),now())`);await source.query("INSERT INTO profiles(user_id,handle) VALUES('legacy','legacy')");await source.query("INSERT INTO posts(id,author_id,body,moderation_status) VALUES('legacy-post','legacy','旧帖子','approved')");await source.query("INSERT INTO notifications(id,user_id,text,href) VALUES('legacy-notification','legacy','旧通知','/posts/legacy-post')");
    const oldBackup=path.join(root,'old-backup');await createBackup(oldBackup,source);await restoreBackup(oldBackup,restored,async()=>{});
    assert.equal((await restored.query("SELECT hidden_at FROM posts WHERE id='legacy-post'")).rows[0].hidden_at,null);assert.equal((await restored.query("SELECT comment_id FROM notifications WHERE id='legacy-notification'")).rows[0].comment_id,null);
  }finally{await source.end();await restored.end();}
});
