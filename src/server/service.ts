import { randomUUID, randomBytes, createHash } from 'node:crypto';
import type { PoolClient } from 'pg';
import { query, transaction } from './db';
import { active, adminAccess, communityAccess, human, readablePost, scope, user,visiblePostSQL } from './permissions';
import { contracts, fail, AppError, type Action, type Actor, type Item } from '../shared/contracts';
import { searchCandidates,searchClient } from './search';
import { extractWebUrls } from '../shared/links';
import { PRIVACY_VERSION,EVENT_CONTACT_RETENTION_DAYS } from '../shared/privacy';
import { createInvitations,listInvitations,revokeInvitation } from './invitations';
import { enqueueModeration,moderationList,moderationDecide,moderationAppeal,moderationRetry,moderationWithdraw } from './moderation';
import { submitModerationDraft } from './moderation-drafts';
import { adminStats } from './admin-stats';
import { adminContentList,adminContentModerate,queueContentIndex } from './admin-content';

const uid=()=>randomUUID();
export const digest=(s:string)=>createHash('sha256').update(s).digest('hex');
export async function ensureProfile(id:string) {
  await query(`INSERT INTO profiles(user_id,handle) VALUES($1,$2) ON CONFLICT(user_id) DO NOTHING`,[id,`user_${digest(id).slice(0,12)}`]);
}
async function audit(a:Actor,action:string,target?:string,client?:PoolClient) {
  await query('INSERT INTO audit_logs(id,user_id,grant_id,action,target_id) VALUES($1,$2,$3,$4,$5)',[uid(),a.userId,a.grantId||null,action,target||null],client);
}
async function enqueue(kind:string,target:string,client?:PoolClient) {
  await query(`INSERT INTO jobs(id,kind,target_id) VALUES($1,$2,$3) ON CONFLICT(kind,target_id) DO UPDATE SET status='pending',attempts=0,error=NULL,available_at=now()`,[uid(),kind,target],client);
}
async function notify(target:string,text:string,href:string,client?:PoolClient) {
  await query('INSERT INTO notifications(id,user_id,text,href) VALUES($1,$2,$3,$4)',[uid(),target,text,href],client);
}
async function publicUser(id:string,client?:PoolClient) {
  const [p]=await query(`SELECT u.id,u.name,u.image,p.handle,p.bio,p.city FROM "user" u JOIN profiles p ON p.user_id=u.id WHERE u.id=$1 AND p.deleted_at IS NULL`,[id],client); return p;
}
export async function postView(a:Actor,id:string,depth=0):Promise<Item> {
  const p=await readablePost(a,id);
  const [author,media,links,comments,reactions,counts]=await Promise.all([
    publicUser(p.author_id),query("SELECT id,mime,bytes,CASE WHEN derivation_status='approved' THEN extracted_text ELSE '' END AS extracted_text,CASE WHEN derivation_status='approved' THEN description ELSE '' END AS description,status FROM media WHERE post_id=$1 AND moderation_status='approved'",[id]),
    query("SELECT id,post_id,url,platform,CASE WHEN derivation_status='approved' THEN title ELSE '' END AS title,CASE WHEN derivation_status='approved' THEN description ELSE '' END AS description,CASE WHEN derivation_status='approved' THEN content ELSE '' END AS content,CASE WHEN derivation_status='approved' THEN metadata ELSE '{}'::jsonb END AS metadata,status,fetched_at FROM link_resources WHERE post_id=$1 AND moderation_status='approved'",[id]),
    query(`SELECT c.id,c.body,c.created_at,c.agent_name,u.id AS author_id,u.name,u.image FROM comments c JOIN "user" u ON u.id=c.author_id WHERE post_id=$1 AND c.deleted_at IS NULL AND c.hidden_at IS NULL AND c.moderation_status='approved' AND NOT EXISTS(SELECT 1 FROM blocks b WHERE (b.blocker_id=$2 AND b.blocked_id=c.author_id) OR (b.blocked_id=$2 AND b.blocker_id=c.author_id)) ORDER BY c.created_at LIMIT 100`,[id,a.userId||'']),
    query('SELECT kind,count(*)::int AS count,bool_or(user_id=$2) AS mine FROM reactions WHERE post_id=$1 GROUP BY kind',[id,a.userId||'']),
    query(`SELECT count(*)::int AS count FROM posts p WHERE p.original_id=$1 AND p.community_id IS NULL AND ${visiblePostSQL('p','$2','$3','$4')}`,[id,a.userId||'',a.communityIds||[],!!a.grantId])
  ]);
  const c=p.community_id?(await query('SELECT id,name,visibility FROM communities WHERE id=$1',[p.community_id]))[0]:null;
  const processing=p.author_id===a.userId&&!a.grantId?await query(`SELECT id,kind,status FROM jobs WHERE target_id IN (SELECT id FROM media WHERE post_id=$1 UNION SELECT id FROM link_resources WHERE post_id=$1) AND status IN ('pending','processing','failed','blocked')`,[id]):[];
  return { ...p,author,community:c,media:media.map(m=>({...m,url:`/api/v1/media/${m.id}`})),links,comments,reactions,processing,repostCount:counts[0].count,original:p.original_id&&depth<8?await postView(a,p.original_id,depth+1):null };
}
async function safePosts(a:Actor,rows:Item[]) {
  const result:Item[]=[];
  for(const row of rows) { try { result.push(await postView(a,row.id)); } catch(e) { if(!(e instanceof AppError && [403,404].includes(e.status))) throw e; } }
  return result;
}
async function eventView(a:Actor,id:string,client?:PoolClient):Promise<Item> {
  const [e]=await query(`SELECT e.*,c.name AS community_name,c.visibility FROM events e JOIN communities c ON c.id=e.community_id WHERE e.id=$1 AND e.moderation_removed_at IS NULL AND c.moderation_removed_at IS NULL`,[id],client);
  if(!e) fail(404,'活动不存在');
  const community=await communityAccess(a,e.community_id,false,false,client);
  const counts=await query(`SELECT count(*)::int AS count,bool_or(user_id=$2) AS attending FROM registrations WHERE event_id=$1`,[id,a.userId||''],client);
  const organizer=e.organizer_id===a.userId;
  const {address,...rest}=e;
  const addressAllowed=(!a.grantId||a.communityIds?.includes(e.community_id))&&(organizer||counts[0].attending);
  const canManage=!a.grantId&&community.membership_status==='active'&&community.membership_role==='admin';
  return {...rest,address:addressAllowed?address:null,attending:!!counts[0].attending,registrationCount:counts[0].count,isOrganizer:organizer,canManage};
}
async function idempotent<T>(a:Actor,action:string,input:Item,fn:(client:PoolClient)=>Promise<T>):Promise<T> {
  return transaction(async client=>{
    if(action==='events_create')await query('SELECT user_id FROM profiles WHERE user_id=$1 FOR UPDATE',[a.userId],client);
    await active(a,client);
    const key=input.idempotencyKey;
    if(key) {
      const hash=digest(JSON.stringify(input));
      await query('INSERT INTO request_keys(user_id,key,action) VALUES($1,$2,$3) ON CONFLICT DO NOTHING',[a.userId,key,`${action}:${hash}`],client);
      const [old]=await query('SELECT * FROM request_keys WHERE user_id=$1 AND key=$2 FOR UPDATE',[a.userId,key],client);
      if(old.action!==`${action}:${hash}`) fail(409,'幂等键已用于不同请求');
      if(old.result) return old.result as T;
    }
    const value=await fn(client);
    if(key) await query('UPDATE request_keys SET result=$3 WHERE user_id=$1 AND key=$2',[a.userId,key,JSON.stringify(value)],client);
    return value;
  });
}
export async function execute(action:Action,raw:unknown,a:Actor):Promise<any> {
  const parsed=contracts[action].safeParse(raw);
  if(!parsed.success) fail(400,parsed.error.issues.map(i=>`${i.path.join('.')}: ${i.message}`).join(';'),'INVALID_INPUT');
  const p=parsed.data as Item;
  await active(a);
  if(a.grantId && ['posts_list','posts_get','search','communities_list','communities_get','events_list','events_get','profile_get'].includes(action)) scope(a,'content:read');
  switch(action) {
    case 'invitations_list': return listInvitations(a);
    case 'invitations_create': return createInvitations({count:p.count,days:p.days,label:p.label},a);
    case 'invitations_revoke': return revokeInvitation(p.id,a);
    case 'posts_list': {
      const values:unknown[]=[]; const clauses=['p.deleted_at IS NULL'];
      const bind=(x:unknown)=>{values.push(x);return `$${values.length}`;};
      if(p.communityId) {await communityAccess(a,p.communityId);clauses.push(`p.community_id=${bind(p.communityId)}`);}
      if(p.authorId) clauses.push(`p.author_id=${bind(p.authorId)}`);
      if(p.tag) clauses.push(`${bind(p.tag)}=ANY(p.tags)`);
      if(p.cursor) clauses.push(`(p.created_at,p.id)<(SELECT created_at,id FROM posts WHERE id=${bind(p.cursor)})`);
      if(p.feed==='following') clauses.push(`p.author_id IN (SELECT following_id FROM follows WHERE follower_id=${bind(user(a))})`);
      if(p.feed==='bookmarks') clauses.push(`p.id IN (SELECT post_id FROM reactions WHERE user_id=${bind(user(a))} AND kind='bookmark')`);
      clauses.push(visiblePostSQL('p',bind(a.userId||''),bind(a.communityIds||[]),bind(!!a.grantId)));
      const rows=await query(`SELECT p.id FROM posts p WHERE ${clauses.join(' AND ')} ORDER BY p.created_at DESC,p.id DESC LIMIT 150`,values);
      const items:Item[]=[];let last:string|undefined;
      for(const r of rows) {last=r.id;const [view]=await safePosts(a,[r]);if(view) items.push(view);if(items.length>=p.limit) break;}
      return {items,nextCursor:rows.length&&last!==rows.at(-1)?.id?last:rows.length===150?last:null};
    }
    case 'posts_get': return postView(a,p.id);
    case 'posts_create': {
      scope(a,p.originalId?'interactions:write':'posts:write');
      if(!p.body&&!p.originalId&&!p.mediaIds.length&&!p.links.length) fail(400,'请输入内容或添加图片、链接');
      if(p.communityId) await communityAccess(a,p.communityId,true);
      if(p.originalId) {
        const original=await readablePost(a,p.originalId,undefined,1);
        if(original.community_id) { const c=await communityAccess(a,original.community_id); if(c.visibility==='private'&&p.communityId!==original.community_id) fail(403,'私密内容仅可在原社群内转发'); }
      }
      return idempotent(a,action,p,async client=>{
        if(p.communityId) await communityAccess(a,p.communityId,true,false,client);
        if(p.originalId) await readablePost(a,p.originalId,client);
        const id=uid();const tags=Array.from(new Set<string>((p.body.match(/#[\p{L}\p{N}_-]+/gu)||[]).map((s:string)=>s.slice(1))));
        await query('INSERT INTO posts(id,author_id,community_id,body,tags,original_id,agent_name,idempotency_key) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',[id,a.userId,p.communityId||null,p.body,tags,p.originalId||null,a.agentName||null,p.idempotencyKey||null],client);
        for(const mediaId of p.mediaIds) {
          const updated=await query("UPDATE media SET post_id=$1,ai_consent=$4,status=CASE WHEN $4 THEN 'pending' ELSE 'ready' END WHERE id=$2 AND owner_id=$3 AND post_id IS NULL AND usage_kind='post' RETURNING id,ai_consent",[id,mediaId,a.userId,p.imageAnalysisConsent],client);
          if(!updated.length) fail(403,'图片不存在、已使用或不属于你');
          if(updated[0].ai_consent)await enqueue('image',mediaId,client);
        }
        const extracted=extractWebUrls(p.body);
        const urls=Array.from(new Set<string>([...p.links,...extracted])).slice(0,5);
        for(const url of urls) {
          const host=new URL(url).hostname.toLowerCase();const platform=host==='github.com'?'github':/(^|\.)xiaohongshu\.com$|(^|\.)xhslink\.com$/.test(host)?'xiaohongshu':/(^|\.)douyin\.com$/.test(host)?'douyin':'web';
          const linkId=uid();await query('INSERT INTO link_resources(id,post_id,url,platform) VALUES($1,$2,$3,$4)',[linkId,id,url,platform],client); await enqueue('link',linkId,client);
        }
        const moderation=await enqueueModeration('post',id,a.userId!,client);await audit(a,action,id,client);return {id,moderationId:moderation.id,moderationStatus:'pending'};
      });
    }
    case 'posts_delete': {
      human(a);const [post]=await query('SELECT author_id FROM posts WHERE id=$1 AND deleted_at IS NULL',[p.id]);if(!post)fail(404,'帖子不存在或已被删除');if(post.author_id!==a.userId) fail(403,'只能删除自己的帖子');
      await query("UPDATE posts SET deleted_at=now(),moderation_status='deleted' WHERE id=$1",[p.id]);await enqueue('index',p.id);return {ok:true};
    }
    case 'comments_create': {
      scope(a,'interactions:write');const post=await readablePost(a,p.id);if(post.community_id) await communityAccess(a,post.community_id,true);
      return idempotent(a,action,p,async client=>{await readablePost(a,p.id,client);const id=uid();await query('INSERT INTO comments(id,post_id,author_id,body,agent_name) VALUES($1,$2,$3,$4,$5)',[id,p.id,a.userId,p.body,a.agentName||null],client);const moderation=await enqueueModeration('comment',id,a.userId!,client);await audit(a,action,id,client);return {id,moderationId:moderation.id,moderationStatus:'pending'};});
    }
    case 'reactions_set': {
      scope(a,'interactions:write');await readablePost(a,p.id);
      if(p.active) await query('INSERT INTO reactions(post_id,user_id,kind) VALUES($1,$2,$3) ON CONFLICT DO NOTHING',[p.id,a.userId,p.kind]);
      else await query('DELETE FROM reactions WHERE post_id=$1 AND user_id=$2 AND kind=$3',[p.id,a.userId,p.kind]);
      await audit(a,action,p.id);return {ok:true};
    }
    case 'communities_list': return {items:await query(`SELECT c.id,c.name,c.description,c.city,c.visibility,c.owner_id,c.created_at, (SELECT count(*)::int FROM memberships WHERE community_id=c.id AND status='active') AS member_count,m.status AS membership_status,m.role AS membership_role FROM communities c LEFT JOIN memberships m ON m.community_id=c.id AND m.user_id=$1 WHERE c.moderation_removed_at IS NULL AND ($2='' OR c.city=$2) ORDER BY c.created_at`,[a.userId||'',p.city||''])};
    case 'communities_get': {
      const [c]=await query(`SELECT c.*,m.status AS membership_status,m.role AS membership_role,(SELECT count(*)::int FROM memberships WHERE community_id=c.id AND status='active') AS member_count FROM communities c LEFT JOIN memberships m ON m.community_id=c.id AND m.user_id=$2 WHERE c.id=$1 AND c.moderation_removed_at IS NULL`,[p.id,a.userId||'']);
      if(!c) fail(404,'社群不存在');
      if(c.visibility==='private') { try {await communityAccess(a,p.id);} catch {c.announcement='';} }return c;
    }
    case 'communities_create': {
      human(a);return submitModerationDraft(a,'community',p);
    }
    case 'communities_join': {
      human(a);const [c]=await query('SELECT * FROM communities WHERE id=$1 AND moderation_removed_at IS NULL',[p.id]);if(!c) fail(404,'社群不存在');
      await query('INSERT INTO memberships(community_id,user_id,status) VALUES($1,$2,$3) ON CONFLICT DO NOTHING',[p.id,a.userId,c.visibility==='private'?'pending':'active']);return {status:c.visibility==='private'?'pending':'active'};
    }
    case 'communities_leave': {
      human(a);const [c]=await query('SELECT owner_id FROM communities WHERE id=$1',[p.id]);if(c?.owner_id===a.userId) fail(409,'群主不能直接退出自己创建的社群');
      await query('DELETE FROM memberships WHERE community_id=$1 AND user_id=$2',[p.id,a.userId]);return {ok:true};
    }
    case 'communities_members': {
      human(a);await communityAccess(a,p.id,true);const c=await communityAccess(a,p.id);
      return {items:await query(`SELECT u.id,u.name,u.image,p.city,m.role,m.status FROM memberships m JOIN "user" u ON u.id=m.user_id JOIN profiles p ON p.user_id=u.id WHERE m.community_id=$1 AND (m.status='active' OR $2)`,[p.id,c.membership_role==='admin'])};
    }
    case 'communities_approve': {
      human(a);await communityAccess(a,p.id,true,true);
      if(p.approved) await query(`UPDATE memberships SET status='active' WHERE community_id=$1 AND user_id=$2 AND status='pending'`,[p.id,p.userId]);
      else await query(`DELETE FROM memberships WHERE community_id=$1 AND user_id=$2 AND status='pending'`,[p.id,p.userId]);return {ok:true};
    }
    case 'communities_announcement': human(a);await communityAccess(a,p.id,true,true);return submitModerationDraft(a,'announcement',p,p.id);
    case 'events_list': {
      const rows=await query(`SELECT id FROM events WHERE moderation_removed_at IS NULL AND ($1='' OR city=$1) AND ($2='' OR community_id=$2) ORDER BY starts_at DESC LIMIT 100`,[p.city||'',p.communityId||'']);const items=[];
      for(const r of rows) {try {items.push(await eventView(a,r.id));} catch(e) {if(!(e instanceof AppError&&[403,404].includes(e.status))) throw e;}}return {items};
    }
    case 'events_get': return eventView(a,p.id);
    case 'events_create': {
      scope(a,'events:manage');await communityAccess(a,p.communityId,true,true);
      if(new Date(p.endsAt)<=new Date(p.startsAt)||new Date(p.startsAt)<=new Date()) fail(400,'请设置有效的未来活动时间');
      return idempotent(a,action,p,async client=>{await communityAccess(a,p.communityId,true,true,client);const result=await submitModerationDraft(a,'event',p,undefined,client);await audit(a,action,result.id,client);return result;});
    }
    case 'communities_remove': {
      human(a);const c=await communityAccess(a,p.id,true,true);if(p.userId===c.owner_id)fail(400,'不能移除社群创建者');
      await query('DELETE FROM memberships WHERE community_id=$1 AND user_id=$2',[p.id,p.userId]);await audit(a,action,p.id);return {ok:true};
    }
    case 'events_rsvp': {
      scope(a,'events:rsvp');return transaction(async client=>{
        const [e]=await query('SELECT * FROM events WHERE id=$1 FOR UPDATE',[p.id],client);if(!e) fail(404,'活动不存在');
        await active(a,client);
        // Cancellation must remain possible after leaving a community.
        if(p.attending) {
          await communityAccess(a,e.community_id,true,false,client);
          if(e.cancelled||new Date(e.starts_at)<=new Date()) fail(409,'活动已取消或报名已结束');
          const phoneNumber=p.phoneNumber.startsWith('+86')?p.phoneNumber:`+86${p.phoneNumber}`;
          const existing=await query('SELECT 1 FROM registrations WHERE event_id=$1 AND user_id=$2',[p.id,a.userId],client);
          if(!existing.length) {
            const [c]=await query('SELECT count(*)::int AS count FROM registrations WHERE event_id=$1',[p.id],client);if(c.count>=e.capacity) fail(409,'活动名额已满','EVENT_FULL');
            await query('INSERT INTO registrations(event_id,user_id,attendee_name,phone_number,contact_consent_version,contact_consented_at) VALUES($1,$2,$3,$4,$5,now())',[p.id,a.userId,p.attendeeName,phoneNumber,PRIVACY_VERSION],client);
          } else {
            await query('UPDATE registrations SET attendee_name=$3,phone_number=$4,contact_consent_version=$5,contact_consented_at=now() WHERE event_id=$1 AND user_id=$2',[p.id,a.userId,p.attendeeName,phoneNumber,PRIVACY_VERSION],client);
          }
        } else {
          if(a.grantId&&!a.communityIds?.includes(e.community_id)) fail(403,'Agent 未获得此社群的活动操作授权');
          await query('DELETE FROM registrations WHERE event_id=$1 AND user_id=$2',[p.id,a.userId],client);
        }
        await audit(a,action,p.id,client);return {ok:true,attending:p.attending};
      });
    }
    case 'events_attendees': {
      human(a);const e=await eventView(a,p.id);await communityAccess(a,e.community_id,true,true);
      return {items:await query(`SELECT u.id,u.image,CASE WHEN e.cancelled OR e.ends_at<now()-($2::int*interval '1 day') THEN u.name ELSE coalesce(r.attendee_name,u.name) END AS name,CASE WHEN e.cancelled OR e.ends_at<now()-($2::int*interval '1 day') THEN NULL ELSE r.phone_number END AS "phoneNumber",r.checked_in_at,r.created_at FROM registrations r JOIN "user" u ON u.id=r.user_id JOIN events e ON e.id=r.event_id WHERE event_id=$1 ORDER BY r.created_at`,[p.id,EVENT_CONTACT_RETENTION_DAYS])};
    }
    case 'events_checkin': {
      human(a);const e=await eventView(a,p.id);await communityAccess(a,e.community_id,true,true);
      if(e.cancelled) fail(409,'活动已取消');
      const rows=await query('UPDATE registrations SET checked_in_at=coalesce(checked_in_at,now()) WHERE event_id=$1 AND user_id=$2 RETURNING checked_in_at',[p.id,p.userId]);if(!rows.length) fail(404,'该用户未报名');return rows[0];
    }
    case 'events_update': {
      scope(a,'events:manage');const e=await eventView(a,p.id);await communityAccess(a,e.community_id,true,true);
      return transaction(async client=>{if(p.recap!==undefined)await query('SELECT user_id FROM profiles WHERE user_id=$1 FOR UPDATE',[a.userId],client);await active(a,client);await communityAccess(a,e.community_id,true,true,client);const [current]=await query('SELECT id FROM events WHERE id=$1 AND moderation_removed_at IS NULL FOR UPDATE',[p.id],client);if(!current)fail(404,'活动不存在或已下架');if(p.cancelled!==undefined)await query('UPDATE events SET cancelled=$2 WHERE id=$1',[p.id,p.cancelled],client);const result=p.recap!==undefined?await submitModerationDraft(a,'recap',{recap:p.recap},p.id,client):{ok:true};await audit(a,action,p.id,client);return result;});
    }
    case 'search': {
      const term=`%${p.q.replace(/[\\%_]/g,'\\$&')}%`;
      const candidates=await searchCandidates(p.q);
      const rows=await query(`SELECT DISTINCT p.id,p.created_at FROM posts p LEFT JOIN media m ON m.post_id=p.id AND m.moderation_status='approved' AND m.derivation_status='approved' LEFT JOIN link_resources l ON l.post_id=p.id AND l.moderation_status='approved' AND l.derivation_status='approved' LEFT JOIN profiles pr ON pr.user_id=p.author_id LEFT JOIN communities c ON c.id=p.community_id WHERE p.deleted_at IS NULL AND (p.body ILIKE $1 OR m.extracted_text ILIKE $1 OR m.description ILIKE $1 OR l.title ILIKE $1 OR l.content ILIKE $1 OR l.description ILIKE $1 OR (p.id=ANY($9::text[]) AND NOT EXISTS(SELECT 1 FROM media hidden_media WHERE hidden_media.post_id=p.id AND hidden_media.derivation_status<>'approved') AND NOT EXISTS(SELECT 1 FROM link_resources hidden_link WHERE hidden_link.post_id=p.id AND hidden_link.derivation_status<>'approved'))) AND ($2='' OR coalesce(c.city,pr.city)=$2) AND ($3='' OR $3=ANY(p.tags)) AND ($4<>'github' OR EXISTS(SELECT 1 FROM link_resources original_link WHERE original_link.post_id=p.id AND original_link.moderation_status='approved' AND original_link.platform='github')) AND ${visiblePostSQL('p','$5','$6','$7')} AND ($8='' OR (p.created_at,p.id)<(SELECT created_at,id FROM posts WHERE id=$8)) ORDER BY p.created_at DESC,p.id DESC LIMIT 51`,[term,p.city||'',p.tag||'',p.type,a.userId||'',a.communityIds||[],!!a.grantId,p.cursor||'',candidates]);
      const posts=['all','posts','github'].includes(p.type)?(await safePosts(a,rows)).slice(0,p.limit):[];
      const communities=['all','communities'].includes(p.type)?(await execute('communities_list',{city:p.city},a)).items.filter((c:Item)=>`${c.name}${c.description}`.includes(p.q)):[];
      const events=['all','events'].includes(p.type)?(await execute('events_list',{city:p.city},a)).items.filter((e:Item)=>`${e.title}${e.description}${e.recap}`.includes(p.q)):[];
      return {posts,communities,events,source:searchClient?'hybrid':'database',nextCursor:rows.length>p.limit?posts.at(-1)?.id||null:null};
    }
    case 'profile_get': {
      const profile=await publicUser(p.id);if(!profile) fail(404,'用户不存在');const [counts]=await query(`SELECT (SELECT count(*)::int FROM follows WHERE following_id=$1) AS followers,(SELECT count(*)::int FROM follows WHERE follower_id=$1) AS following,EXISTS(SELECT 1 FROM follows WHERE follower_id=$2 AND following_id=$1) AS followed`,[p.id,a.userId||'']);return {...profile,...counts};
    }
    case 'profile_update': human(a);return submitModerationDraft(a,'profile',p,a.userId);
    case 'follows_set': case 'blocks_set': {
      human(a);if(p.id===a.userId) fail(400,'不能对自己执行此操作');const table=action==='follows_set'?'follows':'blocks',left=action==='follows_set'?'follower_id':'blocker_id',right=action==='follows_set'?'following_id':'blocked_id';
      if(p.active) await query(`INSERT INTO ${table}(${left},${right}) VALUES($1,$2) ON CONFLICT DO NOTHING`,[a.userId,p.id]);else await query(`DELETE FROM ${table} WHERE ${left}=$1 AND ${right}=$2`,[a.userId,p.id]);return {ok:true};
    }
    case 'grants_list': human(a);return {items:await query('SELECT id,name,scopes,community_ids,expires_at,revoked_at,oauth_client_id,created_at FROM agent_grants WHERE user_id=$1 ORDER BY created_at DESC',[a.userId]),logs:await query('SELECT action,target_id,created_at FROM audit_logs WHERE user_id=$1 AND grant_id IS NOT NULL ORDER BY created_at DESC LIMIT 30',[a.userId])};
    case 'grants_create': {
      human(a);for(const id of p.communityIds) await communityAccess(a,id,true);
      const token=p.oauthClientId?null:`aic_${randomBytes(32).toString('base64url')}`;const id=uid();
      await transaction(async client=>{
        if(p.oauthClientId){
          await query('UPDATE agent_grants SET revoked_at=now() WHERE user_id=$1 AND oauth_client_id=$2 AND revoked_at IS NULL',[a.userId,p.oauthClientId],client);
          await query('DELETE FROM "oauthRefreshToken" WHERE "userId"=$1 AND "clientId"=$2',[a.userId,p.oauthClientId],client);
          await query('DELETE FROM "oauthConsent" WHERE "userId"=$1 AND "clientId"=$2',[a.userId,p.oauthClientId],client);
        }
        await query(`INSERT INTO agent_grants(id,user_id,name,token_hash,oauth_client_id,scopes,community_ids,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,now()+($8||' days')::interval)`,[id,a.userId,p.name,token?digest(token):null,p.oauthClientId||null,p.scopes,p.communityIds,String(p.days)],client);
      });
      return {id,token};
    }
    case 'grants_revoke': human(a);await transaction(async client=>{const [g]=await query('UPDATE agent_grants SET revoked_at=now() WHERE id=$1 AND user_id=$2 RETURNING oauth_client_id',[p.id,a.userId],client);if(g?.oauth_client_id){await query('DELETE FROM "oauthRefreshToken" WHERE "userId"=$1 AND "clientId"=$2',[a.userId,g.oauth_client_id],client);await query('DELETE FROM "oauthConsent" WHERE "userId"=$1 AND "clientId"=$2',[a.userId,g.oauth_client_id],client);}});return {ok:true};
    case 'notifications_list': {
      human(a);const rows=await query(`SELECT n.* FROM notifications n WHERE n.user_id=$1 AND (n.comment_id IS NULL OR EXISTS (
        SELECT 1 FROM comments c WHERE c.id=n.comment_id AND c.hidden_at IS NULL AND c.deleted_at IS NULL AND c.moderation_status='approved'
        AND NOT EXISTS(SELECT 1 FROM blocks b WHERE (b.blocker_id=$1 AND b.blocked_id=c.author_id) OR (b.blocked_id=$1 AND b.blocker_id=c.author_id)))) ORDER BY n.created_at DESC LIMIT 50`,[a.userId]);const items=[];
      for(const n of rows) {try {if(n.href.startsWith('/posts/')) await readablePost(a,n.href.split('/')[2]);items.push(n);} catch {}}return {items};
    }
    case 'notifications_read': human(a);await query('UPDATE notifications SET read_at=now() WHERE user_id=$1 AND read_at IS NULL',[a.userId]);return {ok:true};
    case 'reports_create': human(a);await readablePost(a,p.id);await query('INSERT INTO reports(id,reporter_id,post_id,reason) VALUES($1,$2,$3,$4)',[uid(),a.userId,p.id,p.reason]);return {ok:true};
    case 'admin_overview': await adminAccess(a);return {reports:await query('SELECT * FROM reports ORDER BY created_at DESC LIMIT 100'),jobs:await query(`SELECT id,kind,status,error,attempts FROM jobs WHERE status IN ('failed','blocked') ORDER BY created_at DESC LIMIT 100`),usage:await query("SELECT key,count,updated_at FROM usage_counters WHERE key ~ '^sms:[0-9]{4}-[0-9]{2}-[0-9]{2}$' OR key ~ '^ai-image:[0-9]{4}-[0-9]{2}$' ORDER BY updated_at DESC LIMIT 40"),users:await query(`SELECT u.id,u.name,u.image,p.banned,p.role FROM "user" u JOIN profiles p ON p.user_id=u.id WHERE p.deleted_at IS NULL ORDER BY p.created_at DESC LIMIT 100`)};
    case 'admin_stats': return adminStats(a);
    case 'admin_content_list': return adminContentList(a,{targetType:p.targetType,status:p.status,q:p.q,limit:p.limit,cursor:p.cursor});
    case 'admin_content_moderate': return adminContentModerate(a,{targetType:p.targetType,targetId:p.targetId,decision:p.decision,reason:p.reason});
    case 'admin_moderate': {
      await adminAccess(a);if(p.userId===a.userId) fail(400,'不能封禁当前管理员');
      return transaction(async client=>{
        await query('SELECT pg_advisory_xact_lock(1952805225)',[],client);await active(a,client);
        const [admin]=await query('SELECT role FROM profiles WHERE user_id=$1',[a.userId],client);if(admin?.role!=='admin')fail(403,'需要平台管理员权限');
        if(p.postId) {
          await query("UPDATE posts SET deleted_at=now(),moderation_status='deleted' WHERE id=$1",[p.postId],client);
          const cases=await query("UPDATE moderation_cases SET status='deleted',reason='管理员根据举报下架内容。',reviewed_by=$2,revision=revision+1,generation=generation+1,updated_at=now() WHERE target_type='post' AND target_id=$1 RETURNING id",[p.postId,a.userId],client);
          for(const item of cases)await query("INSERT INTO moderation_history(id,case_id,actor_id,action,status,reason) VALUES($1,$2,$3,'report_delete','deleted','管理员根据举报下架内容。')",[uid(),item.id,a.userId],client);
          await queueContentIndex(p.postId,client);
        }
        if(p.userId&&p.banned!==undefined) {
          const [target]=await query('SELECT role,deleted_at FROM profiles WHERE user_id=$1 FOR UPDATE',[p.userId],client);if(!target||target.deleted_at)fail(404,'用户不存在或已注销');
          if(p.banned&&target.role==='admin'&&!(await query("SELECT 1 FROM profiles WHERE user_id<>$1 AND role='admin' AND NOT banned AND deleted_at IS NULL LIMIT 1",[p.userId],client)).length)fail(409,'不能暂停唯一可用的平台管理员');
          await query('UPDATE profiles SET banned=$2 WHERE user_id=$1',[p.userId,p.banned],client);
        }
        if(p.reportId)await query(`UPDATE reports SET status='resolved' WHERE id=$1`,[p.reportId],client);await audit(a,action,p.postId||p.userId,client);return {ok:true};
      });
    }
    case 'jobs_retry': {
      human(a);const [j]=await query('SELECT * FROM jobs WHERE id=$1',[p.id]);if(!j) fail(404,'任务不存在');
      if(j.kind==='moderation')return moderationRetry(a,{id:j.target_id});
      const [profile]=await query('SELECT role FROM profiles WHERE user_id=$1',[a.userId]);
      if(profile?.role!=='admin') {const table=j.kind==='image'?'media':j.kind==='link'?'link_resources':'posts';const [target]=await query(`SELECT * FROM ${table} WHERE id=$1`,[j.target_id]);if(!target) fail(404,'内容不存在');const post=j.kind==='index'?target:await readablePost(a,target.post_id);if(post.author_id!==a.userId) fail(403,'只能重试自己的内容');}
      await query(`UPDATE jobs SET status='pending',attempts=0,error=NULL,available_at=now() WHERE id=$1 AND status IN ('failed','blocked')`,[p.id]);return {ok:true};
    }
    case 'moderation_list': return moderationList(a,p);
    case 'moderation_decide': return moderationDecide(a,p as {id:string;decision:'approve'|'delete';reason:string});
    case 'moderation_appeal': return moderationAppeal(a,p as {id:string;reason:string});
    case 'moderation_retry': return moderationRetry(a,p as {id:string});
    case 'moderation_withdraw': return moderationWithdraw(a,p as {id:string});
  }
}
