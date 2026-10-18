import { after,before,test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdir,mkdtemp,readdir,readFile } from 'node:fs/promises';
import path from 'node:path';
import EmbeddedPostgres from 'embedded-postgres';
import pg from 'pg';
import type { Actor } from '../src/shared/contracts';
import { approvedFixtures } from './moderation-fixtures';

const base='http://localhost:3197';
const admin:Actor={userId:'topic-admin'},member:Actor={userId:'topic-member'},newcomer:Actor={userId:'topic-newcomer'};
let engine:EmbeddedPostgres,pool:pg.Pool,query:any,execute:any,rawExecute:any,auth:any,actorFromRequest:any,root:string;
let adminAgent:Actor,memberAgent:Actor,community:string;

before(async()=>{
  await mkdir('.local',{recursive:true});root=await mkdtemp(path.resolve('.local','topics-test-'));
  Object.assign(process.env,{DEV_MODE:'true',APP_URL:base,DATABASE_URL:'postgresql://postgres:test-password@127.0.0.1:54345/postgres',BETTER_AUTH_SECRET:randomBytes(40).toString('hex'),STORAGE_DRIVER:'local',LOCAL_STORAGE_DIR:path.join(root,'uploads'),REDIS_URL:'',MEILI_URL:'',DB_POOL_SIZE:'10',CONTENT_MODERATION_PROVIDER:'manual'});
  engine=new EmbeddedPostgres({databaseDir:path.join(root,'db'),user:'postgres',password:'test-password',port:54345,persistent:true,initdbFlags:['--encoding=UTF8','--locale=C'],postgresFlags:['-h','127.0.0.1'],onLog:()=>{},onError:()=>{}});
  await engine.initialise();await engine.start();
  ({pool,query}=await import('../src/server/db'));({execute:rawExecute}=await import('../src/server/service'));({auth,actorFromRequest}=await import('../src/server/auth'));
  await (await import('../scripts/migrate')).migrate();
  ({execute}=approvedFixtures(rawExecute,query,(await import('../src/server/moderation')).moderationDecide,admin));
  for(const [actor,name,role] of [[admin,'板块管理员','admin'],[member,'板块成员','member'],[newcomer,'新成员','member']] as const) {
    await query(`INSERT INTO "user"(id,name,email,"emailVerified","createdAt","updatedAt") VALUES($1,$2,$3,true,now(),now())`,[actor.userId,name,`${actor.userId}@example.invalid`]);
    await query('INSERT INTO profiles(user_id,handle,role) VALUES($1,$2,$3)',[actor.userId,actor.userId,role]);
  }
  community=(await execute('communities_create',{name:'板块测试社群',description:'测试专用',city:'杭州',visibility:'public'},admin)).id;
  const agentFor=async(owner:Actor)=>{
    const grant=await execute('grants_create',{name:'板块测试 Agent',scopes:['content:read','posts:write'],days:1},owner);
    return actorFromRequest(new Request(`${base}/api/v1/posts`,{headers:{Authorization:`Bearer ${grant.token}`}}));
  };
  adminAgent=await agentFor(admin);memberAgent=await agentFor(member);
},{timeout:120000});

after(async()=>{if(pool)await pool.end();if(engine)await engine.stop();});

test('default boards are ordered, readable without login and report who may post',async()=>{
  const guest=await execute('topics_list',{},{});
  assert.deepEqual(guest.items.map((topic:any)=>topic.id),['announcements','introductions','projects','questions','resources','collaboration','cafe']);
  assert.ok(guest.items.every((topic:any)=>topic.canPost===false));
  const forMember=new Map((await execute('topics_list',{},member)).items.map((topic:any)=>[topic.id,topic.canPost]));
  assert.equal(forMember.get('introductions'),true);assert.equal(forMember.get('announcements'),false);
  assert.equal((await execute('topics_get',{id:'announcements'},admin)).canPost,true);
  assert.equal((await execute('topics_get',{id:'announcements'},adminAgent)).canPost,false,'admin-only boards never accept Agent posts');
  assert.equal((await execute('topics_get',{id:'projects'},memberAgent)).canPost,true);
  assert.equal((await execute('topics_get',{id:'projects'},{})).slug,'projects');
});

test('board posts carry titles, filter by board and are searchable by title',async()=>{
  const post=await execute('posts_create',{title:'TITLE-NEEDLE 周末做的小工具',body:'正文只描述过程',topicId:'projects'},member);
  const view=await execute('posts_get',{id:post.id},member);
  assert.equal(view.title,'TITLE-NEEDLE 周末做的小工具');
  assert.deepEqual(view.topic,{id:'projects',slug:'projects',name:'项目展示',icon:'🚀'});
  assert.ok((await execute('posts_list',{topicId:'projects'},member)).items.some((item:any)=>item.id===post.id));
  assert.equal((await execute('posts_list',{topicId:'questions'},member)).items.some((item:any)=>item.id===post.id),false);
  assert.ok((await execute('search',{q:'TITLE-NEEDLE'},admin)).posts.some((item:any)=>item.id===post.id));
  assert.equal((await execute('topics_get',{id:'projects'},member)).post_count,1);
  const agentPost=await execute('posts_create',{title:'Agent 代发的问题',body:'怎么配置 MCP？',topicId:'questions'},memberAgent);
  const agentView=await execute('posts_get',{id:agentPost.id},member);
  assert.equal(agentView.topic.id,'questions');assert.equal(agentView.agent_name,'板块测试 Agent');
  await assert.rejects(rawExecute('posts_create',{title:'',body:''},member),/请输入内容/);
});

test('admin-only boards reject members and agents; boards cannot be combined with communities',async()=>{
  await assert.rejects(rawExecute('posts_create',{body:'成员不能发公告',topicId:'announcements'},member),/仅平台管理员本人可以发布/);
  await assert.rejects(rawExecute('posts_create',{body:'Agent 不能代发公告',topicId:'announcements'},adminAgent),/仅平台管理员本人可以发布/);
  const notice=await execute('posts_create',{title:'社区公告',body:'本周六线下活动',topicId:'announcements'},admin);
  assert.equal((await execute('posts_get',{id:notice.id},member)).topic.id,'announcements');
  await execute('communities_join',{id:community},member);
  await assert.rejects(rawExecute('posts_create',{body:'不能同时选择',topicId:'projects',communityId:community},member),/不能同时发布到社群/);
  await assert.rejects(rawExecute('posts_create',{body:'不存在的板块',topicId:'missing-board'},member),/板块不存在或已归档/);
});

test('administrators manage boards; slugs stay unique and archived boards stop accepting posts',async()=>{
  const input={slug:'ai-video',name:'AI 视频',description:'视频生成与剪辑实践',icon:'🎬',section:'share',position:55,posting:'members',archived:false};
  await assert.rejects(rawExecute('topics_save',input,member),/需要平台管理员权限/);
  await assert.rejects(rawExecute('topics_save',input,adminAgent),/本人在网页中完成/);
  const created=await execute('topics_save',input,admin);
  assert.deepEqual((await execute('topics_list',{},member)).items.map((topic:any)=>topic.slug).slice(4,6),['resources','ai-video']);
  await assert.rejects(rawExecute('topics_save',{...input,name:'重复标识'},admin),/板块标识已被使用/);
  const post=await execute('posts_create',{body:'归档前的帖子',topicId:created.id},member);
  await execute('topics_save',{...input,id:created.id,archived:true},admin);
  assert.equal((await execute('topics_list',{},member)).items.some((topic:any)=>topic.id===created.id),false);
  assert.equal((await execute('topics_list',{includeArchived:'true'},member)).items.some((topic:any)=>topic.id===created.id),false,'only administrators see archived boards');
  assert.ok((await execute('topics_list',{includeArchived:true},admin)).items.some((topic:any)=>topic.id===created.id&&topic.archived_at));
  await assert.rejects(rawExecute('topics_get',{id:'ai-video'},member),/已归档/);
  await assert.rejects(rawExecute('posts_create',{body:'归档后不能发',topicId:created.id},member),/已归档/);
  assert.equal((await execute('posts_get',{id:post.id},member)).topic.id,created.id,'existing posts keep their board');
  const audit=await query("SELECT action FROM audit_logs WHERE target_id=$1 ORDER BY created_at",[created.id]);
  assert.deepEqual(audit.map((row:any)=>row.action),['topics_create','topics_update']);
});

test('onboarding reports published progress, pending reviews and can be dismissed',async()=>{
  assert.deepEqual(await execute('onboarding_get',{},{}),{guest:true,dismissed:false,completed:0,total:4,steps:[]});
  const status=async()=>{const result=await execute('onboarding_get',{},newcomer);return {...result,map:Object.fromEntries(result.steps.map((step:any)=>[step.key,step]))};};
  let state=await status();
  assert.equal(state.completed,0);assert.equal(state.total,4);assert.deepEqual(Object.keys(state.map),['profile','introduce','community','engage','agent']);
  assert.equal(state.map.agent.optional,true);
  await rawExecute('profile_update',{name:'新成员',bio:'做产品，也写一点代码',city:'杭州'},newcomer);
  state=await status();assert.equal(state.map.profile.done,false);assert.equal(state.map.profile.pending,true,'profile edits under review are pending');
  await execute('profile_update',{name:'新成员',bio:'做产品，也写一点代码',city:'杭州'},newcomer);
  const intro=await rawExecute('posts_create',{title:'大家好，我是新成员',body:'📍 所在城市：杭州',topicId:'introductions'},newcomer);
  state=await status();assert.equal(state.map.profile.done,true);assert.equal(state.map.introduce.done,false);assert.equal(state.map.introduce.pending,true);
  const [entry]=await query('SELECT id FROM moderation_cases WHERE id=$1',[intro.moderationId]);
  await (await import('../src/server/moderation')).moderationDecide(admin,{id:entry.id,decision:'approve',reason:'测试通过'});
  await execute('communities_join',{id:community},newcomer);
  const [someone]=(await execute('posts_list',{topicId:'projects'},newcomer)).items;
  await execute('reactions_set',{id:someone.id,kind:'like',active:true},newcomer);
  state=await status();
  assert.equal(state.completed,4);assert.equal(state.map.agent.done,false);
  await assert.rejects(rawExecute('onboarding_get',{},memberAgent),/本人在网页中完成/);
  assert.deepEqual(await execute('onboarding_dismiss',{},newcomer),{ok:true,dismissed:true});
  assert.equal((await status()).dismissed,true);
  await execute('onboarding_dismiss',{dismissed:false},newcomer);
  assert.equal((await status()).dismissed,false);
});

test('restoring a backup replaces migration-seeded boards with the snapshot copy',async()=>{
  const {createBackup,restoreBackup}=await import('../src/server/backup');
  await execute('topics_save',{id:'cafe',slug:'cafe',name:'咖啡角',description:'改过名字的默认板块',icon:'☕',section:'connect',position:70,posting:'members',archived:false},admin);
  const directory=path.join(root,'backup');await createBackup(directory,pool);
  await engine.createDatabase('restored');const target=new pg.Pool({connectionString:'postgresql://postgres:test-password@127.0.0.1:54345/restored'});
  try {
    const {getMigrations}=await import('better-auth/db/migration');await (await getMigrations({...auth.options,database:target})).runMigrations();
    for(const file of (await readdir('migrations')).filter(f=>f.endsWith('.sql')).sort())await target.query(await readFile(path.join('migrations',file),'utf8'));
    await target.query('CREATE TABLE schema_migrations(name text PRIMARY KEY,applied_at timestamptz DEFAULT now())');
    assert.equal((await target.query("SELECT name FROM topics WHERE id='cafe'")).rows[0].name,'咖啡馆','fresh target starts with seeded defaults');
    await restoreBackup(directory,target,async()=>{});
    const columns='id,slug,name,description,icon,section,position,posting,archived_at';
    assert.deepEqual((await target.query(`SELECT ${columns} FROM topics ORDER BY id`)).rows,await query(`SELECT ${columns} FROM topics ORDER BY id`));
    assert.deepEqual((await target.query('SELECT id,topic_id,title FROM posts ORDER BY id')).rows,await query('SELECT id,topic_id,title FROM posts ORDER BY id'));
    await assert.rejects(restoreBackup(directory,target,async()=>{}),/not empty/);
  } finally {await target.end();}
});
