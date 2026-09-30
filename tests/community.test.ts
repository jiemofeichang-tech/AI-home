import { before,after,test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes,createHash } from 'node:crypto';
import { createServer,type Server } from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp,mkdir,readFile,readdir,writeFile } from 'node:fs/promises';
import path from 'node:path';
import EmbeddedPostgres from 'embedded-postgres';
import pg from 'pg';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { Actor } from '../src/shared/contracts';
import { PRIVACY_VERSION } from '../src/shared/privacy';
import { approvedFixtures } from './moderation-fixtures';

let engine:EmbeddedPostgres,pool:pg.Pool,server:Server,execute:any,query:any,http:any,auth:any,actorFromRequest:any,root:string;
let publicGroup:string,privateGroup:string,privatePost:string,publicPost:string,eventId:string;
let grant:any,agent:Actor,approveFixture:any;
const owner:Actor={userId:'test-user-0'},member:Actor={userId:'test-user-1'},outsider:Actor={userId:'test-user-2'};
const base='http://localhost:3199';
const bookingDetails=(userId:string)=>({attendeeName:`预约人${userId}`,phoneNumber:`139000${userId.split('-').at(-1)!.padStart(5,'0')}`,contactConsent:true});
before(async()=>{
  await mkdir('.local',{recursive:true});root=await mkdtemp(path.resolve('.local','test-'));
  Object.assign(process.env,{DEV_MODE:'true',APP_URL:base,DATABASE_URL:'postgresql://postgres:test-password@127.0.0.1:54331/postgres',BETTER_AUTH_SECRET:randomBytes(40).toString('hex'),STORAGE_DRIVER:'local',LOCAL_STORAGE_DIR:path.join(root,'uploads'),REDIS_URL:'',MEILI_URL:'',DB_POOL_SIZE:'25',CONTENT_MODERATION_PROVIDER:'manual'});
  engine=new EmbeddedPostgres({databaseDir:path.join(root,'db'),user:'postgres',password:'test-password',port:54331,persistent:true,initdbFlags:['--encoding=UTF8','--locale=C'],postgresFlags:['-h','127.0.0.1'],onLog:()=>{},onError:()=>{}});await engine.initialise();await engine.start();
  ({pool,query}=await import('../src/server/db'));({execute}=await import('../src/server/service'));({auth,actorFromRequest}=await import('../src/server/auth'));await (await import('../scripts/migrate')).migrate();({handleApi:http}=await import('../src/server/http'));
  ({execute,approve:approveFixture}=approvedFixtures(execute,query,(await import('../src/server/moderation')).moderationDecide,owner));
  const {POST:mcp}=await import('../src/app/mcp/route');
  server=createServer(async(req,res)=>{try{const chunks:Buffer[]=[];for await(const c of req)chunks.push(c);const request=new Request(`${base}${req.url}`,{method:req.method,headers:req.headers as HeadersInit,body:['GET','HEAD'].includes(req.method||'GET')?undefined:Buffer.concat(chunks)});const response=req.url?.startsWith('/mcp')?await mcp(request):req.url?.startsWith('/api/auth/')?await auth.handler(request):await http(request);res.writeHead(response.status,Object.fromEntries(response.headers));res.end(Buffer.from(await response.arrayBuffer()));}catch(e){res.writeHead(500);res.end(String(e));}});await new Promise<void>(r=>server.listen(3199,'127.0.0.1',r));
  for(let i=0;i<100;i++){await query(`INSERT INTO "user"(id,name,email,"emailVerified","phoneNumber","phoneNumberVerified","createdAt","updatedAt") VALUES($1,$2,$3,true,$4,true,now(),now())`,[`test-user-${i}`,`测试用户${i}`,`test${i}@example.invalid`,`+86139000${String(i).padStart(5,'0')}`]);await query('INSERT INTO profiles(user_id,handle,city,role) VALUES($1,$2,$3,$4)',[`test-user-${i}`,`test${i}`,'杭州',i===0?'admin':'member']);}
  publicGroup=(await execute('communities_create',{name:'测试公开社群',description:'测试专用',city:'杭州',visibility:'public'},owner)).id;
  privateGroup=(await execute('communities_create',{name:'测试私密社群',description:'测试专用',city:'杭州',visibility:'private'},owner)).id;
  await execute('communities_announcement',{id:privateGroup,announcement:'ONLY-MEMBERS-SECRET'},owner);
  await execute('communities_join',{id:privateGroup},member);await execute('communities_approve',{id:privateGroup,userId:member.userId,approved:true},owner);
  privatePost=(await execute('posts_create',{body:'PRIVATE-NEEDLE 私密内容',communityId:privateGroup},owner)).id;
  publicPost=(await execute('posts_create',{body:'PUBLIC-NEEDLE 开源项目 #Agent'},owner)).id;
  grant=await execute('grants_create',{name:'测试Agent',scopes:['content:read','posts:write','interactions:write','events:rsvp','events:manage'],communityIds:[privateGroup,publicGroup],days:30},owner);
  agent=await actorFromRequest(new Request(`${base}/api/v1/posts`,{headers:{Authorization:`Bearer ${grant.token}`}}));
}, {timeout:120000});
after(async()=>{if(server)await new Promise<void>(r=>server.close(()=>r()));if(pool)await pool.end();if(engine)await engine.stop();});

test('public/private visibility includes announcements, search, original posts and agent group scope',async()=>{
  assert.equal((await execute('posts_get',{id:publicPost},{})).body.includes('PUBLIC'),true);
  await assert.rejects(execute('posts_get',{id:privatePost},outsider),/需要加入社群/);
  assert.equal((await execute('posts_get',{id:privatePost},member)).id,privatePost);
  assert.equal((await execute('posts_get',{id:privatePost},agent)).id,privatePost);
  assert.equal(JSON.stringify(await execute('communities_list',{},{})).includes('ONLY-MEMBERS-SECRET'),false);
  assert.equal(JSON.stringify(await execute('search',{q:'测试',type:'communities'},{})).includes('ONLY-MEMBERS-SECRET'),false);
  assert.equal((await execute('search',{q:'PRIVATE-NEEDLE'},outsider)).posts.length,0);
  await assert.rejects(execute('posts_create',{originalId:privatePost},agent),/私密内容/);
  const short=await execute('grants_create',{name:'limited',scopes:['content:read'],communityIds:[],days:1},owner);
  const a=await actorFromRequest(new Request(`${base}/api/v1/posts`,{headers:{Authorization:`Bearer ${short.token}`}}));
  await assert.rejects(execute('posts_get',{id:privatePost},a),/社群的授权/);
  await assert.rejects(execute('posts_create',{body:'not allowed'},a),/操作授权/);
  await execute('communities_leave',{id:privateGroup},member);
  await assert.rejects(execute('posts_get',{id:privatePost},member),/需要加入社群/);
});
test('permissions are applied before search limits and pagination',async()=>{
  const visible=(await execute('posts_create',{body:'HIDDEN-FLOOD public older result'},owner)).id;
  const flood=await query(`INSERT INTO posts(id,author_id,community_id,body) SELECT 'flood-'||n,$1,$2,'HIDDEN-FLOOD private' FROM generate_series(1,160)n RETURNING id`,[owner.userId,privateGroup]);
  const {enqueueModeration}=await import('../src/server/moderation');for(const post of flood){await enqueueModeration('post',post.id,owner.userId!);await approveFixture(post);}
  const result=await execute('search',{q:'HIDDEN-FLOOD'},outsider);assert.equal(result.posts.length,1);assert.equal(result.posts[0].id,visible);
});
test('removing a member immediately removes their Agent access',async()=>{
  const c=await execute('communities_create',{name:'移除测试社群',description:'测试',city:'杭州',visibility:'private'},owner);
  await execute('communities_join',{id:c.id},outsider);await execute('communities_approve',{id:c.id,userId:outsider.userId,approved:true},owner);
  const p=await execute('posts_create',{body:'MEMBERSHIP-REMOVAL-SECRET',communityId:c.id},owner);
  const g=await execute('grants_create',{name:'member-agent',scopes:['content:read'],communityIds:[c.id],days:1},outsider);
  const a=await actorFromRequest(new Request(`${base}/api/v1/posts`,{headers:{Authorization:`Bearer ${g.token}`}}));assert.equal((await execute('posts_get',{id:p.id},a)).id,p.id);
  await assert.rejects(execute('communities_remove',{id:c.id,userId:owner.userId},owner),/创建者/);
  await execute('communities_remove',{id:c.id,userId:outsider.userId},owner);await assert.rejects(execute('posts_get',{id:p.id},a),/需要加入社群/);
});

test('write idempotency is atomic and distinguishes different request bodies',async()=>{
  const input={body:'IDEMPOTENCY-TEST',idempotencyKey:'same-key'};const results=await Promise.all(Array.from({length:10},()=>execute('posts_create',input,agent)));
  assert.equal(new Set(results.map(r=>r.id)).size,1);
  assert.equal((await query(`SELECT count(*)::int AS n FROM posts WHERE body='IDEMPOTENCY-TEST'`))[0].n,1);
  await assert.rejects(execute('posts_create',{...input,body:'different'},agent),/幂等键/);
});
test('event booking validates contact details, restricts attendee data and cancels without contact details',async()=>{
  await execute('communities_join',{id:publicGroup},member);
  const event=await execute('events_create',{communityId:publicGroup,title:'联系资料预约测试',description:'测试报名资料',city:'杭州',address:'活动地址',startsAt:new Date(Date.now()+86400000).toISOString(),endsAt:new Date(Date.now()+90000000).toISOString(),capacity:2},owner);
  const memberGrant=await execute('grants_create',{name:'contact-test',scopes:['content:read','events:rsvp'],communityIds:[publicGroup],days:1},member);
  const headers={Authorization:`Bearer ${memberGrant.token}`,'Content-Type':'application/json'};
  const contact={attendeeName:'  预约联系人-PRIVATE  ',phoneNumber:'13812345678',contactConsent:true};
  for(const input of [{},{attendeeName:contact.attendeeName},{phoneNumber:contact.phoneNumber},{...contact,attendeeName:' \t '},{...contact,attendeeName:'名'.repeat(61)},{...contact,phoneNumber:'12345'},{...contact,phoneNumber:'12812345678'},{...contact,contactConsent:false},{attendeeName:contact.attendeeName,phoneNumber:contact.phoneNumber}]) {
    const response=await http(new Request(`${base}/api/v1/events/${event.id}/rsvp`,{method:'PUT',headers,body:JSON.stringify({attending:true,...input})}));
    assert.equal(response.status,400,JSON.stringify(input));
    assert.equal((await query('SELECT count(*)::int AS n FROM registrations WHERE event_id=$1',[event.id]))[0].n,0,'Invalid booking must not occupy a slot');
  }
  const response=await http(new Request(`${base}/api/v1/events/${event.id}/rsvp`,{method:'PUT',headers,body:JSON.stringify({attending:true,...contact})}));assert.equal(response.status,200);
  const [stored]=await query('SELECT attendee_name,phone_number FROM registrations WHERE event_id=$1 AND user_id=$2',[event.id,member.userId]);
  assert.deepEqual(stored,{attendee_name:contact.attendeeName.trim(),phone_number:`+86${contact.phoneNumber}`});
  await query('INSERT INTO registrations(event_id,user_id) VALUES($1,$2)',[event.id,outsider.userId]);
  const attendees=(await execute('events_attendees',{id:event.id},owner)).items;
  assert.equal((await execute('events_get',{id:event.id},owner)).canManage,true);
  for(const actor of [{},member,agent])assert.equal((await execute('events_get',{id:event.id},actor)).canManage,false);
  assert.equal(attendees.find((r:any)=>r.id===member.userId).name,contact.attendeeName.trim());
  assert.equal(attendees.find((r:any)=>r.id===member.userId).phoneNumber,`+86${contact.phoneNumber}`);
  assert.equal(attendees.find((r:any)=>r.id===outsider.userId).name,'测试用户2');
  assert.equal(attendees.find((r:any)=>r.id===outsider.userId).phoneNumber,null,'Legacy registrations must not expose the account phone number');
  for(const [actor,status] of [[{},401],[member,403],[agent,403]] as [Actor,number][]) {
    await assert.rejects(execute('events_attendees',{id:event.id},actor),(error:any)=>error.status===status);
  }
  for(const requestHeaders of [undefined,headers,{Authorization:`Bearer ${grant.token}`}]) {
    for(const endpoint of [`events/${event.id}`,'events',`search?q=${encodeURIComponent('联系资料预约测试')}&type=events`]) {
      const publicResponse=await http(new Request(`${base}/api/v1/${endpoint}`,{headers:requestHeaders}));assert.equal(publicResponse.status,200);
      const result=await publicResponse.json();const events=endpoint.startsWith('search?')?result.events:endpoint==='events'?result.items:[result];assert.ok(events.some((e:any)=>e.id===event.id));
      const body=JSON.stringify(result);assert.equal(body.includes(contact.attendeeName.trim()),false);assert.equal(body.includes(contact.phoneNumber),false);assert.equal(/attendee_name|attendeeName|phone_number|phoneNumber/.test(body),false);
    }
  }
  const cancelled=await http(new Request(`${base}/api/v1/events/${event.id}/rsvp`,{method:'PUT',headers,body:JSON.stringify({attending:false})}));assert.equal(cancelled.status,200);
  assert.equal((await query('SELECT * FROM registrations WHERE event_id=$1 AND user_id=$2',[event.id,member.userId])).length,0);
});
test('20 concurrent users compete for one slot; cancellation, retry and check-in are idempotent',async()=>{
  const actors=Array.from({length:20},(_,i)=>({userId:`test-user-${i+10}`}));for(const a of actors)await execute('communities_join',{id:publicGroup},a);
  eventId=(await execute('events_create',{communityId:publicGroup,title:'并发报名测试',description:'本地测试活动',city:'杭州',address:'SECRET ADDRESS',startsAt:new Date(Date.now()+86400000).toISOString(),endsAt:new Date(Date.now()+90000000).toISOString(),capacity:1},owner)).id;
  assert.equal((await execute('events_get',{id:eventId},outsider)).address,null);
  const results=await Promise.allSettled(actors.map(a=>execute('events_rsvp',{id:eventId,attending:true,...bookingDetails(a.userId)},a)));assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
  const [row]=await query('SELECT user_id FROM registrations WHERE event_id=$1',[eventId]);const winner={userId:row.user_id};
  assert.equal((await execute('events_get',{id:eventId},winner)).address,'SECRET ADDRESS');
  await Promise.all(Array.from({length:5},()=>execute('events_rsvp',{id:eventId,attending:true,...bookingDetails(winner.userId)},winner)));
  const first=await execute('events_checkin',{id:eventId,userId:winner.userId},owner);const second=await execute('events_checkin',{id:eventId,userId:winner.userId},owner);assert.equal(String(first.checked_in_at),String(second.checked_in_at));
  const [beforeUpdate]=await query('SELECT created_at FROM registrations WHERE event_id=$1 AND user_id=$2',[eventId,winner.userId]);
  await execute('events_rsvp',{id:eventId,attending:true,attendeeName:'更新后的预约姓名',phoneNumber:'+8613811112222',contactConsent:true},winner);
  const [updated]=await query('SELECT attendee_name,phone_number,created_at,checked_in_at FROM registrations WHERE event_id=$1 AND user_id=$2',[eventId,winner.userId]);
  assert.equal(updated.attendee_name,'更新后的预约姓名');assert.equal(updated.phone_number,'+8613811112222');assert.equal(String(updated.created_at),String(beforeUpdate.created_at));assert.equal(String(updated.checked_in_at),String(first.checked_in_at));
  const g=await execute('grants_create',{name:'no-group',scopes:['events:rsvp'],communityIds:[],days:1},winner);const limited=await actorFromRequest(new Request(`${base}/api/v1/posts`,{headers:{Authorization:`Bearer ${g.token}`}}));
  await assert.rejects(execute('events_rsvp',{id:eventId,attending:false},limited),/社群/);
  await execute('communities_leave',{id:publicGroup},winner);await execute('events_rsvp',{id:eventId,attending:false},winner);
  const next=actors.find(a=>a.userId!==winner.userId)!;await execute('events_rsvp',{id:eventId,attending:true,...bookingDetails(next.userId)},next);assert.equal((await query('SELECT count(*)::int AS n FROM registrations WHERE event_id=$1',[eventId]))[0].n,1);
});
test('private attachments, OCR and reposts obey live permissions after deletion',async()=>{
  const {putObject}=await import('../src/server/storage');const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+afo0AAAAASUVORK5CYII=','base64');
  await putObject('images/test.png',png,'image/png');await query(`INSERT INTO media(id,owner_id,storage_key,mime,bytes,original_name,extracted_text,status) VALUES('test-image',$1,'images/test.png','image/png',$2,'test.png','OCR-SECRET','ready')`,[owner.userId,png.length]);
  await assert.rejects(execute('posts_create',{body:'steal image',mediaIds:['test-image']},outsider),/不属于你/);
  const post=(await execute('posts_create',{body:'private image',mediaIds:['test-image'],communityId:privateGroup},owner)).id;
  const unauth=await http(new Request(`${base}/api/v1/media/test-image`));assert.equal(unauth.status,403);
  const allowed=await http(new Request(`${base}/api/v1/media/test-image`,{headers:{Authorization:`Bearer ${grant.token}`}}));assert.equal(allowed.status,200);assert.equal(allowed.headers.get('cache-control'),'private, no-store');
  assert.equal((await execute('search',{q:'OCR-SECRET'},{})).posts.length,0);assert.equal((await execute('search',{q:'OCR-SECRET'},agent)).posts[0].id,post);
  const repost=(await execute('posts_create',{originalId:post,communityId:privateGroup},agent)).id;
  await execute('posts_delete',{id:post},owner);await assert.rejects(execute('posts_get',{id:repost},agent),/已被删除/);
  assert.equal((await http(new Request(`${base}/api/v1/media/test-image`,{headers:{Authorization:`Bearer ${grant.token}`}}))).status,404);
});
test('external URL protection rejects private/metadata addresses and unsupported protocols',async()=>{
  const {safeFetch,isPublicAddress}=await import('../src/server/providers');
  for(const ip of ['127.0.0.1','10.0.0.1','169.254.169.254','172.16.0.1','192.168.0.1','198.18.0.1','::1','::ffff:127.0.0.1'])assert.equal(isPublicAddress(ip),false);
  await assert.rejects(safeFetch('http://127.0.0.1:80/'),/内网/);await assert.rejects(safeFetch('file:///etc/passwd'),/不支持/);
  await assert.rejects(execute('posts_create',{links:['javascript:alert(1)']},owner),/HTTP/);
});
test('posts accept social share text and extract valid URLs without losing ordinary or malformed text',async()=>{
  const {extractWebUrls}=await import('../src/shared/links');
  async function publish(body:string,links:string[]=[]) {
    const response=await http(new Request(`${base}/api/v1/posts`,{method:'POST',headers:{Authorization:`Bearer ${grant.token}`,'Content-Type':'application/json'},body:JSON.stringify({body,links})}));
    const result=await response.json();assert.equal(response.status,200,JSON.stringify(result));
    await approveFixture(result);
    return execute('posts_get',{id:result.id},owner);
  }
  const douyinUrl='https://v.douyin.com/AbCdEfG/';
  const shareText=`3.28 复制打开抖音，看看【AI 创作者的作品】用 AI 制作的小工具 ${douyinUrl} 09/29 分享给朋友。再次分享：${douyinUrl}`;
  const shared=await publish('111',extractWebUrls(shareText));
  assert.equal(shared.body,'111');assert.deepEqual(shared.links.map((link:any)=>link.url),[douyinUrl]);assert.equal(shared.links[0].platform,'douyin');
  const validUrls=['https://example.com/guide?id=1','http://example.org/note'];
  const body=`保留普通文案：参考 ${validUrls[0]}，或者 ${validUrls[1]}。无效地址 https:// 和 https:/// 也应保留。`;
  const mixed=await publish(body,[validUrls[0]]);
  assert.equal(mixed.body,body);assert.deepEqual(mixed.links.map((link:any)=>link.url).sort(),[...validUrls].sort());
  const plainBody='今天用 AI 完成了一个小工具，先分享想法。';
  const plain=await publish(plainBody,extractWebUrls('没有可用链接，只有 https:// 和分享口令'));
  assert.equal(plain.body,plainBody);assert.deepEqual(plain.links,[]);
  for(const url of [shareText,'https://','not-a-url','javascript:alert(1)','file:///etc/passwd','data:text/html,hello']) {
    const response=await http(new Request(`${base}/api/v1/posts`,{method:'POST',headers:{Authorization:`Bearer ${grant.token}`,'Content-Type':'application/json'},body:JSON.stringify({body:'不允许的链接',links:[url]})}));
    assert.equal(response.status,400,url);
  }
});

test('link worker refuses private GitHub data and recovers after a retry',async()=>{
  const {processJob}=await import('../src/server/worker');
  const {execute:pendingExecute}=await import('../src/server/service');
  const post=await pendingExecute('posts_create',{body:'worker fixture',links:['https://github.com/test-owner/private-fixture']},owner);
  const [link]=await query('SELECT id FROM link_resources WHERE post_id=$1',[post.id]);const [job]=await query("SELECT id FROM jobs WHERE kind='link' AND target_id=$1",[link.id]);
  const originalFetch=globalThis.fetch;let requests=0;
  try{
    globalThis.fetch=async()=>{requests++;return Response.json({private:true,visibility:'private',description:'PRIVATE-REPOSITORY-SECRET'});};
    await processJob(job.id);assert.equal(requests,1,'Private README must never be requested');
    const [failed]=await query('SELECT status,title,description,content FROM link_resources WHERE id=$1',[link.id]);assert.equal(failed.status,'failed');assert.equal(JSON.stringify(failed).includes('PRIVATE-REPOSITORY-SECRET'),false);
    await assert.rejects(execute('posts_get',{id:post.id},owner));assert.equal(JSON.stringify(await execute('posts_list',{},{})).includes('PRIVATE-REPOSITORY-SECRET'),false);
    await query("UPDATE jobs SET status='failed' WHERE id=$1",[job.id]);await execute('jobs_retry',{id:job.id},owner);
    globalThis.fetch=async input=>String(input).endsWith('/readme')?new Response('PUBLIC-README fixture'):Response.json({private:false,visibility:'public',full_name:'test-owner/public-fixture',description:'Public description',language:'TypeScript'});
    await processJob(job.id);await approveFixture(post);const success=await execute('posts_get',{id:post.id},owner);assert.equal(success.links[0].content,'PUBLIC-README fixture');assert.equal(success.links[0].status,'ready');
  }finally{globalThis.fetch=originalFetch;}
});
test('HTTP API and remote MCP use the same data; scoped token revocation takes effect',async()=>{
  const client=new Client({name:'community-test',version:'1.0.0'});
  await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`),{requestInit:{headers:{Authorization:`Bearer ${grant.token}`}}}));
  const tools=await client.listTools();assert.ok(tools.tools.some(t=>t.name==='search'));
  const result=await client.callTool({name:'posts_get',arguments:{id:publicPost}});const body=JSON.parse((result.content as {text:string}[])[0].text);assert.equal(body.id,publicPost);
  await client.close();
  const r=await fetch(`${base}/api/v1/posts/${publicPost}`,{headers:{Authorization:`Bearer ${grant.token}`}});assert.equal((await r.json()).id,publicPost);
  await execute('grants_revoke',{id:grant.id},owner);
  await assert.rejects(execute('posts_get',{id:publicPost},agent),/授权已失效/);
  assert.equal((await fetch(`${base}/api/v1/posts/${publicPost}`,{headers:{Authorization:`Bearer ${grant.token}`}})).status,401);
});
test('100 accounts with 20 concurrent authenticated HTTP sessions',async()=>{
  const loadEvent=await execute('events_create',{communityId:publicGroup,title:'负载测试活动',description:'测试',city:'杭州',address:'仅报名可见',startsAt:new Date(Date.now()+86400000).toISOString(),endsAt:new Date(Date.now()+90000000).toISOString(),capacity:20},owner);
  const tokens=[];for(let i=0;i<20;i++){const a={userId:`test-user-${i}`};await execute('communities_join',{id:publicGroup},a);tokens.push((await execute('grants_create',{name:'load-test',scopes:['content:read','posts:write','interactions:write','events:rsvp'],communityIds:[publicGroup],days:1},a)).token);}
  const samples:number[]=[];await Promise.all(tokens.map(async(token,index)=>{
    async function request(endpoint:string,method='GET',body?:unknown){const start=performance.now();const r=await fetch(`${base}/api/v1/${endpoint}`,{method,headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined});const result=await r.json();assert.equal(r.status,200,JSON.stringify(result));samples.push(performance.now()-start);return result;}
    const post=await request('posts','POST',{body:`LOAD-FLOW-${index} 测试动态`,idempotencyKey:`load-${index}`});
    await approveFixture(post);
    const comment=await request(`posts/${post.id}/comments`,'POST',{body:'并发评论',idempotencyKey:`comment-${index}`});await approveFixture(comment,'comment');
    await request(`posts/${post.id}/reactions`,'PUT',{kind:'like',active:true});
    assert.ok((await request(`search?q=LOAD-FLOW-${index}`)).posts.some((p:any)=>p.id===post.id));
    await request(`events/${loadEvent.id}/rsvp`,'PUT',{attending:true,...bookingDetails(`test-user-${index}`)});
    await request(`events/${loadEvent.id}/rsvp`,'PUT',{attending:true,...bookingDetails(`test-user-${index}`)});
    assert.equal((await request(`events/${loadEvent.id}`)).address,'仅报名可见');
    await request(`events/${loadEvent.id}/rsvp`,'PUT',{attending:false});
    assert.ok(Array.isArray((await request('posts?limit=5')).items));
  }));
  samples.sort((a,b)=>a-b);await mkdir('test-results',{recursive:true});await writeFile('test-results/load.json',JSON.stringify({accounts:100,concurrentSessions:20,requests:samples.length,failures:0,p95Ms:Math.round(samples[Math.floor(samples.length*.95)])},null,2));
});
test('CLI and stdio MCP can read the same source with an authorized token',async()=>{
  const grant=await execute('grants_create',{name:'cli-test',scopes:['content:read'],communityIds:[],days:1},owner);
  const env={...process.env,AICOMMUNITY_URL:base,AICOMMUNITY_TOKEN:grant.token};
  const {stdout}=await promisify(execFile)(process.execPath,['--import','tsx','src/cli/index.ts','--json','posts','get',publicPost],{env,windowsHide:true});assert.equal(JSON.parse(stdout).id,publicPost);
  const client=new Client({name:'stdio-test',version:'1.0.0'});const transport=new StdioClientTransport({command:process.execPath,args:['--import','tsx','src/mcp/stdio.ts'],env:env as Record<string,string>});
  await client.connect(transport);const result=await client.callTool({name:'posts_get',arguments:{id:publicPost}});assert.equal(JSON.parse((result.content as {text:string}[])[0].text).id,publicPost);await client.close();
});
test('OAuth authorization code + PKCE binds scopes, audience, grant and revocation',async()=>{
  const phone='+8613900000000';
  async function authRequest(path:string,method='GET',body?:unknown,cookie?:string,form=false){
    return auth.handler(new Request(`${base}/api/auth${path}`,{method,headers:{Origin:base,'X-Privacy-Version':PRIVACY_VERSION,...(cookie?{Cookie:cookie}:{}),...(body?{'Content-Type':form?'application/x-www-form-urlencoded':'application/json'}:{})},body:body?(form?String(body):JSON.stringify(body)):undefined}));
  }
  let response=await authRequest('/phone-number/send-otp','POST',{phoneNumber:phone});assert.equal(response.status,200);
  const [otp]=await query('SELECT count FROM usage_counters WHERE key=$1',[`dev-otp:${phone}`]);
  response=await authRequest('/phone-number/verify','POST',{phoneNumber:phone,code:String(otp.count).padStart(6,'0')});assert.equal(response.status,200);const cookie=response.headers.getSetCookie().map((s:string)=>s.split(';')[0]).join('; ');assert.ok(cookie);
  const redirect='http://127.0.0.1:8765/callback';
  response=await authRequest('/oauth2/register','POST',{client_name:'OAuth test client',application_type:'native',redirect_uris:[redirect],grant_types:['authorization_code','refresh_token'],response_types:['code'],token_endpoint_auth_method:'none',scope:'content:read offline_access',resources:[`${base}/mcp`]});const client=await response.json();assert.equal(response.status,201,JSON.stringify(client));
  const verifier=randomBytes(32).toString('base64url');const challenge=createHash('sha256').update(verifier).digest('base64url');
  const params=new URLSearchParams({client_id:client.client_id,redirect_uri:redirect,response_type:'code',scope:'content:read offline_access',resource:`${base}/mcp`,state:'test-state',code_challenge:challenge,code_challenge_method:'S256'});
  response=await authRequest(`/oauth2/authorize?${params}`,'GET',undefined,cookie);assert.ok([302,303].includes(response.status),await response.clone().text());const consentLocation=response.headers.get('location')!;assert.ok(consentLocation.includes('/consent'));
  const consentResponse=await http(new Request(`${base}/api/v1/oauth/consent`,{method:'POST',headers:{Cookie:cookie,Origin:base,'Content-Type':'application/json'},body:JSON.stringify({accept:true,communityIds:[],oauthQuery:new URL(consentLocation,base).search.slice(1)})}));
  const consent=await consentResponse.json();assert.equal(consentResponse.status,200,JSON.stringify(consent));const code=new URL(consent.redirect_uri).searchParams.get('code');assert.ok(code,JSON.stringify(consent));
  const [grant]=await query('SELECT id FROM agent_grants WHERE user_id=$1 AND oauth_client_id=$2 AND revoked_at IS NULL',[owner.userId,client.client_id]);assert.ok(grant);
  await query("UPDATE agent_grants SET scopes=ARRAY['content:read','posts:write'] WHERE id=$1",[grant.id]);
  const tokenParams=new URLSearchParams({grant_type:'authorization_code',client_id:client.client_id,redirect_uri:redirect,code:code!,code_verifier:verifier,resource:`${base}/mcp`});
  response=await authRequest('/oauth2/token','POST',tokenParams.toString(),undefined,true);const token=await response.json();assert.equal(response.status,200,JSON.stringify(token));assert.ok(token.access_token);
  const request=new Request(`${base}/mcp`,{method:'POST',headers:{Authorization:`Bearer ${token.access_token}`}});const a=await actorFromRequest(request,`${base}/mcp`);assert.equal(a.grantId,grant.id);assert.deepEqual(a.scopes,['content:read']);
  await assert.rejects(execute('posts_create',{body:'scope escalation'},a),/操作授权/);
  await assert.rejects(actorFromRequest(request,`${base}/api/v1`),/OAuth 令牌/);
  await execute('grants_revoke',{id:grant.id},owner);await assert.rejects(actorFromRequest(request,`${base}/mcp`),/撤销|过期/);
  if(token.refresh_token){const refresh=new URLSearchParams({grant_type:'refresh_token',client_id:client.client_id,refresh_token:token.refresh_token,resource:`${base}/mcp`});response=await authRequest('/oauth2/token','POST',refresh.toString(),undefined,true);assert.ok(response.status>=400);}
});
test('portable backup restores records and files to a separate PostgreSQL database',async()=>{
  const {createBackup,restoreBackup}=await import('../src/server/backup');const directory=path.join(root,'backup');await createBackup(directory,pool);
  await engine.createDatabase('restored');const target=new pg.Pool({connectionString:'postgresql://postgres:test-password@127.0.0.1:54331/restored'});
  const {getMigrations}=await import('better-auth/db/migration');await (await getMigrations({...auth.options,database:target})).runMigrations();
  for(const file of (await readdir('migrations')).filter(f=>f.endsWith('.sql')).sort())await target.query(await readFile(path.join('migrations',file),'utf8'));
  await target.query('CREATE TABLE schema_migrations(name text PRIMARY KEY,applied_at timestamptz DEFAULT now())');
  const restoredObjects=new Map<string,Buffer>();const result=await restoreBackup(directory,target,async(key,data)=>{restoredObjects.set(key,data);});
  assert.equal((await target.query('SELECT count(*)::int AS n FROM "user"')).rows[0].n,100);assert.equal(result.objects,1);assert.equal(restoredObjects.size,1);assert.equal((await target.query('SELECT count(*)::int AS n FROM agent_grants')).rows[0].n,(await query('SELECT count(*)::int AS n FROM agent_grants'))[0].n);
  assert.deepEqual((await target.query('SELECT event_id,user_id,attendee_name,phone_number FROM registrations ORDER BY event_id,user_id')).rows,await query('SELECT event_id,user_id,attendee_name,phone_number FROM registrations ORDER BY event_id,user_id'));
  await assert.rejects(restoreBackup(directory,target),/not empty/);await writeFile('test-results/restore.json',JSON.stringify({...result,users:100,verified:true},null,2));await target.end();
});
