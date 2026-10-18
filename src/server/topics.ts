import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { query } from './db';
import { adminAccess,human } from './permissions';
import { fail,type Actor,type Item } from '../shared/contracts';

const columns='t.id,t.slug,t.name,t.description,t.icon,t.section,t.position,t.posting,t.archived_at,t.created_at,t.updated_at';
const published="p.topic_id=t.id AND p.deleted_at IS NULL AND p.hidden_at IS NULL AND p.moderation_status='approved'";
const stats=`(SELECT count(*)::int FROM posts p WHERE ${published}) AS post_count,(SELECT max(p.created_at) FROM posts p WHERE ${published}) AS last_post_at`;

async function platformAdmin(actor:Actor,client?:PoolClient) {
  if(!actor.userId||actor.grantId)return false;
  const [profile]=await query('SELECT role FROM profiles WHERE user_id=$1 AND deleted_at IS NULL',[actor.userId],client);
  return profile?.role==='admin';
}
function withPermissions(topic:Item,actor:Actor,admin:boolean) {
  const member=!!actor.userId&&(!actor.grantId||!!actor.scopes?.includes('posts:write'));
  return {...topic,canPost:!topic.archived_at&&(topic.posting==='admins'?admin:member)};
}

export async function listTopics(actor:Actor,includeArchived:boolean) {
  const admin=await platformAdmin(actor);
  const rows=await query(`SELECT ${columns},${stats} FROM topics t WHERE ($1::boolean OR t.archived_at IS NULL)
    ORDER BY t.archived_at NULLS FIRST,t.position,t.created_at,t.id`,[includeArchived&&admin]);
  return {items:rows.map(row=>withPermissions(row,actor,admin))};
}

export async function getTopic(actor:Actor,key:string) {
  const admin=await platformAdmin(actor);
  const [row]=await query(`SELECT ${columns},${stats} FROM topics t WHERE t.id=$1 OR t.slug=$1 ORDER BY (t.id=$1) DESC LIMIT 1`,[key]);
  if(!row||(row.archived_at&&!admin))fail(404,'板块不存在或已归档');
  return withPermissions(row,actor,admin);
}

/** Lock the board for a new post; an archive committed first wins. */
export async function postingTopic(actor:Actor,id:string,client:PoolClient) {
  const [topic]=await query('SELECT * FROM topics WHERE id=$1 AND archived_at IS NULL FOR SHARE',[id],client);
  if(!topic)fail(404,'板块不存在或已归档');
  if(topic.posting==='admins'&&!await platformAdmin(actor,client))fail(403,`「${topic.name}」仅平台管理员本人可以发布`);
  return topic;
}

export async function saveTopic(actor:Actor,input:Item) {
  await adminAccess(actor);
  const values=[input.slug,input.name,input.description,input.icon,input.section,input.position,input.posting,input.archived];
  try {
    const [row]=input.id
      ?await query(`UPDATE topics SET slug=$2,name=$3,description=$4,icon=$5,section=$6,position=$7,posting=$8,
          archived_at=CASE WHEN $9::boolean THEN coalesce(archived_at,now()) END,updated_at=now() WHERE id=$1 RETURNING *`,[input.id,...values])
      :await query(`INSERT INTO topics(id,slug,name,description,icon,section,position,posting,archived_at)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,CASE WHEN $9::boolean THEN now() END) RETURNING *`,[randomUUID(),...values]);
    if(!row)fail(404,'板块不存在');
    await query('INSERT INTO audit_logs(id,user_id,action,target_id) VALUES($1,$2,$3,$4)',[randomUUID(),actor.userId,input.id?'topics_update':'topics_create',row.id]);
    return row;
  } catch(error) {
    if((error as {code?:string}).code==='23505')fail(409,'板块标识已被使用，请换一个');
    throw error;
  }
}

/** Progress counts only published results; submissions under review are reported as pending. */
export async function onboarding(actor:Actor) {
  if(!actor.userId)return {guest:true,dismissed:false,completed:0,total:4,steps:[]};
  human(actor);
  const [row]=await query(`SELECT p.bio,p.city,u.image,p.onboarding_dismissed_at,
    EXISTS(SELECT 1 FROM content_drafts d WHERE d.author_id=p.user_id AND d.kind='profile' AND d.status IN ('pending','review')) AS profile_pending,
    EXISTS(SELECT 1 FROM topics WHERE id='introductions' AND archived_at IS NULL) AS intro_open,
    EXISTS(SELECT 1 FROM posts WHERE author_id=p.user_id AND topic_id='introductions' AND deleted_at IS NULL AND hidden_at IS NULL AND moderation_status='approved') AS intro_done,
    EXISTS(SELECT 1 FROM posts WHERE author_id=p.user_id AND topic_id='introductions' AND deleted_at IS NULL AND moderation_status IN ('pending','review')) AS intro_pending,
    EXISTS(SELECT 1 FROM memberships WHERE user_id=p.user_id AND status='active') AS joined,
    EXISTS(SELECT 1 FROM memberships WHERE user_id=p.user_id AND status='pending') AS join_pending,
    EXISTS(SELECT 1 FROM reactions WHERE user_id=p.user_id AND kind='like') OR EXISTS(SELECT 1 FROM comments WHERE author_id=p.user_id AND deleted_at IS NULL) AS engaged,
    EXISTS(SELECT 1 FROM agent_grants WHERE user_id=p.user_id AND revoked_at IS NULL AND expires_at>now()) AS agent
    FROM profiles p JOIN "user" u ON u.id=p.user_id WHERE p.user_id=$1 AND p.deleted_at IS NULL`,[actor.userId]);
  if(!row)fail(401,'账户不存在或已注销','ACCOUNT_CLOSED');
  const steps=[
    {key:'profile',done:!!(row.bio||row.city||row.image),pending:row.profile_pending,optional:false},
    ...(row.intro_open?[{key:'introduce',done:row.intro_done,pending:row.intro_pending,optional:false}]:[]),
    {key:'community',done:row.joined,pending:row.join_pending,optional:false},
    {key:'engage',done:row.engaged,pending:false,optional:false},
    {key:'agent',done:row.agent,pending:false,optional:true},
  ];
  const required=steps.filter(step=>!step.optional);
  return {guest:false,dismissed:!!row.onboarding_dismissed_at,completed:required.filter(step=>step.done).length,total:required.length,steps};
}

export async function dismissOnboarding(actor:Actor,dismissed:boolean) {
  human(actor);
  await query('UPDATE profiles SET onboarding_dismissed_at=CASE WHEN $2::boolean THEN now() END WHERE user_id=$1',[actor.userId,dismissed]);
  return {ok:true,dismissed};
}
