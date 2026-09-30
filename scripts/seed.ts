import { query,pool } from '../src/server/db';
import { config } from '../src/server/config';
export async function seed(){
  if(!config.dev) throw new Error('Demo data can only be seeded with DEV_MODE=true');
  if((await query(`SELECT 1 FROM "user" WHERE id='demo-lin'`)).length)return;
  const users=[['demo-lin','林一','13800000001','杭州','把想法做成可以使用的小工具。关注 AI 编程与社区。'],['demo-xu','许知远','13800000002','上海','开源工具爱好者，正在探索 Agent 工作流。'],['demo-qiao','乔乔','13800000003','杭州','用 AI 记录日常，也用 AI 创作。'],['demo-chen','陈默','13800000004','北京','设计师 / 独立开发者。一起把小想法变成作品。']];
  for(const [id,name,phone,city,bio] of users){await query(`INSERT INTO "user"(id,name,email,"emailVerified","phoneNumber","phoneNumberVerified","createdAt","updatedAt") VALUES($1,$2,$3,true,$4,true,now(),now())`,[id,name,`${id}@demo.invalid`,`+86${phone}`]);await query(`INSERT INTO profiles(user_id,handle,city,bio,role) VALUES($1,$2,$3,$4,$5)`,[id,id.replace('demo-',''),city,bio,id==='demo-lin'?'admin':'member']);}
  const cs=[['hangzhou','杭州 AI 创造者','周末一起做点东西。分享工具、交流实践，也把线上认识的朋友带到线下。','杭州','public','demo-lin'],['shanghai','上海 Agent 实验室','探索 Agent 如何进入真实工作流。欢迎带上你的项目与问题。','上海','public','demo-xu'],['beijing','北京 AI 产品小组','聊产品，也写代码。面向设计师、开发者和好奇的创造者。','北京','public','demo-chen'],['workshop','共创工作室','小范围交换还没发布的作品，互相测试与反馈。','杭州','private','demo-lin']];
  for(const [id,name,description,city,visibility,owner] of cs){await query('INSERT INTO communities(id,name,description,city,visibility,owner_id) VALUES($1,$2,$3,$4,$5,$6)',[id,name,description,city,visibility,owner]);await query(`INSERT INTO memberships(community_id,user_id,role,status) VALUES($1,$2,'admin','active')`,[id,owner]);}
  await query(`INSERT INTO memberships(community_id,user_id,role,status) VALUES('hangzhou','demo-qiao','member','active'),('hangzhou','demo-xu','member','active'),('shanghai','demo-lin','member','active'),('workshop','demo-qiao','member','active')`);
  await query(`UPDATE communities SET announcement='欢迎加入！发帖时可以带上你用到的工具、过程和真实体验。这里的初始帖子是本地演示数据。' WHERE id='hangzhou'`);
  const posts=[
    ['welcome','demo-lin',null,'欢迎来到 AI 社区 👋\n\n这里想聚集一小群真正用 AI 做事的人。可以分享一个刚发现的工具、一段踩坑经历，或者你正在做的作品。\n\n先从一个问题开始：最近，AI 帮你完成的最有成就感的一件事是什么？\n\n[本地演示内容]',['社区日常'],'20 minutes'],
    ['mcp-project','demo-xu',null,'给正在搭建 Agent 的朋友分享一个开源项目。\n\nMCP 的官方 TypeScript SDK，把工具、资源和客户端连接的例子放在了一起。准备在周末做一个读取社区内容的小助手。\n\n有人想一起试试吗？ #Agent #开源\n\n[本地演示内容]',['Agent','开源'],'2 hours'],
    ['hangzhou-meet','demo-qiao','hangzhou','不如这个周末，我们各自带一个小想法，现场用 AI 做出来？\n\n不用准备完整的分享，也不用是技术大神。一个你觉得“要是有这个就好了”的问题就够了。\n\n#杭州 #一起做点东西\n\n[本地演示内容]',['杭州','一起做点东西'],'4 hours'],
    ['workflow','demo-chen',null,'最近在记录自己的 AI 工作流，发现最值得分享的往往不是最后那张漂亮的图，而是中间改了什么、为什么改。\n\n所以想开一个「过程分享」话题：贴上你的尝试，我们一起讨论。 #创作 #工作流\n\n[本地演示内容]',['创作','工作流'],'8 hours']
  ];
  for(const [id,author,community,body,tags,age] of posts) await query(`INSERT INTO posts(id,author_id,community_id,body,tags,created_at,moderation_status) VALUES($1,$2,$3,$4,$5,now()-$6::interval,'approved')`,[id,author,community,body,tags,age]);
  await query(`INSERT INTO link_resources(id,post_id,url,platform,status) VALUES('demo-mcp-link','mcp-project','https://github.com/modelcontextprotocol/typescript-sdk','github','pending')`);
  await query(`INSERT INTO jobs(id,kind,target_id) VALUES('seed-link','link','demo-mcp-link')`);
  await query(`INSERT INTO comments(id,post_id,author_id,body,moderation_status) VALUES('demo-comment','welcome','demo-qiao','我用 AI 做了一个旅行照片整理工具！期待在这里分享过程。','approved')`);
  await query(`INSERT INTO moderation_cases(id,target_type,target_id,author_id,status,labels,provider)
    SELECT gen_random_uuid()::text,'post',id,author_id,'approved',ARRAY['legacy'],'legacy' FROM posts WHERE id=ANY($1::text[])`,[posts.map(post=>post[0])]);
  await query(`INSERT INTO moderation_cases(id,target_type,target_id,author_id,status,labels,provider)
    SELECT gen_random_uuid()::text,'comment',id,author_id,'approved',ARRAY['legacy'],'legacy' FROM comments WHERE id='demo-comment'`);
  await query(`INSERT INTO reactions(post_id,user_id,kind) VALUES('welcome','demo-xu','like'),('welcome','demo-qiao','like'),('mcp-project','demo-lin','like')`);
  for(const [id,c,owner,title,desc,city,address,days,capacity] of [['demo-hz-event','hangzhou','demo-lin','周末 AI 共创小聚','带上电脑和一个小想法，一起把它变成可以运行的作品。\n流程：自我介绍 → 两小时共创 → 展示和交流。\n[本地演示活动，不是真实活动邀约]','杭州','演示地址：杭州创作空间，报名后可见',5,20],['demo-sh-event','shanghai','demo-xu','Agent 工作流交流夜','交流已经跑起来的 Agent 工作流，也讨论尚未解决的问题。\n[本地演示活动，不是真实活动邀约]','上海','演示地址：上海开放工坊，报名后可见',8,15]]) {
    await query(`INSERT INTO events(id,community_id,organizer_id,title,description,city,address,starts_at,ends_at,capacity) VALUES($1,$2,$3,$4,$5,$6,$7,now()+($8||' days')::interval,now()+($8||' days')::interval+interval '3 hours',$9)`,[id,c,owner,title,desc,city,address,String(days),capacity]);
  }
  await query(`INSERT INTO registrations(event_id,user_id) VALUES('demo-hz-event','demo-qiao')`);
  console.log('Local demo content seeded.');
}
if(process.argv[1]?.endsWith('seed.ts')){await seed();await pool.end();}
