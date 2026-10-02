import type { PoolClient } from 'pg';
import { query } from './db';
import { fail, type Actor, type Item } from '../shared/contracts';
export function user(actor:Actor) { return actor.userId || fail(401,'请先登录','UNAUTHORIZED'); }
export function scope(actor:Actor, name:string) { user(actor); if(actor.grantId && !actor.scopes?.includes(name)) fail(403,'Agent 未获得此操作授权','INSUFFICIENT_SCOPE'); }
export function human(actor:Actor) { user(actor); if(actor.grantId) fail(403,'此操作需要本人在网页中完成'); }
export async function active(actor:Actor, client?:PoolClient) {
  if(!actor.userId) return;
  const [p]=await query(`SELECT banned,deleted_at FROM profiles WHERE user_id=$1${client?' FOR SHARE':''}`,[actor.userId],client);
  if(!p||p.deleted_at) fail(401,'账户不存在或已注销','ACCOUNT_CLOSED');
  if(p?.banned) fail(403,'账户已被暂停使用');
  if(actor.grantId) {
    const [g]=await query('SELECT * FROM agent_grants WHERE id=$1 AND user_id=$2 AND revoked_at IS NULL AND expires_at>now()',[actor.grantId,actor.userId],client);
    if(!g) fail(401,'Agent 授权已失效','TOKEN_REVOKED');
    actor.scopes=actor.tokenScopes?g.scopes.filter((s:string)=>actor.tokenScopes!.includes(s)):g.scopes; actor.communityIds=g.community_ids; actor.agentName=g.name;
  }
}
export async function communityAccess(actor:Actor,id:string,write=false,admin=false,client?:PoolClient) {
  const [c]=await query(`SELECT c.*, m.status AS membership_status,m.role AS membership_role FROM communities c LEFT JOIN memberships m ON m.community_id=c.id AND m.user_id=$2 WHERE c.id=$1 AND c.moderation_removed_at IS NULL`,[id,actor.userId||''],client);
  if(!c) fail(404,'社群不存在');
  if((c.visibility==='private'||write) && c.membership_status!=='active') fail(403,'需要加入社群才能进行此操作');
  if(actor.grantId && (c.visibility==='private'||write) && !actor.communityIds?.includes(id)) fail(403,'Agent 未获得此社群的授权');
  if(admin && c.membership_role!=='admin') fail(403,'需要社群管理员权限');
  return c;
}
export async function readablePost(actor:Actor,id:string,client?:PoolClient,depth=0):Promise<Item> {
  if(depth>8) fail(400,'转发层级过深');
  const [p]=await query("SELECT * FROM posts WHERE id=$1 AND deleted_at IS NULL AND hidden_at IS NULL AND moderation_status='approved'",[id],client);
  if(!p) fail(404,'帖子不存在或已被删除');
  if(p.community_id) await communityAccess(actor,p.community_id,false,false,client);
  if(actor.userId) {
    const b=await query('SELECT 1 FROM blocks WHERE (blocker_id=$1 AND blocked_id=$2) OR (blocker_id=$2 AND blocked_id=$1)',[actor.userId,p.author_id],client);
    if(b.length) fail(404,'内容不可见');
  }
  if(p.original_id) await readablePost(actor,p.original_id,client,depth+1);
  return p;
}
export async function adminAccess(actor:Actor) {
  human(actor); const [p]=await query('SELECT role FROM profiles WHERE user_id=$1',[actor.userId]);
  if(p?.role!=='admin') fail(403,'需要平台管理员权限');
}
/** Live ACL predicate including original-post ancestry; identifiers are internal constants. */
export function visiblePostSQL(alias:string,uid:string,groups:string,agent:string) {
  return `NOT EXISTS (
    WITH RECURSIVE ancestors AS (
      SELECT id,original_id,community_id,author_id,deleted_at,hidden_at,moderation_status,0 AS depth FROM posts WHERE id=${alias}.id
      UNION ALL SELECT o.id,o.original_id,o.community_id,o.author_id,o.deleted_at,o.hidden_at,o.moderation_status,x.depth+1 FROM posts o JOIN ancestors x ON o.id=x.original_id WHERE x.depth<9
    ) SELECT 1 FROM ancestors x LEFT JOIN communities ac ON ac.id=x.community_id
      LEFT JOIN memberships am ON am.community_id=ac.id AND am.user_id=${uid}
    WHERE x.deleted_at IS NOT NULL OR x.hidden_at IS NOT NULL OR x.moderation_status<>'approved' OR x.depth>=9 OR ac.moderation_removed_at IS NOT NULL
      OR (ac.visibility='private' AND (am.status IS DISTINCT FROM 'active' OR (${agent}::boolean AND NOT(ac.id=ANY(${groups}::text[])))))
      OR EXISTS(SELECT 1 FROM blocks b WHERE (b.blocker_id=${uid} AND b.blocked_id=x.author_id) OR (b.blocked_id=${uid} AND b.blocker_id=x.author_id))
  )`;
}
/** Visibility gate without viewer ACL, for administrators and index removal. */
export function unavailablePostSQL(alias:string) {
  return `EXISTS (WITH RECURSIVE ancestors AS (
    SELECT id,original_id,community_id,deleted_at,hidden_at,moderation_status,0 AS depth FROM posts WHERE id=${alias}.id
    UNION ALL SELECT p.id,p.original_id,p.community_id,p.deleted_at,p.hidden_at,p.moderation_status,a.depth+1 FROM posts p JOIN ancestors a ON p.id=a.original_id WHERE a.depth<9
  ) SELECT 1 FROM ancestors a LEFT JOIN communities c ON c.id=a.community_id
    WHERE a.deleted_at IS NOT NULL OR a.hidden_at IS NOT NULL OR a.moderation_status<>'approved' OR a.depth>=9 OR c.moderation_removed_at IS NOT NULL)`;
}
