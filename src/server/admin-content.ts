import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { query,transaction } from './db';
import { active,human,unavailablePostSQL } from './permissions';
import { fail,type Actor,type Item } from '../shared/contracts';
import { isVideoMime } from '../shared/video';

type TargetType='post'|'comment';
async function admin(actor:Actor,client?:PoolClient) {
  human(actor);await active(actor,client);
  const [profile]=await query('SELECT role FROM profiles WHERE user_id=$1',[actor.userId],client);
  if(profile?.role!=='admin')fail(403,'需要平台管理员权限');
}

/** Invalidate every indexed quote as well as the original. Public reads also
 * check the live ancestry, including while the search service is unavailable. */
export async function queueContentIndex(postId:string,client:PoolClient) {
  const rows=await query(`WITH RECURSIVE descendants AS (
    SELECT id FROM posts WHERE id=$1 UNION SELECT p.id FROM posts p JOIN descendants d ON p.original_id=d.id
  ) SELECT id FROM descendants ORDER BY id`,[postId],client);
  for(const row of rows)await query(`INSERT INTO jobs(id,kind,target_id) VALUES($1,'index',$2)
    ON CONFLICT(kind,target_id) DO UPDATE SET status='pending',attempts=0,error=NULL,available_at=now(),locked_at=NULL`,[randomUUID(),row.id],client);
}

export async function adminContentList(actor:Actor,input:{targetType:TargetType;status:string;q?:string;limit:number;cursor?:string}) {
  await admin(actor);
  const table=input.targetType==='post'?'posts':'comments';
  const values:unknown[]=[],conditions:string[]=[];
  const bind=(value:unknown)=>{values.push(value);return `$${values.length}`;};
  const unavailable=`(t.deleted_at IS NOT NULL OR t.hidden_at IS NOT NULL OR t.moderation_status<>'approved' OR ${unavailablePostSQL('p')})`;
  if(input.status==='deleted')conditions.push('t.deleted_at IS NOT NULL');
  if(input.status==='hidden')conditions.push('t.hidden_at IS NOT NULL AND t.deleted_at IS NULL');
  if(input.status==='visible')conditions.push(`NOT ${unavailable}`);
  if(input.q) {
    const q=bind(`%${input.q.replace(/[\\%_]/g,'\\$&')}%`);
    conditions.push(`(t.body ILIKE ${q} OR u.name ILIKE ${q})`);
  }
  if(input.cursor) {
    const [cursor]=await query(`SELECT created_at::text AS created_at,id FROM ${table} WHERE id=$1`,[input.cursor]);
    if(!cursor)fail(400,'分页位置已失效，请重新加载');
    conditions.push(`(t.created_at,t.id)<(${bind(cursor.created_at)},${bind(cursor.id)})`);
  }
  const rows=await query(`SELECT t.*,u.name AS author_name,c.name AS community_name,c.visibility AS community_visibility,
    p.hidden_at AS post_hidden_at,p.deleted_at AS post_deleted_at,p.moderation_status AS post_moderation_status,
    mc.status AS safety_status,${unavailable} AS unavailable
    FROM ${table} t JOIN "user" u ON u.id=t.author_id
    JOIN posts p ON p.id=${input.targetType==='post'?'t.id':'t.post_id'}
    LEFT JOIN communities c ON c.id=p.community_id
    LEFT JOIN moderation_cases mc ON mc.target_type='${input.targetType}' AND mc.target_id=t.id
    ${conditions.length?`WHERE ${conditions.join(' AND ')}`:''}
    ORDER BY t.created_at DESC,t.id DESC LIMIT ${bind(input.limit+1)}`,values);
  const page=rows.slice(0,input.limit),items:Item[]=[];
  for(const row of page){
    const media=input.targetType==='post'&&!row.deleted_at?await query('SELECT id,mime FROM media WHERE post_id=$1 ORDER BY position NULLS LAST,created_at,id',[row.id]):[];
    items.push({id:row.id,targetType:input.targetType,authorId:row.author_id,authorName:row.author_name,body:row.body,
    hiddenAt:row.hidden_at,deletedAt:row.deleted_at,moderationStatus:row.safety_status||row.moderation_status,createdAt:row.created_at,
    communityName:row.community_name,communityVisibility:row.community_visibility,unavailable:row.unavailable,
    ...(input.targetType==='comment'?{postId:row.post_id,postHiddenAt:row.post_hidden_at,postDeletedAt:row.post_deleted_at,postModerationStatus:row.post_moderation_status}:{}),
    images:media.filter(item=>!isVideoMime(item.mime)).map(item=>item.id),videos:media.filter(item=>isVideoMime(item.mime)).map(item=>({id:item.id,mime:item.mime}))});
  }
  return {items,nextCursor:rows.length>input.limit?page.at(-1)!.id:null};
}

export async function adminContentModerate(actor:Actor,input:{targetType:TargetType;targetId:string;decision:'hide'|'restore'|'delete';reason?:string}) {
  await admin(actor);
  return transaction(async client=>{
    await admin(actor,client);
    const table=input.targetType==='post'?'posts':'comments';
    const [hint]=await query(`SELECT author_id FROM ${table} WHERE id=$1`,[input.targetId],client);
    if(!hint)fail(404,'内容不存在');
    // Match moderation/account-erasure lock order: author profile, target, case.
    const [author]=await query('SELECT deleted_at FROM profiles WHERE user_id=$1 FOR SHARE',[hint.author_id],client);
    if(!author||author.deleted_at)fail(404,'内容作者已注销');
    const [target]=await query(`SELECT * FROM ${table} WHERE id=$1 FOR UPDATE`,[input.targetId],client);
    if(!target)fail(404,'内容不存在');
    if(target.deleted_at) {
      if(input.decision==='delete')return {ok:true,hiddenAt:target.hidden_at,deletedAt:target.deleted_at,moderationStatus:'deleted'};
      fail(409,'已删除的内容不能隐藏或恢复');
    }
    // Preserve the actual verdict for legacy content before the DB visibility
    // guard changes the entity to review. Never assume approval on restore.
    await query(`INSERT INTO moderation_cases(id,target_type,target_id,author_id,status,provider)
      VALUES($1,$2,$3,$4,$5,'legacy') ON CONFLICT(target_type,target_id) DO NOTHING`,[randomUUID(),input.targetType,input.targetId,target.author_id,target.moderation_status],client);
    const [entry]=await query('SELECT * FROM moderation_cases WHERE target_type=$1 AND target_id=$2 FOR UPDATE',[input.targetType,input.targetId],client);
    if(entry.status==='deleted'&&input.decision!=='delete')fail(409,'已删除的审核记录不能恢复');
    let changed:Item;
    if(input.decision==='hide') {
      [changed]=await query(`UPDATE ${table} SET hidden_at=coalesce(hidden_at,now()) WHERE id=$1 RETURNING *`,[input.targetId],client);
    } else if(input.decision==='restore') {
      if(!target.hidden_at)fail(409,'内容未被隐藏');
      [changed]=await query(`UPDATE ${table} SET hidden_at=NULL,moderation_status=$2 WHERE id=$1 RETURNING *`,[input.targetId,entry.status],client);
    } else {
      [changed]=await query(`UPDATE ${table} SET deleted_at=now(),moderation_status='deleted' WHERE id=$1 RETURNING *`,[input.targetId],client);
      await query(`UPDATE moderation_cases SET status='deleted',reviewed_by=$3,reason=$4,revision=revision+1,generation=generation+1,updated_at=now()
        WHERE target_type=$1 AND target_id=$2`,[input.targetType,input.targetId,actor.userId,input.reason?.trim()||'管理员已删除内容。'],client);
      await query(`UPDATE jobs SET status='done',error=NULL,locked_at=NULL WHERE (kind='moderation' AND target_id IN (
        SELECT id FROM moderation_cases WHERE (target_type=$1 AND target_id=$2)
        OR ($1='post' AND ((target_type='media' AND target_id IN (SELECT id FROM media WHERE post_id=$2)) OR (target_type='link' AND target_id IN (SELECT id FROM link_resources WHERE post_id=$2))))))
        OR ($1='post' AND ((kind='image' AND target_id IN (SELECT id FROM media WHERE post_id=$2)) OR (kind='link' AND target_id IN (SELECT id FROM link_resources WHERE post_id=$2))))`,[input.targetType,input.targetId],client);
    }
    if(input.decision!=='restore') {
      if(input.targetType==='comment')await query('DELETE FROM notifications WHERE comment_id=$1',[input.targetId],client);
      else await query(`DELETE FROM notifications WHERE href=$1`,[`/posts/${input.targetId}`],client);
    }
    if(input.targetType==='post')await queueContentIndex(input.targetId,client);
    const status=input.decision==='delete'?'deleted':entry.status;
    await query('INSERT INTO moderation_history(id,case_id,actor_id,action,status,reason) VALUES($1,$2,$3,$4,$5,$6)',
      [randomUUID(),entry.id,actor.userId,`admin_${input.decision}`,status,input.reason?.trim()||({hide:'管理员已隐藏内容。',restore:'管理员已取消隐藏，发布范围仍由审核结果决定。',delete:'管理员已删除内容。'}[input.decision])],client);
    await query('INSERT INTO audit_logs(id,user_id,action,target_id) VALUES($1,$2,$3,$4)',[randomUUID(),actor.userId,`admin_content_${input.decision}`,input.targetId],client);
    return {ok:true,hiddenAt:changed.hidden_at,deletedAt:changed.deleted_at,moderationStatus:status};
  });
}
