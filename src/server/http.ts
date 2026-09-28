import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { actorFromRequest,auth } from './auth';
import { execute } from './service';
import { query } from './db';
import { config } from './config';
import { contracts,scopes,AppError,fail,type Action } from '../shared/contracts';
import { readablePost,scope,user,human } from './permissions';
import { getObject,putObject,imageMime } from './storage';
import { consumeQuota } from './providers';

export const routes:[string,string,Action][]=[
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
    const actor=await actorFromRequest(request);
    if(path==='me'&&request.method==='GET') {
      const [profile]=actor.userId?await query(`SELECT u.id,u.name,u.image,p.handle,p.bio,p.city,p.role FROM "user" u JOIN profiles p ON p.user_id=u.id WHERE u.id=$1`,[actor.userId]):[];
      return Response.json({user:profile||null,dev:config.dev},{headers:{'Cache-Control':'no-store'}});
    }
    if(path==='dev-otp'&&request.method==='GET') {
      if(!config.dev||!['localhost','127.0.0.1'].includes(url.hostname)) fail(404,'Not found');
      const [otp]=await query(`SELECT count FROM usage_counters WHERE key=$1 AND updated_at>now()-interval '5 minutes'`,[`dev-otp:${url.searchParams.get('phone')}`]);
      return Response.json({code:otp?String(otp.count).padStart(6,'0'):null},{headers:{'Cache-Control':'no-store'}});
    }
    if(path==='media'&&request.method==='POST') {
      scope(actor,'posts:write');const length=Number(request.headers.get('content-length')||0);if(length>10*1024*1024+100000) fail(413,'单张图片不能超过 10 MB');
      const form=await request.formData();const file=form.get('file');if(!(file instanceof File)||file.size>10*1024*1024) fail(400,'请上传不超过 10 MB 的图片');
      const bytes=Buffer.from(await file.arrayBuffer());const mime=imageMime(bytes);if(!mime) fail(400,'仅支持 PNG、JPG、WebP 和 GIF 图片');
      await consumeQuota(`upload:${actor.userId}:${new Date().toISOString().slice(0,10)}`,Number(process.env.USER_DAILY_IMAGE_LIMIT||20));
      const id=randomUUID();const ext=mime==='image/jpeg'?'jpg':mime.split('/')[1];const key=`images/${id}.${ext}`;await putObject(key,bytes,mime);
      await query('INSERT INTO media(id,owner_id,storage_key,mime,bytes,original_name) VALUES($1,$2,$3,$4,$5,$6)',[id,actor.userId,key,mime,file.size,file.name.slice(0,200)]);
      return Response.json({id,url:`/api/v1/media/${id}`});
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
