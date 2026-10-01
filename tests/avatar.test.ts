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

const base='http://localhost:3196',author:Actor={userId:'avatar-author'},other:Actor={userId:'avatar-other'},admin:Actor={userId:'avatar-admin'};
const actors=[author,other,admin],cookies=new Map<string,string>();
let engine:EmbeddedPostgres,root:string,pool:pg.Pool;
let query:typeof import('../src/server/db').query,execute:typeof import('../src/server/service').execute;
let http:typeof import('../src/server/http').handleApi,auth:typeof import('../src/server/auth').auth;
let moderation:typeof import('../src/server/moderation'),privacy:typeof import('../src/server/privacy');
let currentId:string,currentDraft:string,agentToken:string;

before(async()=>{
  await mkdir('.local',{recursive:true});root=await mkdtemp(path.resolve('.local','avatar-test-'));
  Object.assign(process.env,{DEV_MODE:'true',INVITE_ONLY:'false',ADMIN_PHONE:'',APP_URL:base,DATABASE_URL:'postgresql://postgres:test-password@127.0.0.1:54339/postgres',
    BETTER_AUTH_SECRET:randomBytes(40).toString('hex'),AUTH_IP_HEADER:'x-forwarded-for',STORAGE_DRIVER:'local',LOCAL_STORAGE_DIR:path.join(root,'uploads'),
    REDIS_URL:'',MEILI_URL:'',DB_POOL_SIZE:'20',SMS_DAILY_LIMIT:'1000',USER_DAILY_IMAGE_LIMIT:'1000',CONTENT_MODERATION_PROVIDER:'manual',CONTENT_MODERATION_ACCESS_KEY_ID:'',CONTENT_MODERATION_ACCESS_KEY_SECRET:''});
  engine=new EmbeddedPostgres({databaseDir:path.join(root,'db'),user:'postgres',password:'test-password',port:54339,persistent:true,initdbFlags:['--encoding=UTF8','--locale=C'],postgresFlags:['-h','127.0.0.1'],onLog:()=>{},onError:()=>{}});
  await engine.initialise();await engine.start();
  ({pool,query}=await import('../src/server/db'));({execute}=await import('../src/server/service'));({auth}=await import('../src/server/auth'));
  await (await import('../scripts/migrate')).migrate();({handleApi:http}=await import('../src/server/http'));
  moderation=await import('../src/server/moderation');privacy=await import('../src/server/privacy');
  for(const [index,actor] of actors.entries()) {
    const phoneNumber=`+861390900000${index}`;
    await query(`INSERT INTO "user"(id,name,email,"emailVerified","phoneNumber","phoneNumberVerified","createdAt","updatedAt") VALUES($1,$1,$2,true,$3,true,now(),now())`,[actor.userId,`${actor.userId}@example.invalid`,phoneNumber]);
    await query('INSERT INTO profiles(user_id,handle,role) VALUES($1,$1,$2)',[actor.userId,actor===admin?'admin':'member']);
    await success(await authRequest('/phone-number/send-otp',{phoneNumber}));
    const [otp]=await query('SELECT count FROM usage_counters WHERE key=$1',[`dev-otp:${phoneNumber}`]);
    const response=await authRequest('/phone-number/verify',{phoneNumber,code:String(otp.count).padStart(6,'0')});await success(response.clone());
    cookies.set(actor.userId!,response.headers.getSetCookie().map(value=>value.split(';')[0]).join('; '));
  }
  agentToken=(await execute('grants_create',{name:'头像权限测试',scopes:['content:read','posts:write'],days:1},author)).token;
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
  const form=new FormData();form.set('file',new File([new Uint8Array(bytes)],'avatar.png',{type:'image/png'}));
  return success(await http(new Request(`${base}/api/v1/media`,{method:'POST',headers:{Origin:base,Cookie:cookies.get(actor.userId!)!},body:form})));
}
function profile(extra:Record<string,unknown>={}){return {name:'头像测试成员',bio:'学习交流',city:'杭州',...extra};}
async function approve(id:string){return moderation.moderationDecide(admin,{id,decision:'approve',reason:'人工核对资料和原图通过'});}
async function caseFor(targetId:string,type='post'){return (await query('SELECT * FROM moderation_cases WHERE target_type=$1 AND target_id=$2',[type,targetId]))[0];}
async function publicImage(id:string,expected=200){const response=await request(`media/${id}`);assert.equal(response.status,expected);return response;}
function cloudAnswer(action:string|null) {
  return Response.json({Code:200,Data:action==='DescribeUploadToken'?{AccessKeyId:'temporary-test-id',AccessKeySecret:'temporary-test-secret',SecurityToken:'temporary-test-token',BucketName:'moderation-test-bucket',FileNamePrefix:'avatars/',OssInternetEndPoint:'https://oss-cn-shanghai.aliyuncs.com',Expiration:Math.floor(Date.now()/1000)+3600}:{RiskLevel:'none',Result:[{Label:'nonLabel'}]}});
}
async function delayedApproval(id:string,change:()=>Promise<unknown>) {
  const originalFetch=globalThis.fetch,keys=['CONTENT_MODERATION_PROVIDER','CONTENT_MODERATION_ACCESS_KEY_ID','CONTENT_MODERATION_ACCESS_KEY_SECRET'] as const;
  const saved=keys.map(key=>process.env[key]);let reached!:()=>void,release!:()=>void,first=true;
  const started=new Promise<void>(resolve=>{reached=resolve;}),held=new Promise<void>(resolve=>{release=resolve;});
  Object.assign(process.env,{CONTENT_MODERATION_PROVIDER:'aliyun',CONTENT_MODERATION_ACCESS_KEY_ID:randomUUID(),CONTENT_MODERATION_ACCESS_KEY_SECRET:'avatar-race-secret'});
  globalThis.fetch=async(_url,init)=>{
    if(first){first=false;reached();await held;}
    return init?.method==='PUT'?new Response('',{status:200}):cloudAnswer(new URLSearchParams(String(init?.body)).get('Action'));
  };
  const running=moderation.processModeration(id);
  try {await started;await change();} finally {release();await running;globalThis.fetch=originalFetch;keys.forEach((key,index)=>{if(saved[index]===undefined)delete process.env[key];else process.env[key]=saved[index];});}
}
async function migratedDatabase(name:string,legacy=false) {
  await engine.createDatabase(name);const target=new pg.Pool({connectionString:`postgresql://postgres:test-password@127.0.0.1:54339/${name}`});
  const {getMigrations}=await import('better-auth/db/migration');await (await getMigrations({...auth.options,database:target})).runMigrations();
  await target.query('CREATE TABLE schema_migrations(name text PRIMARY KEY,applied_at timestamptz DEFAULT now())');
  for(const file of (await readdir('migrations')).filter(name=>name.endsWith('.sql')&&(!legacy||name<'010')).sort()) {
    await target.query(await readFile(path.join('migrations',file),'utf8'));await target.query('INSERT INTO schema_migrations(name) VALUES($1)',[file]);
  }
  return target;
}

test('the normal migration runner is repeatable and old workers cannot approve unapplied avatar drafts',async()=>{
  await (await import('../scripts/migrate')).migrate();
  assert.equal((await query("SELECT count(*)::int AS n FROM schema_migrations WHERE name='010_profile_avatars.sql'"))[0].n,1);
  const image=await upload(other),draft=await execute('profile_update',profile({avatarMediaId:image.id}),other);
  await assert.rejects(query("UPDATE content_drafts SET status='approved' WHERE id=$1",[draft.draftId]),(error:any)=>error.constraint==='moderation_profile_avatar_applied');
  assert.equal((await query('SELECT status FROM content_drafts WHERE id=$1',[draft.draftId]))[0].status,'pending');
  await approve(draft.moderationId);
  const removal=await execute('profile_update',profile({avatarMediaId:null}),other);
  await assert.rejects(query("UPDATE content_drafts SET status='approved' WHERE id=$1",[removal.draftId]),(error:any)=>error.constraint==='moderation_profile_avatar_applied');
  await approve(removal.moderationId);
});

test('uploaded avatars stay private until profile text and original image complete automatic moderation',async()=>{
  const image=await upload();currentId=image.id;
  const draft=await success(await request('profile',author,'PUT',profile({avatarMediaId:image.id})));currentDraft=draft.moderationId;
  assert.equal((await success(await request('me',author))).user.image,null);
  assert.equal((await execute('profile_get',{id:author.userId},{})).image,null);
  await denied(await request(`media/${image.id}`));await denied(await request(`media/${image.id}`,other));
  await denied(await request(`media/${image.id}`,undefined,'GET',undefined,{Authorization:`Bearer ${agentToken}`}));
  assert.equal((await request(`media/${image.id}`,author)).status,200);
  assert.equal((await request(`moderation/media/${image.id}`,admin)).status,200);
  await denied(await request(`moderation/media/${image.id}`,other));
  const pending=(await moderation.moderationList(author,{mine:true})).items.find(item=>item.id===draft.moderationId)!;
  assert.deepEqual(pending.images,[image.id]);assert.equal(pending.draftKind,'profile');
  const originalFetch=globalThis.fetch;const variables=['CONTENT_MODERATION_PROVIDER','CONTENT_MODERATION_ACCESS_KEY_ID','CONTENT_MODERATION_ACCESS_KEY_SECRET'] as const;
  const saved=variables.map(key=>process.env[key]);let scannedImages=0,scannedText=0;
  try {
    Object.assign(process.env,{CONTENT_MODERATION_PROVIDER:'aliyun',CONTENT_MODERATION_ACCESS_KEY_ID:'avatar-test-key',CONTENT_MODERATION_ACCESS_KEY_SECRET:'avatar-test-secret'});
    globalThis.fetch=async(_url,init)=>{
      if(init?.method==='PUT')return new Response('',{status:200});
      const form=new URLSearchParams(String(init?.body)),action=form.get('Action');
      if(action==='DescribeUploadToken')return Response.json({Code:200,Data:{AccessKeyId:'temporary-test-id',AccessKeySecret:'temporary-test-secret',SecurityToken:'temporary-test-token',BucketName:'moderation-test-bucket',FileNamePrefix:'avatars/',OssInternetEndPoint:'https://oss-cn-shanghai.aliyuncs.com',Expiration:Math.floor(Date.now()/1000)+3600}});
      if(action==='TextModerationPlus')scannedText++;
      if(action==='ImageModeration')scannedImages++;
      return Response.json({Code:200,Data:{RiskLevel:'none',Result:[{Label:'nonLabel'}]}});
    };
    await moderation.processModeration(draft.moderationId);
  } finally {globalThis.fetch=originalFetch;variables.forEach((key,index)=>{if(saved[index]===undefined)delete process.env[key];else process.env[key]=saved[index];});}
  assert.equal(scannedImages,1);assert.ok(scannedText>0);
  assert.equal((await success(await request('me',author))).user.image,image.url);
  assert.equal((await execute('profile_get',{id:author.userId},{})).image,image.url);
  const response=await publicImage(image.id);assert.match(response.headers.get('cache-control')||'',/no-store/);
  assert.equal((await request(`media/${image.id}`,undefined,'GET',undefined,{Authorization:`Bearer ${agentToken}`})).status,200);
});

test('a pending replacement or omitted avatar keeps the current avatar public, and removal waits for approval',async()=>{
  const replacement=await upload();const first=await execute('profile_update',profile({avatarMediaId:replacement.id}),author);
  await moderation.processModeration(first.moderationId);assert.equal((await caseFor(first.draftId,'draft')).status,'review');
  assert.equal((await execute('profile_get',{id:author.userId},{})).image,`/api/v1/media/${currentId}`);await publicImage(currentId);await denied(await request(`media/${replacement.id}`));
  const keep=await execute('profile_update',profile({bio:'只修改文字'}),author);
  const [saved]=await query('SELECT payload FROM content_drafts WHERE id=$1',[keep.draftId]);assert.equal(saved.payload.avatarMediaId,currentId);
  await assert.rejects(approve(first.moderationId));await approve(keep.moderationId);currentDraft=keep.moderationId;await publicImage(currentId);
  const removal=await execute('profile_update',profile({avatarMediaId:null}),author);await publicImage(currentId);await approve(removal.moderationId);
  assert.equal((await execute('profile_get',{id:author.userId},{})).image,null);await denied(await request(`media/${currentId}`));
  const next=await execute('profile_update',profile({avatarMediaId:replacement.id}),author);await approve(next.moderationId);currentId=replacement.id;currentDraft=next.moderationId;await publicImage(currentId);
});

test('avatar claims reject foreign and attached media and cannot race with post attachment',async()=>{
  const foreign=await upload(other);await assert.rejects(execute('profile_update',profile({avatarMediaId:foreign.id}),author));
  await assert.rejects(execute('profile_update',profile({avatarMediaId:'missing-avatar'}),author));
  const attached=await upload();await execute('posts_create',{body:'已用于动态的图片',mediaIds:[attached.id]},author);
  await assert.rejects(execute('profile_update',profile({avatarMediaId:attached.id}),author));
  await assert.rejects(execute('posts_create',{body:'不得复用头像',mediaIds:[currentId]},author));
  await assert.rejects(query('UPDATE media SET post_id=$2 WHERE id=$1',[currentId,(await query('SELECT post_id FROM media WHERE id=$1',[attached.id]))[0].post_id]));
  const racing=await upload();
  const outcomes=await Promise.allSettled([execute('profile_update',profile({avatarMediaId:racing.id}),author),execute('posts_create',{body:'头像附件竞争',mediaIds:[racing.id]},author)]);
  assert.equal(outcomes.filter(result=>result.status==='fulfilled').length,1);
  const [claimed]=await query('SELECT usage_kind,post_id FROM media WHERE id=$1',[racing.id]);assert.equal(claimed.usage_kind==='avatar',claimed.post_id===null);
  await denied(await authRequest('/update-user',{image:foreign.url},author));
  await denied(await request('profile',undefined,'PUT',profile({avatarMediaId:foreign.id}),{Authorization:`Bearer ${agentToken}`}));
});

test('profile, post, comment, community and admin user responses consistently expose the approved image',async()=>{
  const post=await execute('posts_create',{body:'头像一致性动态'},author);await approve((await caseFor(post.id)).id);
  const comment=await execute('comments_create',{id:post.id,body:'头像一致性评论'},author);await approve(comment.moderationId);
  const view=await execute('posts_get',{id:post.id},{});assert.equal(view.author.image,`/api/v1/media/${currentId}`);assert.equal(view.comments[0].image,view.author.image);
  const group=await execute('communities_create',{name:'头像显示社群',description:'测试成员头像',city:'杭州',visibility:'public'},admin);await approve(group.moderationId);
  await execute('communities_join',{id:group.id},author);
  assert.equal((await execute('communities_members',{id:group.id},author)).items.find((item:any)=>item.id===author.userId).image,view.author.image);
  assert.equal((await execute('admin_overview',{},admin)).users.find((item:any)=>item.id===author.userId).image,view.author.image);
});

test('personal moderation APIs omit internal diagnostics while admin actions preserve them',async()=>{
  const draft=await execute('profile_update',profile(),author);const marker='INTERNAL-DIAGNOSTIC-ONLY';
  await query("UPDATE moderation_cases SET status='review',provider=$2,reason=$2,labels=ARRAY[$2],reviewed_by=$3 WHERE id=$1",[draft.moderationId,marker,admin.userId]);
  await query("INSERT INTO moderation_history(id,case_id,actor_id,action,status,reason) VALUES($1,$2,$3,'automatic','review',$4)",[randomUUID(),draft.moderationId,admin.userId,marker]);
  for(const result of [await success(await request('moderation?mine=true',author)),await success(await request('actions/moderation_list',author,'POST',{mine:true})),await moderation.moderationList(author,{mine:true})]) {
    assert.equal(JSON.stringify(result).includes(marker),false);assert.equal('provider' in result,false);
    const item=result.items.find((entry:any)=>entry.id===draft.moderationId);assert.ok(item.userReason);assert.equal(item.status,'review');
    for(const field of ['labels','reason','provider','revision','reviewedBy','history'])assert.equal(field in item,false,field);
  }
  assert.ok(JSON.stringify(await success(await request('moderation?mine=false',admin))).includes(marker));
  const exported=await success(await request('privacy/export',author));assert.equal(JSON.stringify(exported).includes(marker),false);
  const exportedCase=exported.moderation.find((item:any)=>item.id===draft.moderationId);assert.equal(exportedCase.status,'review');assert.ok(exportedCase.userReason);
  for(const field of ['labels','reason','provider'])assert.equal(field in exportedCase,false);
  await denied(await request('moderation?mine=false',author));
  await denied(await request('moderation?mine=true',undefined,'GET',undefined,{Authorization:`Bearer ${agentToken}`}));
});

test('superseded drafts, deleted old approvals, profile clearing and closure cannot restore an avatar',async()=>{
  const newer=await upload(),draft=await execute('profile_update',profile({avatarMediaId:newer.id}),author);await approve(draft.moderationId);
  await moderation.moderationDecide(admin,{id:currentDraft,decision:'delete',reason:'清理旧版本不得影响新版本'});await publicImage(newer.id);
  const stale=await execute('profile_update',profile({avatarMediaId:currentId}),author);
  await delayedApproval(stale.moderationId,async()=>success(await request('privacy/clear-profile',author,'POST',{})));
  await assert.rejects(approve(stale.moderationId));
  assert.equal((await success(await request('me',author))).user.image,null);await denied(await request(`media/${newer.id}`));await denied(await request(`media/${currentId}`));
  const closingImage=await upload(),closingDraft=await execute('profile_update',profile({avatarMediaId:closingImage.id}),author);await approve(closingDraft.moderationId);
  const afterClose=await execute('profile_update',profile({avatarMediaId:currentId}),author);
  await delayedApproval(afterClose.moderationId,()=>privacy.closeAccount(author));await assert.rejects(approve(afterClose.moderationId));
  await denied(await request(`media/${closingImage.id}`));await denied(await request(`moderation/media/${closingImage.id}`,admin));
  assert.equal((await query('SELECT avatar_media_id FROM profiles WHERE user_id=$1',[author.userId]))[0].avatar_media_id,null);
});

test('portable backup restores approved avatar references and private pending avatar drafts',async()=>{
  const published=await upload(other),approved=await execute('profile_update',profile({avatarMediaId:published.id}),other);await approve(approved.moderationId);
  const pending=await upload(other),draft=await execute('profile_update',profile({avatarMediaId:pending.id}),other);
  const {createBackup,restoreBackup}=await import('../src/server/backup');const backup=path.join(root,'backup');await createBackup(backup,pool);
  const target=await migratedDatabase('avatar_restored');
  try {
    await restoreBackup(backup,target,async()=>{});
    const restored=(await target.query('SELECT p.avatar_media_id,u.image FROM profiles p JOIN "user" u ON u.id=p.user_id WHERE p.user_id=$1',[other.userId])).rows[0];
    assert.equal(restored.avatar_media_id,published.id);assert.equal(restored.image,published.url);
    const restoredDraft=(await target.query('SELECT payload,status FROM content_drafts WHERE id=$1',[draft.draftId])).rows[0];
    assert.equal(restoredDraft.payload.avatarMediaId,pending.id);assert.equal(restoredDraft.status,'pending');
    assert.equal((await target.query('SELECT usage_kind,post_id FROM media WHERE id=$1',[pending.id])).rows[0].usage_kind,'avatar');
  } finally {await target.end();}
});

test('a backup from the previous schema restores with safe default avatar columns',async()=>{
  const image=await upload(other),[media]=await query('SELECT * FROM media WHERE id=$1',[image.id]);
  const source=await migratedDatabase('avatar_legacy_source',true),target=await migratedDatabase('avatar_legacy_restored');
  try {
    await source.query(`INSERT INTO "user"(id,name,email,"emailVerified","createdAt","updatedAt") VALUES('legacy-avatar-user','旧版本成员','legacy-avatar@example.invalid',true,now(),now())`);
    await source.query("INSERT INTO profiles(user_id,handle) VALUES('legacy-avatar-user','legacy-avatar-user')");
    await source.query("INSERT INTO media(id,owner_id,storage_key,mime,bytes,original_name) VALUES($1,'legacy-avatar-user',$2,$3,$4,'legacy.png')",[media.id,media.storage_key,media.mime,media.bytes]);
    const {createBackup,restoreBackup}=await import('../src/server/backup');const backup=path.join(root,'legacy-backup');await createBackup(backup,source);await restoreBackup(backup,target,async()=>{});
    assert.equal((await target.query("SELECT avatar_media_id FROM profiles WHERE user_id='legacy-avatar-user'")).rows[0].avatar_media_id,null);
    assert.equal((await target.query('SELECT usage_kind FROM media WHERE id=$1',[media.id])).rows[0].usage_kind,'post');
    assert.equal((await target.query("SELECT count(*)::int AS n FROM schema_migrations WHERE name='010_profile_avatars.sql'")).rows[0].n,1);
  } finally {await source.end();await target.end();}
});
