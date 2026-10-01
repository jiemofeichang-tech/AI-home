import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { query, transaction } from './db';
import { config } from './config';
import { objectStorageLocation } from './storage';
import { human } from './permissions';
import { fail, type Actor } from '../shared/contracts';
import { EVENT_CONTACT_RETENTION_DAYS } from '../shared/privacy';
import { publicationReason } from './moderation';

async function privacyAccount(actor:Actor,client:PoolClient,lock:'SHARE'|'UPDATE') {
  human(actor);
  const [profile]=await query(`SELECT p.*,u.name,u.email,u.image,u."phoneNumber",u."createdAt" AS account_created_at
    FROM profiles p JOIN "user" u ON u.id=p.user_id WHERE p.user_id=$1 FOR ${lock} OF p`,[actor.userId],client);
  if(!profile||profile.deleted_at) fail(404,'账户不存在或已注销','ACCOUNT_CLOSED');
  return profile;
}

/** Explicit fields only: exports must never inherit new credential columns. */
export async function exportOwnData(actor:Actor) {
  return transaction(async client=>{
    await client.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
    const p=await privacyAccount(actor,client,'SHARE');
    const read=(sql:string)=>query(sql,[actor.userId],client);
    return {
      formatVersion:1,exportedAt:new Date().toISOString(),
      profile:{id:p.user_id,name:p.name,phoneNumber:p.phoneNumber,image:p.image,handle:p.handle,bio:p.bio,city:p.city,role:p.role,banned:p.banned,createdAt:p.account_created_at,lastSeenAt:p.last_seen_at,privacyVersion:p.privacy_version,privacyAcceptedAt:p.privacy_accepted_at},
      posts:await read('SELECT id,community_id,body,tags,original_id,agent_name,deleted_at,created_at FROM posts WHERE author_id=$1 ORDER BY created_at'),
      comments:await read('SELECT id,post_id,body,agent_name,deleted_at,created_at FROM comments WHERE author_id=$1 ORDER BY created_at'),
      media:await read('SELECT id,post_id,mime,bytes,original_name,extracted_text,description,status,ai_consent,created_at FROM media WHERE owner_id=$1 ORDER BY created_at'),
      links:await read('SELECT l.post_id,l.url,l.platform,l.title,l.description,l.content,l.status FROM link_resources l JOIN posts p ON p.id=l.post_id WHERE p.author_id=$1'),
      memberships:await read('SELECT community_id,role,status,created_at FROM memberships WHERE user_id=$1'),
      communities:await read('SELECT id,name,description,city,visibility,announcement,created_at FROM communities WHERE owner_id=$1'),
      events:await read('SELECT id,community_id,title,description,city,address,starts_at,ends_at,capacity,cancelled,recap,created_at FROM events WHERE organizer_id=$1'),
      registrations:await read('SELECT r.event_id,e.title AS event_title,r.attendee_name,r.phone_number,r.checked_in_at,r.created_at,r.contact_consent_version,r.contact_consented_at FROM registrations r JOIN events e ON e.id=r.event_id WHERE r.user_id=$1 ORDER BY r.created_at'),
      reactions:await read('SELECT post_id,kind FROM reactions WHERE user_id=$1'),
      follows:await read('SELECT following_id FROM follows WHERE follower_id=$1'),
      blocks:await read('SELECT blocked_id FROM blocks WHERE blocker_id=$1'),
      notifications:await read('SELECT text,href,read_at,created_at FROM notifications WHERE user_id=$1 ORDER BY created_at'),
      reports:await read('SELECT post_id,reason,status,created_at FROM reports WHERE reporter_id=$1'),
      moderation:(await read('SELECT id,target_type,target_id,status,appeal_reason,created_at,updated_at FROM moderation_cases WHERE author_id=$1 ORDER BY created_at')).map(entry=>({...entry,userReason:publicationReason({target_type:entry.target_type,appeal_reason:entry.appeal_reason},entry.status)})),
      contentDrafts:await read('SELECT id,kind,target_id,payload,status,created_at FROM content_drafts WHERE author_id=$1 ORDER BY created_at'),
      authorizations:await read('SELECT id,name,scopes,community_ids,expires_at,revoked_at,created_at FROM agent_grants WHERE user_id=$1'),
      oauthClients:await read('SELECT "clientId",name,"createdAt" FROM "oauthClient" WHERE "userId"=$1'),
    };
  });
}

export async function expireEventContactData():Promise<number> {
  const rows=await query(`UPDATE registrations r SET attendee_name=NULL,phone_number=NULL,contact_consent_version=NULL,contact_consented_at=NULL
    FROM events e WHERE e.id=r.event_id AND (e.cancelled OR e.ends_at < now()-($1::int * interval '1 day'))
    AND (r.attendee_name IS NOT NULL OR r.phone_number IS NOT NULL OR r.contact_consent_version IS NOT NULL OR r.contact_consented_at IS NOT NULL)
    RETURNING r.event_id`,[EVENT_CONTACT_RETENTION_DAYS]);
  return rows.length;
}

async function queueObjectDeletion(id:string,key:string,client:PoolClient) {
  const [entry]=await query(`INSERT INTO privacy_object_deletions(id,storage_key,storage_backend,storage_location) VALUES($1,$2,$3,$4)
    ON CONFLICT(storage_key) DO UPDATE SET storage_key=excluded.storage_key RETURNING id`,[id,key,config.storage,objectStorageLocation()],client);
  await query(`INSERT INTO jobs(id,kind,target_id) VALUES($1,'delete-object',$2)
    ON CONFLICT(kind,target_id) DO UPDATE SET status='pending',attempts=0,error=NULL,available_at=now(),locked_at=NULL`,[randomUUID(),entry.id],client);
}

/** Compensate an upload whose object succeeded but database commit failed. */
export async function scheduleObjectDeletion(key:string):Promise<void> {
  await transaction(async client=>{await queueObjectDeletion(randomUUID(),key,client);});
}

async function closeAccountTransaction(actor:Actor) {
  return transaction(async client=>{
    // Matches the registration bootstrap lock; two last-admin changes cannot
    // independently decide there is another administrator.
    await query('SELECT pg_advisory_xact_lock(1952805225)',[],client);
    const account=await privacyAccount(actor,client,'UPDATE');
    const id=actor.userId!;
    const run=(sql:string,params:unknown[]=[id])=>query(sql,params,client);
    if((await run('SELECT 1 FROM communities WHERE owner_id=$1 LIMIT 1')).length)
      fail(409,'你仍是社群创建者，请先联系运营移交社群，再注销账户。','ACCOUNT_OWNS_COMMUNITIES');
    if(account.role==='admin'&&!(await run(`SELECT 1 FROM profiles WHERE user_id<>$1 AND role='admin' AND NOT banned AND deleted_at IS NULL LIMIT 1`)).length)
      fail(409,'你是唯一可用的平台管理员，请先由运营安排其他管理员，再注销账户。','ACCOUNT_LAST_ADMIN');

    const media=await run('SELECT id,storage_key FROM media WHERE owner_id=$1');
    for(const item of media) await queueObjectDeletion(randomUUID(),item.storage_key,client);
    await run("DELETE FROM jobs WHERE kind='moderation' AND target_id IN (SELECT id FROM moderation_cases WHERE author_id=$1)");
    // Cases never keep a second copy of post text. Draft payloads and decision
    // history are removed too, so a later review cannot restore erased data.
    await run('DELETE FROM moderation_cases WHERE author_id=$1');
    // Keep the manual decision boundary, while removing free-form personal
    // text the closing moderator wrote about someone else's submission.
    await run("UPDATE moderation_cases SET reason='处理说明已随审核人注销清除。' WHERE reviewed_by=$1");
    await run("UPDATE moderation_history SET actor_id=NULL,reason='操作说明已随操作人注销清除。' WHERE actor_id=$1");
    await run('DELETE FROM content_drafts WHERE author_id=$1');
    // Remove jobs before their targets; a running worker can no longer write
    // extracted content after the rows disappear. Index jobs remain durable.
    await run(`DELETE FROM jobs WHERE (kind='image' AND target_id IN (SELECT id FROM media WHERE owner_id=$1))
      OR (kind='link' AND target_id IN (SELECT l.id FROM link_resources l JOIN posts p ON p.id=l.post_id WHERE p.author_id=$1))`);
    await run('DELETE FROM media WHERE owner_id=$1');
    await run('DELETE FROM link_resources WHERE post_id IN (SELECT id FROM posts WHERE author_id=$1)');
    const posts=await run(`UPDATE posts SET body='',tags='{}',original_id=NULL,agent_name=NULL,idempotency_key=NULL,deleted_at=coalesce(deleted_at,now()) WHERE author_id=$1 RETURNING id`);
    for(const post of posts) await run(`INSERT INTO jobs(id,kind,target_id) VALUES($1,'index',$2)
      ON CONFLICT(kind,target_id) DO UPDATE SET status='pending',attempts=0,error=NULL,available_at=now(),locked_at=NULL`,[randomUUID(),post.id]);
    await run(`UPDATE comments SET body='',agent_name=NULL,deleted_at=coalesce(deleted_at,now()) WHERE author_id=$1`);
    await run(`UPDATE events SET title='已取消活动',description='',city='',address='',recap='',agent_name=NULL,cancelled=true WHERE organizer_id=$1`);
    await run(`UPDATE registrations SET attendee_name=NULL,phone_number=NULL,contact_consent_version=NULL,contact_consented_at=NULL
      WHERE event_id IN (SELECT id FROM events WHERE organizer_id=$1)`);
    await run('DELETE FROM registrations WHERE user_id=$1');
    await run('DELETE FROM memberships WHERE user_id=$1');
    await run('DELETE FROM reactions WHERE user_id=$1');
    await run('DELETE FROM follows WHERE follower_id=$1 OR following_id=$1');
    await run('DELETE FROM blocks WHERE blocker_id=$1 OR blocked_id=$1');
    await run('DELETE FROM notifications WHERE user_id=$1');
    await run('DELETE FROM reports WHERE reporter_id=$1');
    await run('DELETE FROM request_keys WHERE user_id=$1');
    await run('DELETE FROM audit_logs WHERE user_id=$1 OR grant_id IN (SELECT id FROM agent_grants WHERE user_id=$1)');
    await run('DELETE FROM agent_grants WHERE user_id=$1');

    // A personally registered OAuth app is removed with its credentials, so
    // other users cannot keep authorizing an app whose owner has closed it.
    await run(`UPDATE agent_grants SET revoked_at=coalesce(revoked_at,now()) WHERE oauth_client_id IN (SELECT "clientId" FROM "oauthClient" WHERE "userId"=$1)`);
    await run(`DELETE FROM "oauthAccessToken" WHERE "userId"=$1 OR "clientId" IN (SELECT "clientId" FROM "oauthClient" WHERE "userId"=$1)
      OR "refreshId" IN (SELECT id FROM "oauthRefreshToken" WHERE "userId"=$1)`);
    await run('DELETE FROM "oauthRefreshToken" WHERE "userId"=$1 OR "clientId" IN (SELECT "clientId" FROM "oauthClient" WHERE "userId"=$1)');
    await run('DELETE FROM "oauthConsent" WHERE "userId"=$1 OR "clientId" IN (SELECT "clientId" FROM "oauthClient" WHERE "userId"=$1)');
    await run('DELETE FROM "oauthClientResource" WHERE "clientId" IN (SELECT "clientId" FROM "oauthClient" WHERE "userId"=$1)');
    await run('DELETE FROM "oauthClient" WHERE "userId"=$1');
    await run('DELETE FROM "session" WHERE "userId"=$1');
    await run('DELETE FROM "account" WHERE "userId"=$1');
    await run(`DELETE FROM verification WHERE privacy_verification_user(value)=$1 OR identifier=$2 OR identifier=$2||'-request-password-reset'`,[id,account.phoneNumber]);
    await run(`DELETE FROM usage_counters WHERE key LIKE 'upload:'||$1||':%' OR ($2::text IS NOT NULL AND (key='dev-otp:'||$2 OR key LIKE 'sms:%:'||$2))`,[id,account.phoneNumber]);
    // Keep the consumed state and nonreversible code hash; nulling used_by would
    // either violate the check constraint or accidentally reopen an invitation.
    await run(`UPDATE invitation_codes SET label='',revoked_at=coalesce(revoked_at,now()) WHERE created_by=$1 OR used_by=$1`);
    await run(`UPDATE "user" SET name='已注销账户',email=$2,"emailVerified"=false,"phoneNumber"=NULL,"phoneNumberVerified"=false,image=NULL,"updatedAt"=now() WHERE id=$1`,[id,`${randomUUID()}@deleted.invalid`]);
    // This is deliberately last: guard triggers allow the scrub above, then
    // reject all later writes even from requests authenticated before closure.
    await run(`UPDATE profiles SET handle=$2,bio='',city='',avatar_media_id=NULL,role='member',banned=true,privacy_version=NULL,privacy_accepted_at=NULL,last_seen_at=NULL,deleted_at=now() WHERE user_id=$1`,[id,`deleted_${randomUUID().replaceAll('-','')}`]);
    return {closed:true as const,pendingObjectDeletions:media.length,retainedPlaceholder:true as const};
  });
}

/** The HTTP caller must check a recent human session and confirmation phrase. */
export async function closeAccount(actor:Actor) {
  human(actor);
  for(let attempt=0;;attempt++) {
    try {return await closeAccountTransaction(actor);}
    catch(error) {
      // Row guards can meet an already-running write in the opposite lock
      // order. PostgreSQL rolls one transaction back; retry the whole scrub.
      if(attempt>=2||!['40P01','40001'].includes(String((error as {code?:string}).code))) throw error;
    }
  }
}
