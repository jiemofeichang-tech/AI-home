import { before,after,test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdir,mkdtemp,readFile,readdir } from 'node:fs/promises';
import path from 'node:path';
import EmbeddedPostgres from 'embedded-postgres';
import pg from 'pg';
import sharp from 'sharp';
import type { Actor } from '../src/shared/contracts';
import { PRIVACY_VERSION } from '../src/shared/privacy';
import { approvedFixtures } from './moderation-fixtures';

const base='http://localhost:3197',privacyVersion=PRIVACY_VERSION;
const admin:Actor={userId:'privacy-admin'},member:Actor={userId:'privacy-member'},other:Actor={userId:'privacy-other'},closing:Actor={userId:'privacy-closing'};
const phones=new Map([[admin.userId!,'+8613902000000'],[member.userId!,'+8613902000001'],[other.userId!,'+8613902000002'],[closing.userId!,'+8613902000003']]);
let engine:EmbeddedPostgres,pool:pg.Pool,query:any,execute:any,http:any,auth:any,actorFromRequest:any,groupId:string;
let memberGrant:any,adminGrant:any,memberAgent:Actor,exportOwnData:any,closeAccount:any,expireEventContactData:any,processJob:any,approveFixture:any;
let eventSequence=0;

before(async()=>{
  await mkdir('.local',{recursive:true});const root=await mkdtemp(path.resolve('.local','privacy-test-'));
  Object.assign(process.env,{DEV_MODE:'true',INVITE_ONLY:'false',ADMIN_PHONE:'',APP_URL:base,DATABASE_URL:'postgresql://postgres:test-password@127.0.0.1:54333/postgres',BETTER_AUTH_SECRET:randomBytes(40).toString('hex'),AUTH_IP_HEADER:'x-forwarded-for',STORAGE_DRIVER:'local',LOCAL_STORAGE_DIR:path.join(root,'uploads'),REDIS_URL:'',MEILI_URL:'',DB_POOL_SIZE:'20',SMS_DAILY_LIMIT:'1000',CONTENT_MODERATION_PROVIDER:'manual'});
  engine=new EmbeddedPostgres({databaseDir:path.join(root,'db'),user:'postgres',password:'test-password',port:54333,persistent:true,initdbFlags:['--encoding=UTF8','--locale=C'],postgresFlags:['-h','127.0.0.1'],onLog:()=>{},onError:()=>{}});
  await engine.initialise();await engine.start();
  ({pool,query}=await import('../src/server/db'));({execute}=await import('../src/server/service'));({auth,actorFromRequest}=await import('../src/server/auth'));
  await (await import('../scripts/migrate')).migrate();({handleApi:http}=await import('../src/server/http'));
  ({execute,approve:approveFixture}=approvedFixtures(execute,query,(await import('../src/server/moderation')).moderationDecide,admin));
  ({exportOwnData,closeAccount,expireEventContactData}=await import('../src/server/privacy'));({processJob}=await import('../src/server/worker'));
  for(const actor of [admin,member,other,closing]) {
    await query(`INSERT INTO "user"(id,name,email,"emailVerified","phoneNumber","phoneNumberVerified","createdAt","updatedAt") VALUES($1,$2,$3,true,$4,true,now(),now())`,[actor.userId,`姓名-${actor.userId}`,`${actor.userId}@example.invalid`,phones.get(actor.userId!)]);
    await query('INSERT INTO profiles(user_id,handle,role) VALUES($1,$1,$2)',[actor.userId,actor===admin?'admin':'member']);
  }
  groupId=(await execute('communities_create',{name:'隐私测试社群',description:'测试专用',city:'杭州',visibility:'public'},admin)).id;
  for(const actor of [member,other,closing])await execute('communities_join',{id:groupId},actor);
  memberGrant=await execute('grants_create',{name:'隐私测试 Agent',scopes:['content:read','posts:write','events:rsvp'],communityIds:[groupId],days:1},member);
  adminGrant=await execute('grants_create',{name:'管理员 Agent',scopes:['content:read','posts:write','events:manage'],communityIds:[groupId],days:1},admin);
  memberAgent=await actorFromRequest(new Request(`${base}/api/v1/posts`,{headers:{Authorization:`Bearer ${memberGrant.token}`}}));
},{timeout:120000});
after(async()=>{if(pool)await pool.end();if(engine)await engine.stop();});

function authRequest(endpoint:string,body?:Record<string,unknown>,version:string|null=privacyVersion,cookie?:string):Promise<Response> {
  const phone=String(body?.phoneNumber||'');const headers={Origin:base,'X-Forwarded-For':`198.51.100.${Number(phone.slice(-3))%254+1}`,...(version?{'X-Privacy-Version':version}:{}),...(body?{'Content-Type':'application/json'}:{}),...(cookie?{Cookie:cookie}:{})};
  return auth.handler(new Request(`${base}/api/auth${endpoint}`,{method:body?'POST':'GET',headers,body:body?JSON.stringify(body):undefined}));
}
async function success(response:Response) {const value=await response.json();assert.equal(response.status,200,JSON.stringify(value));return value;}
async function denied(response:Response) {assert.ok(response.status>=400&&response.status<500,`${response.status}: ${await response.text()}`);}
async function sendOtp(phoneNumber:string) {
  await success(await authRequest('/phone-number/send-otp',{phoneNumber}));
  const [otp]=await query('SELECT count FROM usage_counters WHERE key=$1',[`dev-otp:${phoneNumber}`]);assert.ok(otp);return String(otp.count).padStart(6,'0');
}
async function login(actor:Actor) {
  const phoneNumber=phones.get(actor.userId!)!,code=await sendOtp(phoneNumber);
  const response=await authRequest('/phone-number/verify',{phoneNumber,code});await success(response.clone());
  const cookie=response.headers.getSetCookie().map(value=>value.split(';')[0]).join('; ');assert.ok(cookie);return cookie;
}
function request(endpoint:string,method='GET',body?:unknown,headers:Record<string,string>={}):Promise<Response> {
  return http(new Request(`${base}/api/v1/${endpoint}`,{method,headers:{Origin:base,...(body?{'Content-Type':'application/json'}:{}),...headers},body:body?JSON.stringify(body):undefined}));
}
async function event(actor:Actor=admin) {
  return (await execute('events_create',{communityId:groupId,title:`隐私测试活动${++eventSequence}`,description:'活动说明',city:'杭州',address:'报名后地址',startsAt:new Date(Date.now()+86400000).toISOString(),endsAt:new Date(Date.now()+90000000).toISOString(),capacity:10},actor)).id as string;
}
async function book(id:string,actor:Actor=member,phoneNumber='13888000001') {
  await execute('events_rsvp',{id,attending:true,attendeeName:`联系人-${actor.userId}`,phoneNumber,contactConsent:true},actor);
}
async function upload(bytes:Buffer,token:string,aiConsent?:string) {
  const form=new FormData();form.set('file',new File([new Uint8Array(bytes)],'private-camera.jpg',{type:'image/jpeg'}));if(aiConsent!==undefined)form.set('aiConsent',aiConsent);
  return success(await http(new Request(`${base}/api/v1/media`,{method:'POST',headers:{Authorization:`Bearer ${token}`},body:form})));
}

test('administration and public responses do not expose login phones, OTPs or per-user quota keys',async()=>{
  const day=new Date().toISOString().slice(0,10),month=day.slice(0,7),privatePhone='+8613812345678';
  for(const [key,count] of [[`sms:${day}`,3],[`sms:${day}:${privatePhone}`,9],[`ai-image:${month}`,2],[`dev-otp:${privatePhone}`,654321],['private-counter:USER-SECRET',4]] as const)await query('INSERT INTO usage_counters(key,count) VALUES($1,$2)',[key,count]);
  const overview=await execute('admin_overview',{},admin),serialized=JSON.stringify(overview);
  for(const secret of [privatePhone,'654321','USER-SECRET','dev-otp'])assert.equal(serialized.includes(secret),false,secret);
  assert.ok(overview.usage.some((item:any)=>item.key===`sms:${day}`&&Number(item.count)===3));
  assert.ok(overview.usage.some((item:any)=>item.key===`ai-image:${month}`&&Number(item.count)===2));
  assert.ok(overview.usage.every((item:any)=>/^(sms:\d{4}-\d{2}-\d{2}|ai-image:\d{4}-\d{2})$/.test(item.key)));
  for(const actor of [{},member,memberAgent] as Actor[])await assert.rejects(execute('admin_overview',{},actor));
  for(const endpoint of [`profiles/${member.userId}`,'me','communities','events']) {
    const body=JSON.stringify(await success(await request(endpoint,'GET',undefined,{Authorization:`Bearer ${memberGrant.token}`})));
    for(const phone of phones.values())assert.equal(body.includes(phone),false);
    assert.equal(/phoneNumber|phone_number|emailVerified|token_hash/.test(body),false);
  }
});

test('privacy acknowledgement is required separately for OTP sending and verification',async()=>{
  const phoneNumber='+8613902000010';
  const usageBefore=await query("SELECT key,count FROM usage_counters WHERE key LIKE 'sms:%' ORDER BY key");
  for(const version of [null,'outdated-policy'])await denied(await authRequest('/phone-number/send-otp',{phoneNumber},version));
  assert.deepEqual(await query("SELECT key,count FROM usage_counters WHERE key LIKE 'sms:%' ORDER BY key"),usageBefore);
  assert.equal((await query('SELECT 1 FROM "user" WHERE "phoneNumber"=$1',[phoneNumber])).length,0);
  const code=await sendOtp(phoneNumber);
  for(const version of [null,'outdated-policy'])await denied(await authRequest('/phone-number/verify',{phoneNumber,code},version));
  const registered=await success(await authRequest('/phone-number/verify',{phoneNumber,code}));
  const [profile]=await query('SELECT privacy_version,privacy_accepted_at FROM profiles WHERE user_id=$1',[registered.user.id]);
  assert.equal(profile.privacy_version,privacyVersion);assert.ok(profile.privacy_accepted_at);
});

test('registration consent is recorded and expired or cancelled activity contacts are cleared without removing places',async()=>{
  const future=await event(),recent=await event(),expired=await event(),cancelled=await event();
  for(const contactConsent of [undefined,false])await assert.rejects(execute('events_rsvp',{id:future,attending:true,attendeeName:'待同意姓名',phoneNumber:'13888000001',contactConsent},member),(error:any)=>error.status===400);
  assert.equal((await query('SELECT 1 FROM registrations WHERE event_id=$1',[future])).length,0);
  for(const id of [future,recent,expired,cancelled])await book(id);
  const [consent]=await query('SELECT contact_consent_version,contact_consented_at FROM registrations WHERE event_id=$1',[future]);assert.equal(consent.contact_consent_version,privacyVersion);assert.ok(consent.contact_consented_at);
  await query("UPDATE events SET starts_at=now()-interval '30 days',ends_at=now()-interval '29 days' WHERE id=$1",[recent]);
  await query("UPDATE events SET starts_at=now()-interval '32 days',ends_at=now()-interval '31 days' WHERE id=$1",[expired]);
  await query('UPDATE events SET cancelled=true WHERE id=$1',[cancelled]);
  await query('UPDATE registrations SET checked_in_at=now() WHERE event_id=$1',[expired]);
  assert.equal(await expireEventContactData(),2);
  for(const id of [expired,cancelled]) {
    const [row]=await query('SELECT attendee_name,phone_number,contact_consent_version,contact_consented_at,checked_in_at FROM registrations WHERE event_id=$1',[id]);assert.ok(row);
    assert.equal(row.attendee_name,null);assert.equal(row.phone_number,null);assert.equal(row.contact_consent_version,null);assert.equal(row.contact_consented_at,null);if(id===expired)assert.ok(row.checked_in_at);
  }
  for(const id of [future,recent])assert.equal((await query('SELECT phone_number FROM registrations WHERE event_id=$1',[id]))[0].phone_number,'+8613888000001');
  assert.equal(await expireEventContactData(),0,'Retention cleanup is idempotent');
});

test('images lose hidden metadata and AI extraction runs only after explicit publication consent',async()=>{
  const bytes=await sharp({create:{width:8,height:8,channels:3,background:'#336699'}}).jpeg().withExif({IFD0:{Artist:'PRIVATE-IMAGE-OWNER',ImageDescription:'PRIVATE-CAMERA-METADATA'}}).toBuffer();
  assert.ok((await sharp(bytes).metadata()).exif,'Fixture must contain EXIF metadata');
  const unconsented=await upload(bytes,memberGrant.token);
  const cookie=await login(member);const response=await request(`moderation/media/${unconsented.id}`,'GET',undefined,{Cookie:cookie});assert.equal(response.status,200);
  const cleaned=Buffer.from(await response.arrayBuffer()),metadata=await sharp(cleaned).metadata();assert.equal(metadata.width,8);assert.equal(metadata.height,8);assert.equal(metadata.exif,undefined);assert.equal(metadata.xmp,undefined);assert.equal(metadata.iptc,undefined);assert.equal(cleaned.includes(Buffer.from('PRIVATE-IMAGE-OWNER')),false);
  const [stored]=await query('SELECT ai_consent FROM media WHERE id=$1',[unconsented.id]);assert.equal(stored.ai_consent,false);
  await execute('posts_create',{body:'未同意 AI 分析的图片',mediaIds:[unconsented.id]},member);
  assert.equal((await query("SELECT 1 FROM jobs WHERE kind='image' AND target_id=$1",[unconsented.id])).length,0);
  await query("INSERT INTO jobs(id,kind,target_id) VALUES('privacy-stale-image-job','image',$1)",[unconsented.id]);
  const originalFetch=globalThis.fetch,previousKey=process.env.DASHSCOPE_API_KEY;let calls=0;
  try {
    process.env.DASHSCOPE_API_KEY='privacy-test-model-key';
    globalThis.fetch=async()=>{calls++;return Response.json({choices:[{message:{content:JSON.stringify({text:'CONSENTED-OCR',description:'测试图片'})}}]});};
    await processJob('privacy-stale-image-job');assert.equal(calls,0,'Even an old queued job must not send an unconsented image to AI');
    const consented=await upload(bytes,memberGrant.token,'true');assert.equal((await query('SELECT ai_consent FROM media WHERE id=$1',[consented.id]))[0].ai_consent,true);
    await (await import('../src/server/service')).execute('posts_create',{body:'已明确同意 AI 分析的图片',mediaIds:[consented.id],imageAnalysisConsent:true},member);
    const [job]=await query("SELECT id FROM jobs WHERE kind='image' AND target_id=$1",[consented.id]);assert.ok(job);
    await processJob(job.id);assert.equal(calls,1);assert.equal((await query('SELECT extracted_text FROM media WHERE id=$1',[consented.id]))[0].extracted_text,'CONSENTED-OCR');
    await approveFixture({id:(await query('SELECT post_id FROM media WHERE id=$1',[consented.id]))[0].post_id});
    const reconsidered=await upload(bytes,memberGrant.token,'true');
    await execute('posts_create',{body:'发布前撤回 AI 同意',mediaIds:[reconsidered.id],imageAnalysisConsent:false},member);
    assert.equal((await query('SELECT ai_consent FROM media WHERE id=$1',[reconsidered.id]))[0].ai_consent,false);
    assert.equal((await query("SELECT 1 FROM jobs WHERE kind='image' AND target_id=$1",[reconsidered.id])).length,0);
    assert.equal(calls,1);
  } finally {
    globalThis.fetch=originalFetch;if(previousKey===undefined)delete process.env.DASHSCOPE_API_KEY;else process.env.DASHSCOPE_API_KEY=previousKey;
  }
});

test('only the signed-in person can export their data and clear their own activity contact details',async()=>{
  const cookie=await login(member),id=await event();await book(id);await book(id,other,'13888000002');
  const ownPost=await execute('posts_create',{body:'EXPORT-OWN-BODY'},member);await execute('posts_create',{body:'EXPORT-OTHER-BODY'},other);
  const exported=await exportOwnData(member),text=JSON.stringify(exported);
  assert.equal(exported.formatVersion,1);assert.ok(text.includes('EXPORT-OWN-BODY'));assert.ok(text.includes(phones.get(member.userId!)!));assert.ok(text.includes('+8613888000001'));
  for(const secret of ['EXPORT-OTHER-BODY','+8613888000002',phones.get(other.userId!)!,memberGrant.token,'token_hash','code_hash','ipAddress','userAgent'])assert.equal(text.includes(secret),false,secret);
  assert.ok(exported.posts.some((post:any)=>post.id===ownPost.id));
  for(const actor of [{},memberAgent] as Actor[])await assert.rejects(exportOwnData(actor));
  for(const headers of [{},{Authorization:`Bearer ${memberGrant.token}`},{Authorization:`Bearer ${adminGrant.token}`}] as Record<string,string>[])await denied(await request('privacy/export','GET',undefined,headers));
  const download=await request(`privacy/export?userId=${other.userId}`,'GET',undefined,{Cookie:cookie});assert.equal(download.status,200);assert.match(download.headers.get('Content-Disposition')||'',/attachment/);assert.match(download.headers.get('Cache-Control')||'',/no-store/);
  assert.equal((await download.text()).includes('EXPORT-OTHER-BODY'),false);
  const account=JSON.stringify(await success(await request('privacy/account','GET',undefined,{Cookie:cookie})));assert.equal(account.includes(phones.get(member.userId!)!),false);assert.ok(account.includes('+8613888000001'));assert.equal(account.includes('+8613888000002'),false);
  await execute('communities_leave',{id:groupId},member);
  await success(await request('privacy/contacts','DELETE',{eventId:id},{Cookie:cookie}));
  const rows=await query('SELECT user_id,phone_number FROM registrations WHERE event_id=$1',[id]);assert.equal(rows.length,2);assert.equal(rows.find((row:any)=>row.user_id===member.userId).phone_number,null);assert.equal(rows.find((row:any)=>row.user_id===other.userId).phone_number,'+8613888000002');
  await success(await request('privacy/contacts','DELETE',{}, {Cookie:cookie}));assert.equal((await query('SELECT 1 FROM registrations WHERE user_id=$1 AND phone_number IS NOT NULL',[member.userId])).length,0);
  await execute('communities_join',{id:groupId},member);
});

test('profile clearing and AI consent withdrawal are personal actions and login JWTs contain no contact details',async()=>{
  const cookie=await login(member);
  const token=await success(await authRequest('/token',undefined,privacyVersion,cookie));
  const payload=JSON.parse(Buffer.from(token.token.split('.')[1],'base64url').toString());
  assert.equal(payload.sub,member.userId);
  for(const key of ['phoneNumber','phoneNumberVerified','email','emailVerified','name','image'])assert.equal(key in payload,false,key);
  await query("UPDATE profiles SET bio='PRIVATE-BIO',city='PRIVATE-CITY' WHERE user_id=$1",[member.userId]);
  await query('UPDATE "user" SET image=$2 WHERE id=$1',[member.userId,'https://example.invalid/private-avatar.jpg']);
  for(const endpoint of ['privacy/clear-profile','privacy/withdraw-image-ai'])for(const headers of [{},{Authorization:`Bearer ${memberGrant.token}`}] as Record<string,string>[])await denied(await request(endpoint,'POST',{},headers));
  await success(await request('privacy/clear-profile','POST',{}, {Cookie:cookie}));
  const [profile]=await query('SELECT p.bio,p.city,u.name,u.image,u."phoneNumber" FROM profiles p JOIN "user" u ON u.id=p.user_id WHERE p.user_id=$1',[member.userId]);
  assert.equal(profile.bio,'');assert.equal(profile.city,'');assert.equal(profile.image,null);assert.notEqual(profile.name,`姓名-${member.userId}`);assert.ok(profile.name);assert.equal(profile.phoneNumber,phones.get(member.userId!));
  const before=await query('SELECT id FROM media WHERE owner_id=$1 AND ai_consent=true',[member.userId]);assert.ok(before.length);
  const image=await upload(await sharp({create:{width:2,height:2,channels:3,background:'#123456'}}).jpeg().toBuffer(),memberGrant.token);
  await (await import('../src/server/service')).execute('posts_create',{body:'撤回同意前已经开始的图片任务',mediaIds:[image.id],imageAnalysisConsent:true},member);
  const [job]=await query("SELECT id FROM jobs WHERE kind='image' AND target_id=$1",[image.id]);assert.ok(job);
  const originalFetch=globalThis.fetch,previousKey=process.env.DASHSCOPE_API_KEY;
  let reachedProvider!:()=>void,releaseProvider!:(response:Response)=>void;
  const reached=new Promise<void>(resolve=>{reachedProvider=resolve;}),response=new Promise<Response>(resolve=>{releaseProvider=resolve;});
  let running:Promise<void>|undefined;
  try {
    process.env.DASHSCOPE_API_KEY='privacy-delayed-model-key';
    globalThis.fetch=async()=>{reachedProvider();return response;};
    const task:Promise<void>=processJob(job.id);running=task;await Promise.race([reached,task.then(()=>{throw new Error('Consented image job did not reach the provider');})]);
    await success(await request('privacy/withdraw-image-ai','POST',{}, {Cookie:cookie}));
    releaseProvider(Response.json({choices:[{message:{content:JSON.stringify({text:'LATE-WITHDRAWN-OCR',description:'LATE-WITHDRAWN-DESCRIPTION'})}}]}));
    await running;
  } finally {
    try {releaseProvider(Response.json({choices:[]}));await running;}
    finally {globalThis.fetch=originalFetch;if(previousKey===undefined)delete process.env.DASHSCOPE_API_KEY;else process.env.DASHSCOPE_API_KEY=previousKey;}
  }
  const rows=await query('SELECT ai_consent,extracted_text,description FROM media WHERE owner_id=$1',[member.userId]);
  assert.ok(rows.length);for(const row of rows){assert.equal(row.ai_consent,false);assert.equal(row.extracted_text,'');assert.equal(row.description,'');}
  assert.equal((await query("SELECT 1 FROM jobs j JOIN media m ON m.id=j.target_id WHERE m.owner_id=$1 AND j.kind='image'",[member.userId])).length,0);
  assert.equal((await success(await request('me','GET',undefined,{Cookie:cookie}))).user.id,member.userId);
});

test('account closure requires recent human confirmation and scrubs data, revokes access and durably deletes images',async()=>{
  const cookie=await login(closing),grant=await execute('grants_create',{name:'closing-agent',scopes:['content:read','posts:write'],communityIds:[groupId],days:1},closing);
  const staleAgent=await actorFromRequest(new Request(`${base}/api/v1/posts`,{headers:{Authorization:`Bearer ${grant.token}`}}));
  for(const actor of [{},staleAgent] as Actor[])await assert.rejects(closeAccount(actor));
  for(const headers of [{},{Authorization:`Bearer ${grant.token}`}] as Record<string,string>[])await denied(await request('privacy/close','POST',{confirmation:'注销我的账号'},headers));
  await denied(await request('privacy/close','POST',{confirmation:'删除'}, {Cookie:cookie}));
  await query('UPDATE "session" SET "createdAt"=now()-interval \'11 minutes\' WHERE "userId"=$1',[closing.userId]);
  const staleResponse=await request('privacy/close','POST',{confirmation:'注销我的账号'}, {Cookie:cookie});assert.equal(staleResponse.status,403);assert.equal((await staleResponse.json()).code,'FRESH_LOGIN_REQUIRED');
  await query('UPDATE "session" SET "createdAt"=now() WHERE "userId"=$1',[closing.userId]);
  const bytes=await sharp({create:{width:2,height:2,channels:3,background:'#112233'}}).jpeg().toBuffer(),media=await upload(bytes,grant.token);
  const post=await execute('posts_create',{body:'CLOSED-PRIVATE-BODY',tags:['CLOSED-PRIVATE-TAG'],mediaIds:[media.id],idempotencyKey:'closed-post-key'},closing);
  await execute('comments_create',{id:post.id,body:'CLOSED-PRIVATE-COMMENT'},closing);
  const ownRegistration=await event();await book(ownRegistration,closing,'13888000003');
  await query("UPDATE memberships SET role='admin' WHERE community_id=$1 AND user_id=$2",[groupId,closing.userId]);
  const hosted=await event(closing);await book(hosted,other,'13888000004');
  await query('UPDATE registrations SET checked_in_at=now() WHERE event_id=$1',[hosted]);
  const [originalMedia]=await query('SELECT storage_key FROM media WHERE id=$1',[media.id]);
  const storage=await import('../src/server/storage');assert.ok((await storage.getObject(originalMedia.storage_key)).length);
  const closed=await success(await request('privacy/close','POST',{confirmation:'注销我的账号'}, {Cookie:cookie}));assert.equal(closed.closed,true);assert.equal(closed.retainedPlaceholder,true);assert.equal(closed.pendingObjectDeletions,1);
  const [record]=await query('SELECT p.*,u.name,u.email,u.image,u."phoneNumber" FROM profiles p JOIN "user" u ON u.id=p.user_id WHERE p.user_id=$1',[closing.userId]);
  assert.ok(record.deleted_at);assert.equal(record.banned,true);assert.equal(record.role,'member');assert.equal(record.phoneNumber,null);assert.equal(record.image,null);assert.equal(record.bio,'');assert.equal(record.city,'');assert.equal(record.name,'已注销账户');assert.match(record.email,/@deleted\.invalid$/);assert.equal(record.privacy_version,null);
  const [scrubbed]=await query('SELECT body,tags,deleted_at FROM posts WHERE id=$1',[post.id]);assert.equal(scrubbed.body,'');assert.deepEqual(scrubbed.tags,[]);assert.ok(scrubbed.deleted_at);
  const [comment]=await query('SELECT body,deleted_at FROM comments WHERE post_id=$1',[post.id]);assert.equal(comment.body,'');assert.ok(comment.deleted_at);
  for(const [table,column] of [['media','owner_id'],['registrations','user_id'],['memberships','user_id'],['agent_grants','user_id'],['request_keys','user_id'],['audit_logs','user_id'],['session','userId'],['account','userId']] as const)assert.equal((await query(`SELECT 1 FROM "${table}" WHERE "${column}"=$1`,[closing.userId])).length,0,table);
  assert.equal((await query('SELECT 1 FROM usage_counters WHERE key=$1',[`dev-otp:${phones.get(closing.userId!)}`])).length,0);
  const [activity]=await query('SELECT title,description,address,cancelled FROM events WHERE id=$1',[hosted]);assert.equal(activity.cancelled,true);assert.equal(activity.description,'');assert.equal(activity.address,'');assert.equal(activity.title,'已取消活动');
  const [remaining]=await query('SELECT user_id,phone_number,attendee_name,checked_in_at FROM registrations WHERE event_id=$1',[hosted]);assert.equal(remaining.user_id,other.userId);assert.equal(remaining.phone_number,null);assert.equal(remaining.attendee_name,null);assert.ok(remaining.checked_in_at);
  assert.equal((await success(await request('me','GET',undefined,{Cookie:cookie}))).user,null);
  await denied(await request('privacy/export','GET',undefined,{Cookie:cookie}));await denied(await request(`media/${media.id}`));
  await assert.rejects(actorFromRequest(new Request(`${base}/api/v1/posts`,{headers:{Authorization:`Bearer ${grant.token}`}})));
  for(const actor of [closing,staleAgent])await assert.rejects(execute('posts_create',{body:'LATE-PRIVATE-BODY'},actor));
  await assert.rejects(query('UPDATE "user" SET name=$2 WHERE id=$1',[closing.userId,'LATE-PRIVATE-NAME']),(error:any)=>error.constraint==='privacy_account_closed');
  await assert.rejects(query('UPDATE profiles SET deleted_at=NULL,banned=false WHERE user_id=$1',[closing.userId]),(error:any)=>error.constraint==='privacy_account_closed');
  await assert.rejects(query('INSERT INTO "session"(id,"userId",token,"expiresAt","createdAt","updatedAt") VALUES(\'late-closed-session\',$1,\'late-closed-token\',now()+interval \'1 day\',now(),now())',[closing.userId]),(error:any)=>error.constraint==='privacy_account_closed');
  await assert.rejects(query("INSERT INTO posts(id,author_id,body) VALUES('late-closed-post',$1,'LATE-PRIVATE-BODY')",[closing.userId]),(error:any)=>error.constraint==='privacy_account_closed');
  const [deletion]=await query("SELECT d.*,j.id AS job_id FROM privacy_object_deletions d JOIN jobs j ON j.target_id=d.id AND j.kind='delete-object' WHERE d.storage_key=$1",[originalMedia.storage_key]);assert.ok(deletion);assert.equal(deletion.storage_backend,'local');
  await query('UPDATE privacy_object_deletions SET storage_location=$2 WHERE id=$1',[deletion.id,`${deletion.storage_location}-unavailable`]);
  await processJob(deletion.job_id);
  const [retry]=await query('SELECT status,attempts,error FROM jobs WHERE id=$1',[deletion.job_id]);assert.equal(retry.status,'pending');assert.equal(retry.attempts,1);assert.equal(retry.error.includes(originalMedia.storage_key),false);assert.equal((await query('SELECT 1 FROM privacy_object_deletions WHERE id=$1',[deletion.id])).length,1);assert.ok((await storage.getObject(originalMedia.storage_key)).length);
  await query('UPDATE privacy_object_deletions SET storage_location=$2 WHERE id=$1',[deletion.id,deletion.storage_location]);await query('UPDATE jobs SET available_at=now() WHERE id=$1',[deletion.job_id]);
  await processJob(deletion.job_id);assert.equal((await query('SELECT 1 FROM privacy_object_deletions WHERE id=$1',[deletion.id])).length,0);
  await assert.rejects(storage.getObject(originalMedia.storage_key),(error:any)=>error.code==='ENOENT');
  assert.equal((await query('SELECT "phoneNumber" FROM "user" WHERE id=$1',[other.userId]))[0].phoneNumber,phones.get(other.userId!));
});

test('community ownership and the last available platform administrator prevent account closure',async()=>{
  await assert.rejects(closeAccount(admin),(error:any)=>error.status===409&&error.code==='ACCOUNT_OWNS_COMMUNITIES');
  await query("UPDATE profiles SET role='admin' WHERE user_id=$1",[other.userId]);
  await query('UPDATE profiles SET banned=true WHERE user_id=$1',[admin.userId]);
  try {
    await assert.rejects(closeAccount(other),(error:any)=>error.status===409&&error.code==='ACCOUNT_LAST_ADMIN');
    const [profile]=await query('SELECT deleted_at,role FROM profiles WHERE user_id=$1',[other.userId]);assert.equal(profile.deleted_at,null);assert.equal(profile.role,'admin');
  } finally {
    await query('UPDATE profiles SET banned=false WHERE user_id=$1',[admin.userId]);await query("UPDATE profiles SET role='member' WHERE user_id=$1",[other.userId]);
  }
});

test('backups restore closed-account placeholders without resurrecting personal data or disabling account guards',async()=>{
  const {createBackup,restoreBackup}=await import('../src/server/backup');
  const directory=path.join(await mkdtemp(path.resolve('.local','privacy-backup-')),'snapshot');
  const manifest=await createBackup(directory,pool);
  await engine.createDatabase('privacy_restored');const target=new pg.Pool({connectionString:'postgresql://postgres:test-password@127.0.0.1:54333/privacy_restored'});
  try {
    const {getMigrations}=await import('better-auth/db/migration');await (await getMigrations({...auth.options,database:target})).runMigrations();
    await target.query('CREATE TABLE schema_migrations(name text PRIMARY KEY,applied_at timestamptz DEFAULT now())');
    const migrations=(await readdir('migrations')).filter(file=>file.endsWith('.sql')).sort();
    for(const file of migrations){await target.query(await readFile(path.join('migrations',file),'utf8'));await target.query('INSERT INTO schema_migrations(name) VALUES($1)',[file]);}
    const objects=new Map<string,Buffer>();const result=await restoreBackup(directory,target,async(key,data)=>{objects.set(key,data);});assert.equal(result.objects,manifest.objects.length);
    assert.deepEqual((await target.query('SELECT name FROM schema_migrations ORDER BY name')).rows.map(row=>row.name),migrations);
    const [restored]=(await target.query('SELECT p.deleted_at,p.banned,u.name,u."phoneNumber" FROM profiles p JOIN "user" u ON u.id=p.user_id WHERE p.user_id=$1',[closing.userId])).rows;
    assert.ok(restored.deleted_at);assert.equal(restored.banned,true);assert.equal(restored.name,'已注销账户');assert.equal(restored.phoneNumber,null);
    const posts=(await target.query('SELECT body,tags,deleted_at FROM posts WHERE author_id=$1',[closing.userId])).rows;assert.ok(posts.length);for(const post of posts){assert.equal(post.body,'');assert.deepEqual(post.tags,[]);assert.ok(post.deleted_at);}
    const comments=(await target.query('SELECT body,deleted_at FROM comments WHERE author_id=$1',[closing.userId])).rows;assert.ok(comments.length);for(const comment of comments){assert.equal(comment.body,'');assert.ok(comment.deleted_at);}
    assert.equal((await target.query('SELECT 1 FROM media WHERE owner_id=$1',[closing.userId])).rows.length,0);
    assert.equal((await target.query('SELECT 1 FROM events WHERE organizer_id=$1 AND cancelled AND description=\'\' AND address=\'\'',[closing.userId])).rows.length,1);
    assert.equal((await target.query('SELECT 1 FROM "session" WHERE "userId"=$1',[closing.userId])).rows.length,0);
    await assert.rejects(target.query('UPDATE "user" SET name=$2 WHERE id=$1',[closing.userId,'RESTORED-LATE-NAME']),(error:any)=>error.constraint==='privacy_account_closed');
    await assert.rejects(target.query("INSERT INTO posts(id,author_id,body) VALUES('restore-orphan','missing-user','orphan')"),(error:any)=>error.code==='23503');
    await assert.rejects(restoreBackup(directory,target),/not empty/);
  } finally {await target.end();}
});
