import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { query, transaction } from './db';
import { active, adminAccess, human, readablePost,unavailablePostSQL } from './permissions';
import { queueContentIndex } from './admin-content';
import { fail, type Actor, type Item } from '../shared/contracts';
import { moderateContent, moderationProviderStatus, ModerationTransientError } from './moderation-provider';
import { readModerationDraft, applyModerationDraft } from './moderation-drafts';
import { extractWebUrls,isLoginPageUrl } from '../shared/links';
import { isVideoMime } from '../shared/video';

type TargetType='post'|'comment'|'draft'|'media'|'link';
type Status='pending'|'review'|'rejected'|'approved'|'deleted';
type Case={id:string;target_type:TargetType;target_id:string;author_id:string;status:Status;labels:string[];reason:string;appeal_reason:string;provider:string;reviewed_by:string|null;revision:number;generation:number;created_at:Date;updated_at:Date};
type Target={author_id:string;text:string;displayText?:string;linkUrls?:string[];deleted_at:Date|null;hidden_at?:Date|null;moderation_status:string;images:{id:string;storageKey:string;mime:string}[];videos?:{id:string;mime:string}[];post_id?:string;community_id?:string|null;parentGeneration?:number;kind?:string;target_id?:string};
const statuses=new Set<Status>(['pending','review','rejected','approved','deleted']);
const unavailableReason='自动审核暂不可用，内容已隔离，请等待人工审核。';
export function publicationReason(entry:{target_type:string;appeal_reason?:string;labels?:string[]},status:string) {
  if(status==='pending')return '正在检查，完成后会自动更新发布状态。';
  if(status==='approved')return entry.target_type==='draft'?'资料已更新。':'已通过检查，按原来的发布范围展示。';
  if(status==='deleted')return '本次提交已撤回或移除。';
  if(entry.appeal_reason)return '你的说明已收到，正在等待管理员复核。';
  if(entry.labels?.includes('video_manual_review'))return '视频已提交，等待管理员人工审核。';
  if(status==='rejected')return '这次提交暂未通过内容检查。你可以说明内容背景，申请管理员复核。';
  return '这次提交需要管理员复核，暂未公开。你可以补充说明或稍后查看结果。';
}

async function queueCase(id:string,client?:PoolClient) {
  await query(`INSERT INTO jobs(id,kind,target_id) VALUES($1,'moderation',$2)
    ON CONFLICT(kind,target_id) DO UPDATE SET status='pending',attempts=0,error=NULL,available_at=now(),locked_at=NULL`,[randomUUID(),id],client);
}
async function queueIndex(id:string,client:PoolClient) {
  await query(`INSERT INTO jobs(id,kind,target_id) VALUES($1,'index',$2)
    ON CONFLICT(kind,target_id) DO UPDATE SET status='pending',attempts=0,error=NULL,available_at=now(),locked_at=NULL`,[randomUUID(),id],client);
}

export async function enqueueModeration(type:TargetType,targetId:string,authorId:string,client?:PoolClient):Promise<{id:string;revision:number}> {
  if(!client)return transaction(tx=>enqueueModeration(type,targetId,authorId,tx));
  const created=await query(`INSERT INTO moderation_cases(id,target_type,target_id,author_id) VALUES($1,$2,$3,$4) ON CONFLICT(target_type,target_id) DO NOTHING RETURNING id`,[randomUUID(),type,targetId,authorId],client);
  const [entry]=await query<Case>('SELECT * FROM moderation_cases WHERE target_type=$1 AND target_id=$2',[type,targetId],client);
  if(created.length)await history(entry.id,'submit','pending','内容已提交，等待审核。',authorId,client);
  await queueCase(entry.id,client);
  return {id:entry.id,revision:entry.revision};
}

async function authorOpen(authorId:string,client?:PoolClient,lock:'SHARE'|'UPDATE'='SHARE') {
  const [profile]=await query(`SELECT deleted_at FROM profiles WHERE user_id=$1${client?` FOR ${lock}`:''}`,[authorId],client);
  return !!profile&&!profile.deleted_at;
}
async function readTarget(entry:Case,client?:PoolClient):Promise<Target|undefined> {
  if(entry.target_type==='draft')return readModerationDraft(entry.target_id,client);
  if(entry.target_type==='media'||entry.target_type==='link') {
    const table=entry.target_type==='media'?'media':'link_resources';
    const [hint]=await query(`SELECT post_id FROM ${table} WHERE id=$1`,[entry.target_id],client);
    if(!hint)return undefined;
    const [post]=await query(`SELECT p.author_id,p.deleted_at,c.generation FROM posts p JOIN moderation_cases c ON c.target_type='post' AND c.target_id=p.id WHERE p.id=$1${client?' FOR UPDATE OF p':''}`,[hint.post_id],client);
    const [row]=await query(`SELECT * FROM ${table} WHERE id=$1${client?' FOR UPDATE':''}`,[entry.target_id],client);
    if(!post||!row)return undefined;
    const displayText=(entry.target_type==='media'?[row.extracted_text,row.description]:[row.url,row.title,row.description,row.content]).filter(Boolean).join('\n');
    return {author_id:post.author_id,deleted_at:post.deleted_at||(entry.target_type==='media'&&!row.ai_consent?new Date():null),moderation_status:row.derivation_status,post_id:row.post_id,parentGeneration:post.generation,
      // Internal fetch metadata is still inspected, but is not publication copy.
      text:entry.target_type==='media'?displayText:[displayText,JSON.stringify(row.metadata)].join('\n'),displayText,
      ...(entry.target_type==='link'?{linkUrls:[row.url]}:{}),images:[]};
  }
  const table=entry.target_type==='post'?'posts':'comments';
  const [row]=await query(`SELECT * FROM ${table} WHERE id=$1${client?' FOR UPDATE':''}`,[entry.target_id],client);
  if(!row)return undefined;
  if(entry.target_type==='comment')return {author_id:row.author_id,text:[row.body,row.agent_name||''].join('\n'),deleted_at:row.deleted_at,hidden_at:row.hidden_at,moderation_status:row.moderation_status,images:[],post_id:row.post_id};
  const media=await query('SELECT id,storage_key,mime FROM media WHERE post_id=$1 ORDER BY created_at,id',[row.id],client);
  const links=await query('SELECT url FROM link_resources WHERE post_id=$1 ORDER BY id',[row.id],client);
  const bodyUrls=new Set(extractWebUrls(row.body).map(url=>new URL(url).href));
  return {author_id:row.author_id,deleted_at:row.deleted_at,moderation_status:row.moderation_status,community_id:row.community_id,
    text:[row.body,row.agent_name||'',...links.map(link=>link.url).filter(url=>!bodyUrls.has(new URL(url).href))].filter(Boolean).join('\n'),linkUrls:links.map(link=>link.url),
    images:media.filter(item=>!isVideoMime(item.mime)).map(image=>({id:image.id,storageKey:image.storage_key,mime:image.mime})),
    videos:media.filter(item=>isVideoMime(item.mime)).map(video=>({id:video.id,mime:video.mime}))};
}
async function lockedCase(id:string,client:PoolClient) {
  const [hint]=await query<Case>('SELECT * FROM moderation_cases WHERE id=$1',[id],client);
  if(!hint)return undefined;
  if(!await authorOpen(hint.author_id,client,hint.target_type==='draft'?'UPDATE':'SHARE'))return undefined;
  const target=await readTarget(hint,client);
  const [entry]=await query<Case>('SELECT * FROM moderation_cases WHERE id=$1 FOR UPDATE',[id],client);
  if(!target||target.deleted_at||!entry||entry.status==='deleted')return undefined;
  return {entry,target};
}
async function admin(actor:Actor,client?:PoolClient) {
  human(actor);await active(actor,client);
  if(!client){await adminAccess(actor);return;}
  const [profile]=await query('SELECT role FROM profiles WHERE user_id=$1',[actor.userId],client);
  if(profile?.role!=='admin')fail(403,'需要平台管理员权限');
}
async function syncTarget(entry:Case,status:Status,client:PoolClient) {
  if(entry.target_type==='draft'){await applyModerationDraft(entry.target_id,status,client);return;}
  if(entry.target_type==='media'||entry.target_type==='link') {
    const table=entry.target_type==='media'?'media':'link_resources';
    await query("SELECT set_config('app.moderation_write','on',true)",[],client);
    const erasure=entry.target_type==='media'?",extracted_text='',description=''":",title='',description='',content='',metadata='{}'";
    const [row]=await query(`UPDATE ${table} SET derivation_status=$2${status==='deleted'?erasure:''} WHERE id=$1 RETURNING post_id`,[entry.target_id,status],client);
    if(row)await queueIndex(row.post_id,client);
    return;
  }
  const table=entry.target_type==='post'?'posts':'comments';
  await query(`UPDATE ${table} SET moderation_status=$2,deleted_at=CASE WHEN $2='deleted' THEN coalesce(deleted_at,now()) ELSE deleted_at END WHERE id=$1 AND deleted_at IS NULL`,[entry.target_id,status],client);
  if(entry.target_type==='post') {
    await query('UPDATE media SET moderation_status=$2 WHERE post_id=$1',[entry.target_id,status],client);
    await query('UPDATE link_resources SET moderation_status=$2 WHERE post_id=$1',[entry.target_id,status],client);
    await queueContentIndex(entry.target_id,client);
  } else if(status==='approved'&&entry.status!=='approved') {
    const [post]=await query(`SELECT p.id,p.author_id FROM posts p JOIN comments c ON c.post_id=p.id
      WHERE c.id=$1 AND c.hidden_at IS NULL AND c.deleted_at IS NULL AND c.moderation_status='approved'
      AND p.deleted_at IS NULL AND p.hidden_at IS NULL AND p.moderation_status='approved' AND NOT ${unavailablePostSQL('p')}`,[entry.target_id],client);
    if(post&&post.author_id!==entry.author_id)await query("INSERT INTO notifications(id,user_id,text,href,comment_id) VALUES($1,$2,'你的帖子有一条新回复',$3,$4)",[randomUUID(),post.author_id,`/posts/${post.id}`,entry.target_id],client);
  }
}
async function recordAudit(actor:Actor,action:string,id:string,client:PoolClient) {
  await query('INSERT INTO audit_logs(id,user_id,action,target_id) VALUES($1,$2,$3,$4)',[randomUUID(),actor.userId,action,id],client);
}
async function history(id:string,action:string,status:Status,reason:string,actorId:string|null,client:PoolClient) {
  await query('INSERT INTO moderation_history(id,case_id,actor_id,action,status,reason) VALUES($1,$2,$3,$4,$5,$6)',[randomUUID(),id,actorId,action,status,reason],client);
}

export async function moderationList(actor:Actor,input:{mine?:boolean;status?:string}) {
  human(actor);await active(actor);
  if(!input.mine)await admin(actor);
  if(input.status&&input.status!=='actionable'&&!statuses.has(input.status as Status))fail(400,'无效的审核状态');
  const entries=await query<Case>(`SELECT c.* FROM moderation_cases c JOIN profiles p ON p.user_id=c.author_id
    WHERE p.deleted_at IS NULL AND ($1::text IS NULL OR c.author_id=$1) AND ($2='' OR c.status=$2 OR ($2='actionable' AND c.status IN ('review','rejected')))
    AND ($2<>'actionable' OR CASE c.target_type
      WHEN 'post' THEN EXISTS(SELECT 1 FROM posts t WHERE t.id=c.target_id AND t.deleted_at IS NULL AND t.moderation_status<>'deleted')
      WHEN 'comment' THEN EXISTS(SELECT 1 FROM comments t JOIN posts parent ON parent.id=t.post_id WHERE t.id=c.target_id AND t.deleted_at IS NULL AND t.moderation_status<>'deleted' AND parent.deleted_at IS NULL AND parent.moderation_status<>'deleted')
      WHEN 'draft' THEN EXISTS(SELECT 1 FROM content_drafts t WHERE t.id=c.target_id AND t.status<>'deleted')
      WHEN 'media' THEN EXISTS(SELECT 1 FROM media t JOIN posts parent ON parent.id=t.post_id JOIN moderation_cases original ON original.target_type='post' AND original.target_id=parent.id WHERE t.id=c.target_id AND t.ai_consent AND t.derivation_status<>'deleted' AND parent.deleted_at IS NULL AND parent.moderation_status<>'deleted' AND original.status<>'deleted')
      WHEN 'link' THEN EXISTS(SELECT 1 FROM link_resources t JOIN posts parent ON parent.id=t.post_id JOIN moderation_cases original ON original.target_type='post' AND original.target_id=parent.id WHERE t.id=c.target_id AND t.derivation_status<>'deleted' AND parent.deleted_at IS NULL AND parent.moderation_status<>'deleted' AND original.status<>'deleted')
      ELSE false END)
    ORDER BY c.updated_at DESC,c.id DESC LIMIT 100`,[input.mine?actor.userId:null,input.status||'']);
  const items=[];
  for(const entry of entries) {
    const target=await readTarget(entry);
    const [author]=await query('SELECT name FROM "user" WHERE id=$1',[entry.author_id]);
    const removed=!target||!!target.deleted_at||entry.status==='deleted';
    // A deletion may commit after the live-target SQL predicate was evaluated.
    if(input.status==='actionable'&&(removed||target.moderation_status==='deleted'))continue;
    const events=input.mine?undefined:await query(`SELECT h.id,h.action,h.status,h.reason,h.created_at AS "createdAt",u.name AS "actorName"
      FROM moderation_history h LEFT JOIN "user" u ON u.id=h.actor_id WHERE h.case_id=$1 ORDER BY h.created_at DESC,h.id DESC LIMIT 30`,[entry.id]);
    const visibleStatus=removed?'deleted':entry.status;
    const postId=entry.target_type==='post'?entry.target_id:target?.post_id;
    const [visibility]=postId?await query(`SELECT ${unavailablePostSQL('p')} AS unavailable,(WITH RECURSIVE ancestors AS (
      SELECT id,original_id,hidden_at,0 AS depth FROM posts WHERE id=p.id UNION ALL SELECT p.id,p.original_id,p.hidden_at,a.depth+1 FROM posts p JOIN ancestors a ON p.id=a.original_id WHERE a.depth<9
      ) SELECT hidden_at FROM ancestors WHERE hidden_at IS NOT NULL ORDER BY depth LIMIT 1) AS hidden_at FROM posts p WHERE p.id=$1`,[postId]):[];
    const hiddenAt=target?.hidden_at||visibility?.hidden_at||null;
    const unavailable=!!hiddenAt||!!visibility?.unavailable;
    items.push({id:entry.id,targetType:entry.target_type,targetId:entry.target_id,authorId:entry.author_id,authorName:author?.name||'社区成员',
      text:removed?'':target.displayText??target.text,images:removed?[]:target.images.map(image=>image.id),videos:removed?[]:target.videos||[],status:visibleStatus,appealReason:entry.appeal_reason,
      hiddenAt,unavailable,userReason:removed?publicationReason(entry,'deleted'):hiddenAt?'该内容已被管理员隐藏，暂不公开。':unavailable&&visibleStatus==='approved'?'原帖或所属内容暂不可见，这条内容暂不公开。':publicationReason(entry,visibleStatus),createdAt:entry.created_at,updatedAt:entry.updated_at,
      ...(!input.mine?{labels:entry.labels,reason:entry.reason,history:events,revision:entry.revision,provider:entry.provider,reviewedBy:entry.reviewed_by}:{}),
      ...(target?.kind?{draftKind:target.kind,resultTargetId:target.target_id}:{}),...(target?.post_id?{postId:target.post_id}:{}),...(entry.target_type==='post'?{postCommunityId:target?.community_id||null}:{})});
  }
  return {items,...(!input.mine?{provider:moderationProviderStatus()}: {})};
}

export async function moderationDecide(actor:Actor,input:{id:string;decision:'approve'|'delete';reason:string}) {
  await admin(actor);
  if(!['approve','delete'].includes(input.decision)||typeof input.reason!=='string'||!input.reason.trim()||input.reason.length>2000)fail(400,'请填写不超过 2000 字的审核理由');
  return transaction(async client=>{
    const found=await lockedCase(input.id,client);if(!found)fail(409,'内容已删除、撤回或账户已注销，不能再次放行');
    await admin(actor,client);
    const {entry,target}=found;
    if(entry.target_type==='comment'&&input.decision==='approve')await readablePost({userId:entry.author_id},target.post_id!,client);
    const status=input.decision==='approve'?'approved':'deleted';
    await query(`UPDATE moderation_cases SET status=$2,reason=$3,reviewed_by=$4,revision=revision+1,generation=generation+1,updated_at=now() WHERE id=$1`,[entry.id,status,input.reason.trim(),actor.userId],client);
    await syncTarget(entry,status,client);
    if(status==='approved'&&entry.target_type==='post') {
      await query("UPDATE media SET status='blocked',error='人工审核后停止可选解析' WHERE post_id=$1 AND status IN ('pending','processing')",[entry.target_id],client);
      await query("UPDATE link_resources SET status='partial',error='人工审核后停止链接解析' WHERE post_id=$1 AND status IN ('pending','processing')",[entry.target_id],client);
      await query(`UPDATE moderation_cases SET status='deleted',revision=revision+1,generation=generation+1,reason='原帖经人工审核，停止尚未公开的可选解析。',updated_at=now()
        WHERE status='pending' AND ((target_type='media' AND target_id IN (SELECT id FROM media WHERE post_id=$1)) OR (target_type='link' AND target_id IN (SELECT id FROM link_resources WHERE post_id=$1)))`,[entry.target_id],client);
    }
    await history(entry.id,input.decision,status,input.reason.trim(),actor.userId!,client);
    // Network requests may still be in flight; both their job claim and content
    // revision are invalidated before a manual decision becomes visible.
    await query(`UPDATE jobs SET status='done',error=NULL,locked_at=NULL WHERE (kind='moderation' AND target_id=$1)
      OR ($2='post' AND ((kind='image' AND target_id IN (SELECT id FROM media WHERE post_id=$3)) OR (kind='link' AND target_id IN (SELECT id FROM link_resources WHERE post_id=$3))))`,[entry.id,entry.target_type,entry.target_id],client);
    await recordAudit(actor,'moderation_decide',entry.id,client);
    return {ok:true,moderationStatus:status};
  });
}

export async function moderationAppeal(actor:Actor,input:{id:string;reason:string}) {
  human(actor);await active(actor);
  if(typeof input.reason!=='string'||!input.reason.trim()||input.reason.length>2000)fail(400,'请填写不超过 2000 字的申诉说明');
  return transaction(async client=>{
    const found=await lockedCase(input.id,client);if(!found||found.entry.author_id!==actor.userId)fail(404,'审核记录不存在');
    await active(actor,client);
    const {entry}=found;
    if(!['review','rejected'].includes(entry.status))fail(409,'仅可对待人工审核或被隔离的内容提交申诉');
    await query(`UPDATE moderation_cases SET status='review',appeal_reason=$2,revision=revision+1,generation=generation+1,updated_at=now() WHERE id=$1`,[entry.id,input.reason.trim()],client);
    await syncTarget(entry,'review',client);
    await history(entry.id,'appeal','review',input.reason.trim(),actor.userId!,client);
    await query("UPDATE jobs SET status='done',locked_at=NULL WHERE kind='moderation' AND target_id=$1",[entry.id],client);
    await recordAudit(actor,'moderation_appeal',entry.id,client);
    return {ok:true,moderationStatus:'review'};
  });
}

export async function moderationRetry(actor:Actor,input:{id:string}) {
  await admin(actor);
  return transaction(async client=>{
    const found=await lockedCase(input.id,client);if(!found)fail(409,'内容已删除、撤回或账户已注销');
    await admin(actor,client);
    const {entry}=found;
    if(entry.target_type==='draft'&&entry.status==='approved')fail(409,'已发布的修改不能重新应用，请提交新的修改草稿');
    await query(`UPDATE moderation_cases SET status='pending',labels='{}',reason='',provider='',reviewed_by=NULL,revision=revision+1,generation=generation+1,updated_at=now() WHERE id=$1`,[entry.id],client);
    await syncTarget(entry,'pending',client);await queueCase(entry.id,client);
    await history(entry.id,'retry','pending','管理员重新发起自动审核。',actor.userId!,client);
    await recordAudit(actor,'moderation_retry',entry.id,client);
    return {ok:true,moderationStatus:'pending'};
  });
}

export async function moderationWithdraw(actor:Actor,input:{id:string}) {
  human(actor);await active(actor);
  return transaction(async client=>{
    const found=await lockedCase(input.id,client);
    if(!found||found.entry.author_id!==actor.userId)fail(404,'审核记录不存在');
    await active(actor,client);
    const {entry}=found;
    if(!['pending','review','rejected'].includes(entry.status))fail(409,'只能撤回尚未发布的内容');
    await query(`UPDATE moderation_cases SET status='deleted',reason='作者已撤回此内容。',revision=revision+1,generation=generation+1,updated_at=now() WHERE id=$1`,[entry.id],client);
    await syncTarget(entry,'deleted',client);
    await query("UPDATE jobs SET status='done',error=NULL,locked_at=NULL WHERE kind='moderation' AND target_id=$1",[entry.id],client);
    await history(entry.id,'withdraw','deleted','作者已撤回此内容。',actor.userId!,client);
    await recordAudit(actor,'moderation_withdraw',entry.id,client);
    return {ok:true,moderationStatus:'deleted'};
  });
}

/** Only this special preview route may read unpublished original images. */
export async function moderationMediaAccess(actor:Actor,mediaRow:Item):Promise<boolean> {
  if(!actor.userId||actor.grantId)return false;
  await active(actor);
  if(!await authorOpen(mediaRow.owner_id))return false;
  if(mediaRow.post_id) {
    const [post]=await query('SELECT deleted_at FROM posts WHERE id=$1',[mediaRow.post_id]);
    if(!post||post.deleted_at)return false;
  }
  if(mediaRow.owner_id===actor.userId)return true;
  if(!mediaRow.post_id) {
    const [profile]=await query('SELECT role FROM profiles WHERE user_id=$1',[actor.userId]);
    if(profile?.role!=='admin'||mediaRow.usage_kind!=='avatar')return false;
    return (await query(`SELECT 1 FROM content_drafts d JOIN moderation_cases c ON c.target_type='draft' AND c.target_id=d.id
      WHERE d.kind='profile' AND d.author_id=$1 AND d.payload->>'avatarMediaId'=$2 AND d.status<>'deleted' AND c.status<>'deleted'`,[mediaRow.owner_id,mediaRow.id])).length>0;
  }
  if(!(await query("SELECT 1 FROM moderation_cases WHERE target_type='post' AND target_id=$1 AND status<>'deleted'",[mediaRow.post_id])).length)return false;
  const [profile]=await query('SELECT role FROM profiles WHERE user_id=$1',[actor.userId]);
  return profile?.role==='admin';
}

/** Capture before starting a network request; manual decisions invalidate it. */
export async function moderationRevisionForPost(postId:string):Promise<number|null> {
  const [entry]=await query(`SELECT c.generation FROM moderation_cases c JOIN posts p ON p.id=c.target_id JOIN profiles u ON u.user_id=p.author_id
    WHERE c.target_type='post' AND p.id=$1 AND p.deleted_at IS NULL AND u.deleted_at IS NULL AND c.reviewed_by IS NULL AND c.status<>'deleted'`,[postId]);
  return entry?.generation??null;
}

/** Capture both boundaries before parsing; an appeal/retry may change only the preview. */
export async function moderationRevisionForDerivation(type:'media'|'link',id:string):Promise<number> {
  const [entry]=await query('SELECT generation FROM moderation_cases WHERE target_type=$1 AND target_id=$2',[type,id]);
  return entry?.generation??0;
}

/** Keep optional enrichments private without withdrawing the original post. */
export async function saveModeratedDerivation(postId:string,revision:number,type:'media'|'link',targetId:string,derivedRevision:number,write:(client:PoolClient)=>Promise<boolean>):Promise<boolean> {
  return transaction(async client=>{
    const [hint]=await query<Case>("SELECT * FROM moderation_cases WHERE target_type='post' AND target_id=$1",[postId],client);
    if(!hint)return false;
    const found=await lockedCase(hint.id,client);
    if(!found||found.entry.generation!==revision||found.entry.reviewed_by)return false;
    const [previous]=await query<Case>('SELECT * FROM moderation_cases WHERE target_type=$1 AND target_id=$2 FOR UPDATE',[type,targetId],client);
    // A human's decision about this preview must also survive a late parser.
    if((previous?.generation??0)!==derivedRevision||previous?.reviewed_by||previous?.status==='deleted')return false;
    await query("SELECT set_config('app.moderation_write','on',true)",[],client);
    if(!await write(client))return false;
    const [entry]=await query<Case>(`INSERT INTO moderation_cases(id,target_type,target_id,author_id) VALUES($1,$2,$3,$4)
      ON CONFLICT(target_type,target_id) DO UPDATE SET status='pending',labels='{}',reason='',provider='',revision=moderation_cases.revision+1,generation=moderation_cases.generation+1,updated_at=now() RETURNING *`,[randomUUID(),type,targetId,found.entry.author_id],client);
    await queueCase(entry.id,client);await queueIndex(postId,client);
    await history(entry.id,'derived_content','pending','可选解析已完成，安全检查通过后展示；原帖不受影响。',null,client);
    return true;
  });
}

/** Retire an unusable, automatically generated login preview, never its post. */
export async function discardUnavailableLinkPreview(postId:string,revision:number,linkId:string,derivedRevision:number):Promise<boolean> {
  return transaction(async client=>{
    const [hint]=await query<Case>("SELECT * FROM moderation_cases WHERE target_type='post' AND target_id=$1",[postId],client);
    if(!hint)return false;
    const found=await lockedCase(hint.id,client);
    if(!found||found.entry.generation!==revision||found.entry.reviewed_by)return false;
    const [link]=await query('SELECT * FROM link_resources WHERE id=$1 AND post_id=$2 FOR UPDATE',[linkId,postId],client);
    const [previous]=await query<Case>("SELECT * FROM moderation_cases WHERE target_type='link' AND target_id=$1 FOR UPDATE",[linkId],client);
    if(!link||(previous?.generation??0)!==derivedRevision)return false;
    if(!previous&&(link.derivation_status==='approved'||link.title||link.description||link.content||Object.keys(link.metadata||{}).length))return false;
    if(previous&&(previous.reviewed_by||previous.appeal_reason||!['pending','review','rejected'].includes(previous.status)||!isLoginPageUrl(link.metadata?.resolvedUrl)))return false;
    const reason='来源需要登录，暂无可用预览；原始分享链接保留。';
    await query("SELECT set_config('app.moderation_write','on',true)",[],client);
    await query(`UPDATE link_resources SET status='failed',error=$2,fetched_at=now(),title='',description='',content='',metadata='{}',derivation_status='deleted' WHERE id=$1`,[linkId,reason],client);
    if(previous) {
      await query("UPDATE moderation_cases SET status='deleted',reason=$2,revision=revision+1,generation=generation+1,updated_at=now() WHERE id=$1",[previous.id,reason],client);
      await query("UPDATE jobs SET status='done',error=NULL,locked_at=NULL WHERE kind='moderation' AND target_id=$1",[previous.id],client);
      await history(previous.id,'preview_unavailable','deleted',reason,null,client);
    }
    await queueIndex(postId,client);
    return true;
  });
}

/** Temporary outages stay pending and use the queue's bounded retry policy. */
export async function processModeration(id:string,attempt=1):Promise<boolean> {
  const snapshot=await transaction(async client=>{
    const found=await lockedCase(id,client);
    if(!found||found.entry.status!=='pending'||found.entry.reviewed_by)return undefined;
    return found;
  });
  if(!snapshot)return true;
  const {entry,target}=snapshot;
  let status:'approved'|'review'|'rejected'='review',labels:string[]=[],provider='unavailable',reason=unavailableReason;
  if(target.videos?.length) {
    // Text/image providers do not inspect video frames or audio. A successful
    // text check must never automatically publish an uploaded video.
    status='review';labels=['video_manual_review'];provider='manual-video';
    reason='视频需要管理员查看画面和声音后人工审核；审核通过前暂不公开。';
  } else try {
    const result=await moderateContent({text:target.text,linkUrls:target.linkUrls,images:target.images.map(({storageKey,mime})=>({storageKey,mime})),dataId:`${entry.id}:${entry.revision}`});
    if(!['approved','review','rejected'].includes(result.decision))throw new Error('Invalid moderation result');
    status=result.decision;labels=result.labels.filter(label=>typeof label==='string').map(label=>label.slice(0,100)).slice(0,30);provider=result.provider.slice(0,80);
    reason=status==='approved'?'自动审核通过。':status==='rejected'?'自动审核识别到高风险内容，已隔离，可提交申诉。':labels.includes('pt_to_contact')?'自动检查提示疑似引流信息，已转管理员人工复核；处理前不会公开，可提交说明或申诉。':'自动检查已结束，需要管理员人工复核；处理前不会公开，可提交说明或申诉。';
  } catch(error) {
    if(error instanceof ModerationTransientError&&attempt<3)throw error;
    labels=['provider_unavailable'];
    if(error instanceof ModerationTransientError)reason='自动安全检查连续失败，已转人工复核；公开前仍仅自己可见。';
  }
  const completed=await transaction(async client=>{
    const current=await lockedCase(id,client);
    if(!current||current.entry.revision!==entry.revision||current.entry.status!=='pending'||current.entry.reviewed_by)return;
    // A restarted original check invalidates this snapshot, but must not leave
    // a still-pending preview with a completed job and no way to resume.
    if(current.target.parentGeneration!==target.parentGeneration)return false;
    if(current.entry.target_type==='comment'&&status==='approved') {
      try {await readablePost({userId:current.entry.author_id},current.target.post_id!,client);}catch {status='review';reason='原帖当前不可访问，请等待人工处理。';}
    }
    await syncTarget(current.entry,status,client);
    await query(`UPDATE moderation_cases SET status=$2,labels=$3,provider=$4,reason=$5,updated_at=now() WHERE id=$1 AND revision=$6`,[id,status,labels,provider,reason,entry.revision],client);
    await history(id,'automatic',status,reason,null,client);
  });
  return completed!==false;
}
