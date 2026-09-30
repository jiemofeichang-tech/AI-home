import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { actorFromRequest,auth } from './auth';
import { execute } from './service';
import { query,transaction } from './db';
import { config } from './config';
import { contracts,scopes,AppError,fail,type Action } from '../shared/contracts';
import { readablePost,scope,user,human,active } from './permissions';
import { getObject,putObject,imageMime } from './storage';
import { consumeQuota } from './providers';
import { PRIVACY_VERSION,EVENT_CONTACT_RETENTION_DAYS } from '../shared/privacy';
import { exportOwnData,closeAccount,expireEventContactData,scheduleObjectDeletion } from './privacy';
import { stripImageMetadata,readImageUploadForm,withImageUploadSlot } from './image-privacy';
import { moderationMediaAccess } from './moderation';

export const routes:[string,string,Action][]=[
  ['GET','moderation','moderation_list'],['POST','admin/moderation/:id/decision','moderation_decide'],['POST','moderation/:id/appeal','moderation_appeal'],['POST','admin/moderation/:id/retry','moderation_retry'],['POST','moderation/:id/withdraw','moderation_withdraw'],
  ['GET','admin/invitations','invitations_list'],['POST','admin/invitations','invitations_create'],['DELETE','admin/invitations/:id','invitations_revoke'],
  ['POST','communities/:id/remove','communities_remove'],
  ['GET','posts','posts_list'],['POST','posts','posts_create'],['GET','posts/:id','posts_get'],['DELETE','posts/:id','posts_delete'],['POST','posts/:id/comments','comments_create'],['PUT','posts/:id/reactions','reactions_set'],
  ['GET','communities','communities_list'],['POST','communities','communities_create'],['GET','communities/:id','communities_get'],['POST','communities/:id/join','communities_join'],['POST','communities/:id/leave','communities_leave'],['GET','communities/:id/members','communities_members'],['POST','communities/:id/approve','communities_approve'],['PUT','communities/:id/announcement','communities_announcement'],
  ['GET','events','events_list'],['POST','events','events_create'],['GET','events/:id','events_get'],['PUT','events/:id/rsvp','events_rsvp'],['GET','events/:id/attendees','events_attendees'],['POST','events/:id/checkin','events_checkin'],['PATCH','events/:id','events_update'],
  ['GET','search','search'],['GET','profiles/:id','profile_get'],['PUT','profile','profile_update'],['PUT','profiles/:id/follow','follows_set'],['PUT','profiles/:id/block','blocks_set'],
  ['GET','grants','grants_list'],['POST','grants','grants_create'],['DELETE','grants/:id','grants_revoke'],['GET','notifications','notifications_list'],['POST','notifications/read','notifications_read'],['POST','posts/:id/report','reports_create'],['GET','admin','admin_overview'],['POST','admin/moderate','admin_moderate'],['POST','jobs/:id/retry','jobs_retry']
];
export function openapi() {
  const paths:Record<string,any>={};
  for(const [method,path,action] of routes) {
    const key=`/${path.replace(/:(\w+)/g,'{$1}')}`;const schema=z.toJSONSchema(contracts[action],{target:'openapi-3.0',io:'input'});
    const pathParams=[...path.matchAll(/:(\w+)/g)].map(m=>({name:m[1],in:'path',required:true,schema:{type:'string'}}));
    const queryParams=method==='GET'?Object.entries(schema.properties||{}).filter(([name])=>!pathParams.some(p=>p.name===name)).map(([name,value])=>({name,in:'query',required:schema.required?.includes(name)||false,schema:value})):[];
    for(const parameter of pathParams){if(schema.properties)delete schema.properties[parameter.name];schema.required=schema.required?.filter(name=>name!==parameter.name);}
    const publicRead=['posts_list','posts_get','communities_list','communities_get','events_list','events_get','search','profile_get'].includes(action);
    (paths[key]||={})[method.toLowerCase()]={operationId:action,parameters:[...pathParams,...queryParams],...(!['GET','DELETE'].includes(method)?{requestBody:{required:true,content:{'application/json':{schema}}}}:{}),responses:{200:{description:'成功',content:{'application/json':{schema:{type:'object'}}}},401:{description:'需要登录或授权'},403:{description:'没有操作权限'},409:{description:'名额已满或幂等冲突'}},security:[{bearerAuth:[]},...(publicRead?[{}]:[])]};
  }
  return {openapi:'3.0.3',info:{title:'AI 社区 API',version:'0.1.0'},servers:[{url:`${config.url}/api/v1`}],paths,components:{securitySchemes:{bearerAuth:{type:'http',scheme:'bearer'}}}};
}
function checkOrigin(request:Request) {
  if(['GET','HEAD','OPTIONS'].includes(request.method)||request.headers.has('authorization')) return;
  const origin=request.headers.get('origin');if(origin!==new URL(config.url).origin) fail(403,'不允许跨站操作');
}
export function errorResponse(error:unknown,resource='api/v1') {
  const known=error instanceof AppError;const status=known?error.status:500;
  if(!known) console.error(error instanceof Error?error.message:error);
  return Response.json({error:known?error.message:'服务暂时不可用，请稍后重试',code:known?error.code:'INTERNAL_ERROR'},{status,headers:{'Cache-Control':'no-store',...(status===401?{'WWW-Authenticate':`Bearer resource_metadata="${config.url}/.well-known/oauth-protected-resource/${resource}"`}:{})}});
}
export async function handleApi(request:Request) {
  try {
    checkOrigin(request);const url=new URL(request.url);const path=url.pathname.replace(/^\/api\/v1\/?/,'');
    if(path==='openapi.json'&&request.method==='GET') return Response.json(openapi());
    if(path==='health'&&request.method==='GET') {await query('SELECT 1');return Response.json({ok:true,version:'0.1.0'});}
    if(path==='privacy/policy'&&request.method==='GET')return Response.json({version:PRIVACY_VERSION,operator:config.privacyOperator,contact:config.privacyContact,contactRetentionDays:EVENT_CONTACT_RETENTION_DAYS},{headers:{'Cache-Control':'no-store'}});
    // These personal-data rights remain available to suspended members. They
    // require a browser session and deliberately bypass Agent tokens/actions.
    if(path.startsWith('privacy/')) {
      if(request.headers.has('authorization'))fail(403,'个人信息操作需要本人登录网页完成');
      const session=await auth.api.getSession({headers:request.headers});
      if(!session)fail(401,'请先登录');
      const owner={userId:session.user.id};
      const [profile]=await query('SELECT privacy_version,privacy_accepted_at FROM profiles WHERE user_id=$1 AND deleted_at IS NULL',[owner.userId]);
      if(!profile)fail(401,'账户已注销，请重新登录');
      if(path==='privacy/export'&&request.method==='GET')return Response.json(await exportOwnData(owner),{headers:{'Cache-Control':'no-store','Content-Disposition':'attachment; filename="my-community-data.json"'}});
      if(path==='privacy/account'&&request.method==='GET') {
        await expireEventContactData();
        const registrations=await query('SELECT r.event_id,e.title AS event_title,r.attendee_name,r.phone_number,r.created_at,r.checked_in_at FROM registrations r JOIN events e ON e.id=r.event_id WHERE r.user_id=$1 ORDER BY e.starts_at DESC',[owner.userId]);
        const [contact]=await query('SELECT "phoneNumber" FROM "user" WHERE id=$1',[owner.userId]);
        const phone=String(contact?.phoneNumber||'');
        return Response.json({phoneMask:phone?`${phone.slice(0,6)}****${phone.slice(-4)}`:'未绑定',registrations,privacyVersion:profile.privacy_version,acceptedAt:profile.privacy_accepted_at,freshSession:new Date(session.session.createdAt).getTime()>Date.now()-10*60*1000},{headers:{'Cache-Control':'no-store'}});
      }
      if(path==='privacy/contacts'&&request.method==='DELETE') {
        const body=await request.json();const input=z.object({eventId:z.string().min(1).max(128).optional()}).strict().safeParse(body);if(!input.success)fail(400,'请选择要清除资料的活动');
        const rows=await query('UPDATE registrations SET attendee_name=NULL,phone_number=NULL,contact_consent_version=NULL,contact_consented_at=NULL WHERE user_id=$1 AND ($2::text IS NULL OR event_id=$2) RETURNING event_id',[owner.userId,input.data.eventId||null]);
        return Response.json({ok:true,cleared:rows.length},{headers:{'Cache-Control':'no-store'}});
      }
      if(path==='privacy/clear-profile'&&request.method==='POST') {
        await transaction(async client=>{await query('SELECT user_id FROM profiles WHERE user_id=$1 FOR UPDATE',[owner.userId],client);await query("DELETE FROM content_draft_heads WHERE kind='profile' AND target_id=$1",[owner.userId],client);await query("UPDATE content_drafts SET status='deleted',payload='{}' WHERE author_id=$1 AND kind='profile'",[owner.userId],client);await query('UPDATE "user" SET name=$2,image=NULL WHERE id=$1',[owner.userId,`社区成员${randomUUID().slice(0,6)}`],client);await query("UPDATE profiles SET bio='',city='' WHERE user_id=$1",[owner.userId],client);});
        return Response.json({ok:true},{headers:{'Cache-Control':'no-store'}});
      }
      if(path==='privacy/withdraw-image-ai'&&request.method==='POST') {
        await transaction(async client=>{
          // Wait for older search-index writes before clearing their source,
          // so a delayed indexing request cannot restore withdrawn OCR text.
          await query('SELECT id FROM posts WHERE author_id=$1 ORDER BY id FOR UPDATE',[owner.userId],client);
          const media=await query("UPDATE media SET ai_consent=false,extracted_text='',description='',status='ready',error=NULL WHERE owner_id=$1 RETURNING id,post_id",[owner.userId],client);
          await query("DELETE FROM jobs WHERE kind='image' AND target_id=ANY($1::text[])",[media.map(item=>item.id)],client);
          for(const postId of new Set(media.map(item=>item.post_id).filter(Boolean)))await query("INSERT INTO jobs(id,kind,target_id) VALUES($1,'index',$2) ON CONFLICT(kind,target_id) DO UPDATE SET status='pending',attempts=0,error=NULL,available_at=now()",[randomUUID(),postId],client);
        });
        return Response.json({ok:true},{headers:{'Cache-Control':'no-store'}});
      }
      if(path==='privacy/close'&&request.method==='POST') {
        const body=z.object({confirmation:z.literal('注销我的账号')}).safeParse(await request.json());if(!body.success)fail(400,'请输入“注销我的账号”确认此次操作');
        if(new Date(session.session.createdAt).getTime()<Date.now()-10*60*1000)fail(403,'为保护账号，请重新通过手机验证码登录后，在 10 分钟内完成注销','FRESH_LOGIN_REQUIRED');
        return Response.json(await closeAccount(owner),{headers:{'Cache-Control':'no-store'}});
      }
      fail(404,'个人信息接口不存在');
    }
    const actor=await actorFromRequest(request);
    if(path==='me'&&request.method==='GET') {
      const [profile]=actor.userId?await query(`SELECT u.id,u.name,u.image,p.handle,p.bio,p.city,p.role FROM "user" u JOIN profiles p ON p.user_id=u.id WHERE u.id=$1`,[actor.userId]):[];
      return Response.json({user:profile||null,dev:config.dev,inviteOnly:config.inviteOnly},{headers:{'Cache-Control':'no-store'}});
    }
    if(path==='dev-otp'&&request.method==='GET') {
      if(!config.dev||!['localhost','127.0.0.1'].includes(url.hostname)) fail(404,'Not found');
      const [otp]=await query(`SELECT count FROM usage_counters WHERE key=$1 AND updated_at>now()-interval '5 minutes'`,[`dev-otp:${url.searchParams.get('phone')}`]);
      return Response.json({code:otp?String(otp.count).padStart(6,'0'):null},{headers:{'Cache-Control':'no-store'}});
    }
    if(path==='media'&&request.method==='POST') {
      scope(actor,'posts:write');return await withImageUploadSlot(request,async()=>{
        const form=await readImageUploadForm(request);const file=form.get('file');if(!(file instanceof File)||file.size>10*1024*1024) fail(400,'请上传不超过 10 MB 的图片');
        const original=Buffer.from(await file.arrayBuffer());const mime=imageMime(original);if(!mime) fail(400,'仅支持 PNG、JPG、WebP 和 GIF 图片');
        const bytes=await stripImageMetadata(original);const aiConsent=form.get('aiConsent')==='true';
        await consumeQuota(`upload:${actor.userId}:${new Date().toISOString().slice(0,10)}`,Number(process.env.USER_DAILY_IMAGE_LIMIT||20));
        const id=randomUUID();const ext=mime==='image/jpeg'?'jpg':mime.split('/')[1];const key=`images/${id}.${ext}`;
        let objectAttempted=false;
        try{await transaction(async client=>{
          await active(actor,client);objectAttempted=true;await putObject(key,bytes,mime);
          await query("INSERT INTO media(id,owner_id,storage_key,mime,bytes,original_name,ai_consent,status) VALUES($1,$2,$3,$4,$5,$6,$7,$8)",[id,actor.userId,key,mime,bytes.length,`image.${ext}`,aiConsent,aiConsent?'pending':'ready'],client);
        });}catch(error){if(objectAttempted)await scheduleObjectDeletion(key);throw error;}
        return Response.json({id,url:`/api/v1/media/${id}`});
      });
    }
    if(path.startsWith('moderation/media/')&&request.method==='GET') {
      const [m]=await query('SELECT * FROM media WHERE id=$1',[path.split('/')[2]]);if(!m)fail(404,'图片不存在');
      if(!await moderationMediaAccess(actor,m))fail(404,'图片不可见');
      const data=await getObject(m.storage_key);return new Response(new Uint8Array(data),{headers:{'Content-Type':m.mime,'Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff'}});
    }
    if(path.startsWith('media/')&&request.method==='GET') {
      const [m]=await query('SELECT * FROM media WHERE id=$1',[path.split('/')[1]]);if(!m) fail(404,'图片不存在');
      if(actor.grantId) scope(actor,'content:read');
      if(m.post_id) await readablePost(actor,m.post_id);else if(m.owner_id!==user(actor)) fail(403,'无权读取图片');
      const data=await getObject(m.storage_key);return new Response(new Uint8Array(data),{headers:{'Content-Type':m.mime,'Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff'}});
    }
    if(path==='oauth/consent'&&request.method==='POST') {
      human(actor);const body=await request.json();const oauthQuery=String(body.oauthQuery||'');const params=new URLSearchParams(oauthQuery);const clientId=params.get('client_id');if(!clientId) fail(400,'授权请求无效');
      const client=await auth.api.getOAuthClientPublic({headers:request.headers,query:{client_id:clientId}});
      const response=await auth.handler(new Request(`${config.url}/api/auth/oauth2/consent`,{method:'POST',headers:request.headers,body:JSON.stringify({accept:!!body.accept,oauth_query:oauthQuery})}));
      const result=await response.json();
      if(!response.ok) fail(response.status,'OAuth 授权请求无效或已过期，请重新连接');
      const redirectUri=result.redirect_uri || ('url' in result?String(result.url):'');
      if(!redirectUri) fail(400,'授权服务未返回有效的回调地址');
      if(body.accept && new URL(redirectUri).searchParams.has('code')) {
        const requested=(params.get('scope')||'').split(' ').filter(s=>(scopes as readonly string[]).includes(s));
        await execute('grants_create',{name:client.client_name||'MCP 客户端',scopes:requested.length?requested:['content:read'],communityIds:body.communityIds||[],days:30,oauthClientId:clientId},actor);
      }
      return Response.json({redirect_uri:redirectUri},{headers:{'Cache-Control':'no-store'}});
    }
    if(path.startsWith('actions/')&&request.method==='POST') {
      const action=path.split('/')[1] as Action;if(!(action in contracts)) fail(404,'接口不存在');
      const result=await execute(action,await request.json(),actor);return Response.json(result,{headers:{'Cache-Control':'no-store'}});
    }
    for(const [method,template,action] of routes) {
      if(method!==request.method) continue;
      const names:string[]=[];const regex=new RegExp(`^${template.replace(/:(\w+)/g,(_,name)=>{names.push(name);return '([^/]+)';})}$`);const match=path.match(regex);if(!match) continue;
      const params=Object.fromEntries(names.map((name,i)=>[name,decodeURIComponent(match[i+1])]));
      const body=['GET','DELETE'].includes(method)?Object.fromEntries(url.searchParams):await request.json();
      if(request.headers.has('idempotency-key')) body.idempotencyKey=request.headers.get('idempotency-key');
      const result=await execute(action,{...body,...params},actor);return Response.json(result,{headers:{'Cache-Control':'no-store'}});
    }
    fail(404,'接口不存在');
  } catch(error) {return errorResponse(error);}
}
