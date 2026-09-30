import { before,after,test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdir,mkdtemp } from 'node:fs/promises';
import path from 'node:path';
import EmbeddedPostgres from 'embedded-postgres';
import type pg from 'pg';
import sharp from 'sharp';
import type { Actor } from '../src/shared/contracts';
import { PRIVACY_VERSION } from '../src/shared/privacy';

const base='http://localhost:3196';
const owner:Actor={userId:'moderation-owner'},author:Actor={userId:'moderation-author'},outsider:Actor={userId:'moderation-outsider'},reviewer:Actor={userId:'moderation-reviewer'},closing:Actor={userId:'moderation-closing'};
const actors=[owner,author,outsider,reviewer,closing];
const cookies=new Map<string,string>();
let engine:EmbeddedPostgres,pool:pg.Pool,query:any,execute:any,http:any,auth:any,actorFromRequest:any,processJob:any,closeAccount:any;
let moderationList:any,moderationDecide:any,moderationAppeal:any,moderationRetry:any,processModeration:any;
let publicGroup:string,privateGroup:string,authorGrant:any,reviewerGrant:any,authorAgent:Actor,reviewerAgent:Actor;

before(async()=>{
  await mkdir('.local',{recursive:true});const root=await mkdtemp(path.resolve('.local','moderation-test-'));
  Object.assign(process.env,{DEV_MODE:'true',INVITE_ONLY:'false',ADMIN_PHONE:'',APP_URL:base,DATABASE_URL:'postgresql://postgres:test-password@127.0.0.1:54334/postgres',BETTER_AUTH_SECRET:randomBytes(40).toString('hex'),AUTH_IP_HEADER:'x-forwarded-for',STORAGE_DRIVER:'local',LOCAL_STORAGE_DIR:path.join(root,'uploads'),REDIS_URL:'',MEILI_URL:'',DB_POOL_SIZE:'20',SMS_DAILY_LIMIT:'1000',CONTENT_MODERATION_PROVIDER:'manual',CONTENT_MODERATION_ACCESS_KEY_ID:'',CONTENT_MODERATION_ACCESS_KEY_SECRET:''});
  engine=new EmbeddedPostgres({databaseDir:path.join(root,'db'),user:'postgres',password:'test-password',port:54334,persistent:true,initdbFlags:['--encoding=UTF8','--locale=C'],postgresFlags:['-h','127.0.0.1'],onLog:()=>{},onError:()=>{}});
  await engine.initialise();await engine.start();
  ({pool,query}=await import('../src/server/db'));({execute}=await import('../src/server/service'));({auth,actorFromRequest}=await import('../src/server/auth'));
  await (await import('../scripts/migrate')).migrate();({handleApi:http}=await import('../src/server/http'));
  ({moderationList,moderationDecide,moderationAppeal,moderationRetry,processModeration}=await import('../src/server/moderation'));
  ({processJob}=await import('../src/server/worker'));({closeAccount}=await import('../src/server/privacy'));
  for(const [index,actor] of actors.entries()) {
    const phoneNumber=`+861390300000${index}`;
    await query(`INSERT INTO "user"(id,name,email,"emailVerified","phoneNumber","phoneNumberVerified","createdAt","updatedAt") VALUES($1,$1,$2,true,$3,true,now(),now())`,[actor.userId,`${actor.userId}@example.invalid`,phoneNumber]);
    await query('INSERT INTO profiles(user_id,handle,role) VALUES($1,$1,$2)',[actor.userId,actor===reviewer?'admin':'member']);
    await success(await authRequest('/phone-number/send-otp',{phoneNumber}));
    const [otp]=await query('SELECT count FROM usage_counters WHERE key=$1',[`dev-otp:${phoneNumber}`]);
    const response=await authRequest('/phone-number/verify',{phoneNumber,code:String(otp.count).padStart(6,'0')});await success(response.clone());
    const cookie=response.headers.getSetCookie().map(value=>value.split(';')[0]).join('; ');assert.ok(cookie);cookies.set(actor.userId!,cookie);
  }
  const publicDraft=await execute('communities_create',{name:'审核公开社群',description:'测试专用',city:'杭州',visibility:'public'},owner);
  await moderationDecide(reviewer,{id:publicDraft.moderationId,decision:'approve',reason:'测试公开社群'});publicGroup=publicDraft.id;
  const privateDraft=await execute('communities_create',{name:'审核私密社群',description:'测试专用',city:'杭州',visibility:'private'},owner);
  await moderationDecide(reviewer,{id:privateDraft.moderationId,decision:'approve',reason:'测试私密社群'});privateGroup=privateDraft.id;
  for(const actor of [author,outsider,closing])await execute('communities_join',{id:publicGroup},actor);
  await execute('communities_join',{id:privateGroup},author);await execute('communities_approve',{id:privateGroup,userId:author.userId,approved:true},owner);
  authorGrant=await execute('grants_create',{name:'作者 Agent',scopes:['content:read','posts:write','interactions:write'],communityIds:[publicGroup,privateGroup],days:1},author);
  reviewerGrant=await execute('grants_create',{name:'平台管理员 Agent',scopes:['content:read','posts:write','interactions:write'],communityIds:[],days:1},reviewer);
  authorAgent=await actorFromRequest(new Request(`${base}/api/v1/posts`,{headers:{Authorization:`Bearer ${authorGrant.token}`}}));
  reviewerAgent=await actorFromRequest(new Request(`${base}/api/v1/posts`,{headers:{Authorization:`Bearer ${reviewerGrant.token}`}}));
},{timeout:120000});
after(async()=>{if(pool)await pool.end();if(engine)await engine.stop();});

function authRequest(endpoint:string,body:Record<string,unknown>):Promise<Response> {
  const phone=String(body.phoneNumber||'');
  return auth.handler(new Request(`${base}/api/auth${endpoint}`,{method:'POST',headers:{Origin:base,'Content-Type':'application/json','X-Privacy-Version':PRIVACY_VERSION,'X-Forwarded-For':`198.51.100.${Number(phone.slice(-3))%254+1}`},body:JSON.stringify(body)}));
}
async function success(response:Response) {const body=await response.json();assert.equal(response.status,200,JSON.stringify(body));return body;}
async function denied(response:Response) {assert.ok(response.status>=400&&response.status<500,`${response.status}: ${await response.text()}`);}
function headers(actor?:Actor):Record<string,string> {return actor?{Cookie:cookies.get(actor.userId!)!}:{};}
function request(endpoint:string,method='GET',body?:unknown,authHeaders:Record<string,string>={}):Promise<Response> {
  return http(new Request(`${base}/api/v1/${endpoint}`,{method,headers:{Origin:base,...(body?{'Content-Type':'application/json'}:{}),...authHeaders},body:body?JSON.stringify(body):undefined}));
}
async function upload(actor:Actor=author) {
  const bytes=await sharp({create:{width:3,height:3,channels:3,background:'#385776'}}).png().toBuffer();
  const form=new FormData();form.set('file',new File([new Uint8Array(bytes)],'moderation.png',{type:'image/png'}));
  return success(await http(new Request(`${base}/api/v1/media`,{method:'POST',headers:{Origin:base,...headers(actor)},body:form})));
}
async function pendingPost(body:string,actor:Actor=author,extra:Record<string,unknown>={}) {
  const post=await execute('posts_create',{body,...extra},actor);assert.equal(post.moderationStatus,'pending');assert.ok(post.id);return post;
}
async function invisible(id:string,marker:string,actor:Actor={}) {
  await assert.rejects(execute('posts_get',{id},actor));
  assert.equal(JSON.stringify(await execute('posts_list',{},actor)).includes(marker),false);
  assert.equal(JSON.stringify(await execute('search',{q:marker,type:'posts'},actor)).includes(marker),false);
}
async function caseFor(targetId:string,targetType='post') {
  const [item]=await query('SELECT * FROM moderation_cases WHERE target_type=$1 AND target_id=$2',[targetType,targetId]);assert.ok(item,`Missing ${targetType} moderation case for ${targetId}`);return item;
}
async function approve(targetId:string,targetType='post') {
  const item=await caseFor(targetId,targetType);await moderationDecide(reviewer,{id:item.id,decision:'approve',reason:'测试夹具人工审核通过'});return item.id;
}

test('pending posts and attached images stay out of public reads, search, reactions and reposts',async()=>{
  const image=await upload(),marker='PENDING-POST-PRIVATE-MARKER';
  const post=await pendingPost(marker,author,{mediaIds:[image.id],communityId:publicGroup});
  const item=await caseFor(post.id);assert.equal(item.status,'pending');
  for(const actor of [{},author,outsider,reviewer,authorAgent] as Actor[])await invisible(post.id,marker,actor);
  for(const authHeaders of [{},headers(author),headers(reviewer),{Authorization:`Bearer ${authorGrant.token}`}])await denied(await request(`media/${image.id}`,'GET',undefined,authHeaders));
  await assert.rejects(execute('posts_create',{body:'不允许转发未审内容',originalId:post.id},outsider));
  await assert.rejects(execute('reactions_set',{id:post.id,kind:'like',active:true},outsider));
  for(const actor of [author,reviewer])assert.equal((await request(`moderation/media/${image.id}`,'GET',undefined,headers(actor))).status,200);
  for(const authHeaders of [{},headers(owner),headers(outsider),{Authorization:`Bearer ${authorGrant.token}`},{Authorization:`Bearer ${reviewerGrant.token}`}])await denied(await request(`moderation/media/${image.id}`,'GET',undefined,authHeaders));
  await approve(post.id);
  assert.equal((await execute('posts_get',{id:post.id},{})).body,marker);assert.equal((await request(`media/${image.id}`)).status,200);
  assert.ok((await execute('search',{q:marker,type:'posts'},{})).posts.some((value:any)=>value.id===post.id));
});

test('only a person can see their own queue and platform administrators can review private content without publishing it',async()=>{
  const marker='PRIVATE-GROUP-PENDING-MARKER',image=await upload();
  const post=await pendingPost(marker,author,{communityId:privateGroup,mediaIds:[image.id]}),item=await caseFor(post.id);
  const mine=await moderationList(author,{mine:true});assert.ok(mine.items.some((entry:any)=>entry.id===item.id&&entry.text.includes(marker)));
  assert.equal(JSON.stringify(await moderationList(outsider,{mine:true})).includes(marker),false);
  assert.ok((await moderationList(reviewer,{})).items.some((entry:any)=>entry.id===item.id));
  for(const actor of [{},author,owner,authorAgent,reviewerAgent] as Actor[])await assert.rejects(moderationList(actor,{}));
  for(const actor of [authorAgent,reviewerAgent])await assert.rejects(moderationList(actor,{mine:true}));
  assert.ok(JSON.stringify(await success(await request('moderation?mine=true','GET',undefined,headers(author)))).includes(marker));
  for(const authHeaders of [{},headers(outsider),{Authorization:`Bearer ${authorGrant.token}`},{Authorization:`Bearer ${reviewerGrant.token}`}])await denied(await request('moderation','GET',undefined,authHeaders));
  for(const actor of [{},author,owner,outsider,authorAgent,reviewerAgent] as Actor[]) {
    await assert.rejects(moderationDecide(actor,{id:item.id,decision:'approve',reason:'越权'}));
    await assert.rejects(moderationRetry(actor,{id:item.id}));
  }
  await success(await request(`admin/moderation/${item.id}/decision`,'POST',{decision:'approve',reason:'人工确认允许发布'},headers(reviewer)));
  assert.equal((await execute('posts_get',{id:post.id},author)).body,marker);
  for(const actor of [{},outsider,reviewer] as Actor[])await invisible(post.id,marker,actor);
  for(const actor of [outsider,reviewer])await denied(await request(`media/${image.id}`,'GET',undefined,headers(actor)));
  await assert.rejects(execute('posts_create',{body:'不得跨群转发',originalId:post.id,communityId:publicGroup},author));
});

test('comments remain absent from threads until separately approved and removed comments cannot be revived',async()=>{
  const post=await pendingPost('COMMENT-PARENT-APPROVED');await approve(post.id);
  const marker='PENDING-COMMENT-PRIVATE-MARKER';
  const comment=await execute('comments_create',{id:post.id,body:marker},outsider);assert.equal(comment.moderationStatus,'pending');
  const item=await caseFor(comment.id,'comment');
  for(const actor of [{},author,outsider,reviewer] as Actor[])assert.equal(JSON.stringify(await execute('posts_get',{id:post.id},actor)).includes(marker),false);
  assert.equal(JSON.stringify(await execute('search',{q:marker,type:'posts'},{})).includes(marker),false);
  await moderationDecide(reviewer,{id:item.id,decision:'approve',reason:'评论审核通过'});
  assert.ok((await execute('posts_get',{id:post.id},{})).comments.some((value:any)=>value.id===comment.id&&value.body===marker));
  await moderationDecide(reviewer,{id:item.id,decision:'delete',reason:'评论应予移除'});
  assert.equal(JSON.stringify(await execute('posts_get',{id:post.id},{})).includes(marker),false);
  await assert.rejects(moderationDecide(reviewer,{id:item.id,decision:'approve',reason:'不得恢复终态'}));
  await assert.rejects(moderationAppeal(outsider,{id:item.id,reason:'已删除内容不得恢复'}));
  const late=await execute('comments_create',{id:post.id,body:'原帖删除后不得放行的评论'},outsider),lateCase=await caseFor(late.id,'comment');
  await execute('posts_delete',{id:post.id},author);
  await assert.rejects(moderationDecide(reviewer,{id:lateCase.id,decision:'approve',reason:'原帖已删除'}));
});

test('profile edits keep the approved public version and superseded drafts cannot overwrite newer edits',async()=>{
  const original=await execute('profile_get',{id:author.userId},{});
  const first=await execute('profile_update',{name:'已被替换的待审昵称',bio:'SUPERSEDED-PRIVATE-BIO',city:'苏州'},author);assert.equal(first.moderationStatus,'pending');
  const second=await execute('profile_update',{name:'审核后的昵称',bio:'APPROVED-PROFILE-BIO',city:'杭州'},author);assert.equal(second.moderationStatus,'pending');
  const pending=await execute('profile_get',{id:author.userId},{});assert.equal(pending.name,original.name);assert.equal(pending.bio,original.bio);
  await assert.rejects(moderationDecide(reviewer,{id:first.moderationId,decision:'approve',reason:'已被替换的草稿不可发布'}));
  await moderationDecide(reviewer,{id:second.moderationId,decision:'approve',reason:'资料人工审核通过'});
  const published=await execute('profile_get',{id:author.userId},{});assert.equal(published.name,'审核后的昵称');assert.equal(published.bio,'APPROVED-PROFILE-BIO');
  const next=await execute('profile_update',{name:'未审核的新昵称',bio:'UNREVIEWED-PROFILE-BIO',city:'上海'},author);
  assert.equal((await execute('profile_get',{id:author.userId},{})).name,'审核后的昵称');
  await moderationDecide(reviewer,{id:next.moderationId,decision:'delete',reason:'不发布这次修改'});
  assert.equal((await execute('profile_get',{id:author.userId},{})).name,'审核后的昵称');
  const withdrawn=await execute('profile_update',{name:'作者主动撤回的昵称',bio:'WITHDRAWN-DRAFT-BIO',city:'杭州'},author);
  for(const authHeaders of [headers(outsider),{Authorization:`Bearer ${authorGrant.token}`},{Authorization:`Bearer ${reviewerGrant.token}`}])await denied(await request(`moderation/${withdrawn.moderationId}/withdraw`,'POST',{},authHeaders));
  await success(await request(`moderation/${withdrawn.moderationId}/withdraw`,'POST',{},headers(author)));
  await assert.rejects(moderationDecide(reviewer,{id:withdrawn.moderationId,decision:'approve',reason:'不得恢复本人撤回的修改'}));
  assert.equal((await execute('profile_get',{id:author.userId},{})).name,'审核后的昵称');
});

test('authors may remove pending posts and neither approval nor retry can restore removed content',async()=>{
  const marker='AUTHOR-DELETED-PENDING-MARKER',image=await upload(),post=await pendingPost(marker,author,{mediaIds:[image.id]}),item=await caseFor(post.id);
  await execute('posts_delete',{id:post.id},author);
  await assert.rejects(moderationDecide(reviewer,{id:item.id,decision:'approve',reason:'不得恢复作者已删除帖子'}));
  await assert.rejects(moderationRetry(reviewer,{id:item.id}));
  await assert.rejects(moderationAppeal(author,{id:item.id,reason:'不能恢复删除内容'}));
  for(const actor of [{},author,reviewer] as Actor[])await invisible(post.id,marker,actor);
  for(const actor of [author,reviewer])await denied(await request(`moderation/media/${image.id}`,'GET',undefined,headers(actor)));
});

test('unavailable moderation keeps content private and authors can appeal a rejection for human review',async()=>{
  const unconfigured=await pendingPost('UNCONFIGURED-MODERATION-MARKER'),unconfiguredCase=await caseFor(unconfigured.id);
  const [job]=await query("SELECT id FROM jobs WHERE kind='moderation' AND target_id=$1",[unconfiguredCase.id]);assert.ok(job);await processJob(job.id);
  assert.equal((await caseFor(unconfigured.id)).status,'review');await invisible(unconfigured.id,'UNCONFIGURED-MODERATION-MARKER');
  const previousFetch=globalThis.fetch;const variables=['CONTENT_MODERATION_PROVIDER','CONTENT_MODERATION_REGION','CONTENT_MODERATION_ACCESS_KEY_ID','CONTENT_MODERATION_ACCESS_KEY_SECRET'] as const;
  const previous=new Map(variables.map(key=>[key,process.env[key]]));
  try {
    Object.assign(process.env,{CONTENT_MODERATION_PROVIDER:'aliyun',CONTENT_MODERATION_REGION:'cn-shanghai',CONTENT_MODERATION_ACCESS_KEY_ID:'test-moderation-key',CONTENT_MODERATION_ACCESS_KEY_SECRET:'test-moderation-secret'});
    globalThis.fetch=async()=>{throw new Error('PROVIDER-SECRET-INTERNAL-ERROR');};
    const failed=await pendingPost('PROVIDER-FAILURE-MARKER'),failedCase=await caseFor(failed.id);await processModeration(failedCase.id);
    const failure=await caseFor(failed.id);assert.equal(failure.status,'review');assert.equal(JSON.stringify(await moderationList(author,{mine:true})).includes('PROVIDER-SECRET-INTERNAL-ERROR'),false);await invisible(failed.id,'PROVIDER-FAILURE-MARKER');
    await success(await request(`admin/moderation/${failedCase.id}/retry`,'POST',{},headers(reviewer)));assert.equal((await caseFor(failed.id)).status,'pending');
    globalThis.fetch=async(_url,init)=>{
      const form=new URLSearchParams(String(init?.body));assert.equal(form.get('Action'),'TextModerationPlus');const params=JSON.parse(form.get('ServiceParameters')!);
      return Response.json({Code:200,Data:{DataId:params.dataId,RiskLevel:'high',Result:[{Label:'pornographic_adult',Confidence:99}]}});
    };
    await processModeration(failedCase.id);assert.equal((await caseFor(failed.id)).status,'rejected');await invisible(failed.id,'PROVIDER-FAILURE-MARKER');
    for(const actor of [{},outsider,reviewer,authorAgent,reviewerAgent] as Actor[])await assert.rejects(moderationAppeal(actor,{id:failedCase.id,reason:'无权申诉他人内容'}));
    await success(await request(`moderation/${failedCase.id}/appeal`,'POST',{reason:'请人工结合上下文复核'},headers(author)));
    const appealed=await caseFor(failed.id);assert.equal(appealed.status,'review');assert.equal(appealed.appeal_reason,'请人工结合上下文复核');
    assert.ok((await moderationList(reviewer,{status:'review'})).items.every((entry:any)=>entry.status==='review'));
    await moderationDecide(reviewer,{id:failedCase.id,decision:'approve',reason:'人工复核允许发布'});assert.equal((await execute('posts_get',{id:failed.id},{})).body,'PROVIDER-FAILURE-MARKER');
    globalThis.fetch=async(_url,init)=>{const form=new URLSearchParams(String(init?.body));const params=JSON.parse(form.get('ServiceParameters')!);return Response.json({Code:200,Data:{DataId:params.dataId,RiskLevel:'none',Result:[{Label:'nonLabel'}]}});};
    const automatic=await pendingPost('AUTOMATICALLY-APPROVED-MARKER'),automaticCase=await caseFor(automatic.id);await processModeration(automaticCase.id);
    assert.equal((await caseFor(automatic.id)).status,'approved');assert.equal((await execute('posts_get',{id:automatic.id},{})).body,'AUTOMATICALLY-APPROVED-MARKER');
  } finally {globalThis.fetch=previousFetch;for(const [key,value] of previous){if(value===undefined)delete process.env[key];else process.env[key]=value;}}
});

test('a delayed automated approval cannot overwrite an administrator deletion',async()=>{
  const marker='DELETED-DURING-PROVIDER-MARKER',post=await pendingPost(marker),item=await caseFor(post.id);
  const previousFetch=globalThis.fetch;const variables=['CONTENT_MODERATION_PROVIDER','CONTENT_MODERATION_REGION','CONTENT_MODERATION_ACCESS_KEY_ID','CONTENT_MODERATION_ACCESS_KEY_SECRET'] as const;
  const previous=new Map(variables.map(key=>[key,process.env[key]]));
  let reachedProvider!:()=>void,releaseProvider!:(response:Response)=>void,dataId='';
  const reached=new Promise<void>(resolve=>{reachedProvider=resolve;}),response=new Promise<Response>(resolve=>{releaseProvider=resolve;});let running:Promise<boolean>|undefined;
  try {
    Object.assign(process.env,{CONTENT_MODERATION_PROVIDER:'aliyun',CONTENT_MODERATION_REGION:'cn-shanghai',CONTENT_MODERATION_ACCESS_KEY_ID:'test-moderation-key',CONTENT_MODERATION_ACCESS_KEY_SECRET:'test-moderation-secret'});
    globalThis.fetch=async(_url,init)=>{const form=new URLSearchParams(String(init?.body));dataId=JSON.parse(form.get('ServiceParameters')!).dataId;reachedProvider();return response;};
    const task:Promise<boolean>=processModeration(item.id);running=task;await Promise.race([reached,task.then(()=>{throw new Error('Moderation never reached provider');})]);
    await moderationDecide(reviewer,{id:item.id,decision:'delete',reason:'人工删除优先于迟到结果'});
    releaseProvider(Response.json({Code:200,Data:{DataId:dataId,RiskLevel:'none',Result:[{Label:'nonLabel'}]}}));await task;
    const final=await caseFor(post.id);assert.equal(final.status,'deleted');assert.ok(final.revision>item.revision);await invisible(post.id,marker);
  } finally {
    try {releaseProvider(Response.json({Code:500}));await running;}
    finally {globalThis.fetch=previousFetch;for(const [key,value] of previous){if(value===undefined)delete process.env[key];else process.env[key]=value;}}
  }
});

test('closing an account clears review content and prevents stale approval from restoring it',async()=>{
  const marker='CLOSED-ACCOUNT-PENDING-CONTENT',image=await upload(closing),post=await pendingPost(marker,closing,{mediaIds:[image.id]}),item=await caseFor(post.id);
  const draft=await execute('profile_update',{name:'注销前待审昵称',bio:'CLOSED-PROFILE-DRAFT-CONTENT',city:'杭州'},closing);
  await closeAccount(closing);
  assert.equal((await query('SELECT 1 FROM moderation_cases WHERE author_id=$1',[closing.userId])).length,0);
  assert.equal(JSON.stringify(await moderationList(reviewer,{})).includes(marker),false);
  assert.equal((await query("SELECT 1 FROM content_drafts WHERE author_id=$1 AND payload::text<>'{}'",[closing.userId])).length,0);
  for(const id of [item.id,draft.moderationId])await assert.rejects(moderationDecide(reviewer,{id,decision:'approve',reason:'不得恢复已注销内容'}));
  await invisible(post.id,marker);await denied(await request(`moderation/media/${image.id}`,'GET',undefined,headers(reviewer)));
});

test('deleting an older approved profile draft cannot erase a later identical approved version',async()=>{
  const a={name:'同内容新版本昵称',bio:'PROFILE-VERSION-A',city:'杭州'},b={name:'中间版本昵称',bio:'PROFILE-VERSION-B',city:'上海'};
  const first=await execute('profile_update',a,author);await moderationDecide(reviewer,{id:first.moderationId,decision:'approve',reason:'批准最早 A 版本'});
  const middle=await execute('profile_update',b,author);await moderationDecide(reviewer,{id:middle.moderationId,decision:'approve',reason:'批准 B 版本'});
  const latest=await execute('profile_update',a,author);await moderationDecide(reviewer,{id:latest.moderationId,decision:'approve',reason:'批准新的 A 版本'});
  await moderationDecide(reviewer,{id:first.moderationId,decision:'delete',reason:'删除最早 A 版本'});
  const profile=await execute('profile_get',{id:author.userId},{});assert.equal(profile.name,a.name);assert.equal(profile.bio,a.bio);assert.equal(profile.city,a.city);
  const [head]=await query("SELECT current_draft_id FROM content_draft_heads WHERE kind='profile' AND target_id=$1",[author.userId]);assert.equal(head.current_draft_id,latest.draftId);
  assert.equal((await query('SELECT status FROM content_drafts WHERE id=$1',[first.draftId]))[0].status,'deleted');
});

test('event and community takedowns reject old dependent drafts and prevent public reads or reopening',async()=>{
  const event=await execute('events_create',{communityId:publicGroup,title:'待下架活动',description:'TAKEDOWN-EVENT-CONTENT',city:'杭州',address:'TAKEDOWN-ADDRESS',startsAt:new Date(Date.now()+86400000).toISOString(),endsAt:new Date(Date.now()+90000000).toISOString(),capacity:10},owner);
  await moderationDecide(reviewer,{id:event.moderationId,decision:'approve',reason:'批准活动发布'});
  const recap=await execute('events_update',{id:event.id,recap:'TAKEDOWN-PENDING-RECAP'},owner);assert.equal(recap.moderationStatus,'pending');
  await moderationDecide(reviewer,{id:event.moderationId,decision:'delete',reason:'下架这场活动'});
  await assert.rejects(moderationDecide(reviewer,{id:recap.moderationId,decision:'approve',reason:'不能发布已下架活动的旧回顾'}));
  await assert.rejects(execute('events_update',{id:event.id,cancelled:false},owner));
  for(const actor of [{},owner,reviewer] as Actor[]) {
    await assert.rejects(execute('events_get',{id:event.id},actor));
    assert.equal((await execute('events_list',{},actor)).items.some((entry:any)=>entry.id===event.id),false);
  }
  const community=await execute('communities_create',{name:'待下架社群',description:'TAKEDOWN-COMMUNITY-CONTENT',city:'杭州',visibility:'public'},owner);
  await moderationDecide(reviewer,{id:community.moderationId,decision:'approve',reason:'批准社群发布'});
  const announcement=await execute('communities_announcement',{id:community.id,announcement:'TAKEDOWN-PENDING-ANNOUNCEMENT'},owner);
  await moderationDecide(reviewer,{id:community.moderationId,decision:'delete',reason:'下架这个社群'});
  await assert.rejects(moderationDecide(reviewer,{id:announcement.moderationId,decision:'approve',reason:'不能发布已下架社群的旧公告'}));
  for(const actor of [{},owner,reviewer] as Actor[]) {
    await assert.rejects(execute('communities_get',{id:community.id},actor));
    assert.equal((await execute('communities_list',{},actor)).items.some((entry:any)=>entry.id===community.id),false);
  }
});

test('closing a reviewer erases their decision reasons while retaining the manual review boundary',async()=>{
  const departing:Actor={userId:'moderation-departing-reviewer'},marker='REVIEWER-CLOSURE-PRIVATE-MARKER';
  await query('INSERT INTO "user"(id,name,email,"emailVerified","phoneNumber","phoneNumberVerified","createdAt","updatedAt") VALUES($1,$1,$2,true,$3,true,now(),now())',[departing.userId,'departing-reviewer@example.invalid','+8613903000099']);
  await query("INSERT INTO profiles(user_id,handle,role) VALUES($1,$1,'admin')",[departing.userId]);
  const post=await pendingPost('REVIEWER-CLOSURE-AUTHOR-CONTENT'),item=await caseFor(post.id);
  await moderationDecide(departing,{id:item.id,decision:'approve',reason:marker});
  assert.ok((await query('SELECT reason FROM moderation_history WHERE case_id=$1',[item.id])).some((entry:any)=>entry.reason.includes(marker)));
  await closeAccount(departing);
  const closed=await caseFor(post.id);assert.equal(closed.status,'approved');assert.equal(closed.reviewed_by,departing.userId);assert.equal(closed.reason.includes(marker),false);
  const history=await query('SELECT actor_id,reason FROM moderation_history WHERE case_id=$1',[item.id]);assert.ok(history.length);assert.equal(JSON.stringify(history).includes(marker),false);assert.equal(history.some((entry:any)=>entry.actor_id===departing.userId),false);
  const {moderationRevisionForPost}=await import('../src/server/moderation');assert.equal(await moderationRevisionForPost(post.id),null);
  await processModeration(item.id);assert.equal((await caseFor(post.id)).reviewed_by,departing.userId);assert.equal((await execute('posts_get',{id:post.id},{})).body,'REVIEWER-CLOSURE-AUTHOR-CONTENT');
});
