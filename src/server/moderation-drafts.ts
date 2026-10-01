import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { query,transaction } from './db';
import { active,communityAccess } from './permissions';
import { fail,type Actor,type Item } from '../shared/contracts';
import { enqueueModeration } from './moderation';

type Kind='profile'|'community'|'announcement'|'event'|'recap';
type Status='pending'|'review'|'rejected'|'approved'|'deleted';
const fields:Record<Kind,string[]>={profile:['name','bio','city'],community:['name','description','city'],announcement:['announcement'],event:['title','description','city','address','agentName'],recap:['recap']};
const names:Record<Kind,string>={profile:'个人资料',community:'社群介绍',announcement:'社群公告',event:'活动说明',recap:'活动回顾'};

export async function submitModerationDraft(actor:Actor,kind:Kind,payload:Item,targetId?:string,client?:PoolClient):Promise<Item> {
  if(!client)return transaction(tx=>submitModerationDraft(actor,kind,payload,targetId,tx));
  const [profile]=await query('SELECT user_id,avatar_media_id FROM profiles WHERE user_id=$1 FOR UPDATE',[actor.userId],client);
  await active(actor,client);
  if(kind==='profile') {
    const avatarId=payload.avatarMediaId===undefined?profile.avatar_media_id:payload.avatarMediaId;
    if(avatarId!==null) {
      const [image]=await query("UPDATE media SET usage_kind='avatar',ai_consent=false WHERE id=$1 AND owner_id=$2 AND post_id IS NULL AND moderation_status<>'deleted' AND mime IN ('image/png','image/jpeg','image/webp','image/gif') RETURNING id",[avatarId,actor.userId],client);
      if(!image)fail(400,'头像图片不存在、已用于动态或不属于你，请重新上传');
    }
    payload={...payload,avatarMediaId:avatarId};
  }
  const target=targetId||randomUUID();
  // A later edit supersedes any unapproved earlier edit. In-flight reviews
  // must read the draft again under lock before applying their result.
  await query('SELECT pg_advisory_xact_lock(hashtext($1))',[`content-draft:${kind}:${target}`],client);
  await query("UPDATE content_drafts SET status='deleted',payload='{}' WHERE kind=$1 AND target_id=$2 AND status IN ('pending','review','rejected')",[kind,target],client);
  const id=randomUUID();
  await query('INSERT INTO content_drafts(id,author_id,kind,target_id,payload) VALUES($1,$2,$3,$4,$5)',[id,actor.userId,kind,target,JSON.stringify({...payload,agentName:actor.agentName||null})],client);
  const review=await enqueueModeration('draft',id,actor.userId!,client);
  return {id:target,draftId:id,moderationId:review.id,moderationStatus:'pending'};
}

export async function readModerationDraft(id:string,client?:PoolClient) {
  const [draft]=await query(`SELECT * FROM content_drafts WHERE id=$1${client?' FOR UPDATE':''}`,[id],client);
  if(!draft)return undefined;
  const images=draft.kind==='profile'&&draft.payload.avatarMediaId?await query("SELECT id,storage_key,mime FROM media WHERE id=$1 AND owner_id=$2 AND usage_kind='avatar' AND post_id IS NULL AND moderation_status<>'deleted'",[draft.payload.avatarMediaId,draft.author_id],client):[];
  // A missing/reassigned original must never be treated as an image-free draft.
  const invalidAvatar=draft.kind==='profile'&&!!draft.payload.avatarMediaId&&!images.length;
  const avatarText=draft.kind==='profile'&&Object.hasOwn(draft.payload,'avatarMediaId')?`\n头像：${draft.payload.avatarMediaId?'使用提交的图片':'使用默认头像'}`:'';
  return {author_id:draft.author_id,text:`${names[draft.kind as Kind]}\n${fields[draft.kind as Kind].map(key=>String(draft.payload[key]||'')).join('\n')}${avatarText}`,deleted_at:draft.status==='deleted'||invalidAvatar?new Date():null,moderation_status:draft.status,images:images.map(image=>({id:image.id,storageKey:image.storage_key,mime:image.mime})),kind:draft.kind,target_id:draft.target_id};
}

export async function applyModerationDraft(id:string,status:Status,client:PoolClient) {
  const [d]=await query('SELECT * FROM content_drafts WHERE id=$1 FOR UPDATE',[id],client);
  if(!d||d.status==='deleted')fail(409,'这份修改已撤回或被后续修改替代');
  // A review of an old approved revision must never erase a newer version.
  const deletingCurrent=status==='deleted'&&d.status==='approved'&&(await query('DELETE FROM content_draft_heads WHERE kind=$1 AND target_id=$2 AND current_draft_id=$3 RETURNING current_draft_id',[d.kind,d.target_id,d.id],client)).length>0;
  if(deletingCurrent) {
    const p=d.payload;
    if(d.kind==='profile') {
      const [current]=await query('SELECT u.name,p.bio,p.city,p.avatar_media_id FROM "user" u JOIN profiles p ON p.user_id=u.id WHERE u.id=$1',[d.author_id],client);
      if(current?.name===p.name&&current.bio===p.bio&&current.city===p.city&&current.avatar_media_id===(p.avatarMediaId??null)) {
        await query('UPDATE "user" SET name=$2,image=NULL WHERE id=$1',[d.author_id,`社区成员${randomUUID().slice(0,6)}`],client);
        await query("UPDATE profiles SET bio='',city='',avatar_media_id=NULL WHERE user_id=$1",[d.author_id],client);
      }
    } else if(d.kind==='announcement')await query("UPDATE communities SET announcement='' WHERE id=$1 AND announcement=$2",[d.target_id,p.announcement],client);
    else if(d.kind==='recap')await query("UPDATE events SET recap='' WHERE id=$1 AND recap=$2",[d.target_id,p.recap],client);
    else if(d.kind==='event') {
      await query("UPDATE events SET title='已下架活动',description='',city='',address='',recap='',cancelled=true,moderation_removed_at=now() WHERE id=$1",[d.target_id],client);
      await query('UPDATE registrations SET attendee_name=NULL,phone_number=NULL,contact_consent_version=NULL,contact_consented_at=NULL WHERE event_id=$1',[d.target_id],client);
      await query("UPDATE content_drafts SET status='deleted',payload='{}' WHERE kind='recap' AND target_id=$1 AND status IN ('pending','review','rejected')",[d.target_id],client);
    } else if(d.kind==='community') {
      await query("UPDATE communities SET name='已下架社群',description='',city='',announcement='',moderation_removed_at=now() WHERE id=$1",[d.target_id],client);
      await query("UPDATE content_drafts SET status='deleted',payload='{}' WHERE kind='announcement' AND target_id=$1 AND status IN ('pending','review','rejected')",[d.target_id],client);
    }
  }
  if(status==='approved'&&d.status!=='approved') {
    const p=d.payload,author={userId:d.author_id};
    await active(author,client);
    if(d.kind==='profile') {
      if(p.avatarMediaId) {
        const [image]=await query("UPDATE media SET moderation_status='approved' WHERE id=$1 AND owner_id=$2 AND usage_kind='avatar' AND post_id IS NULL AND moderation_status<>'deleted' RETURNING id",[p.avatarMediaId,d.author_id],client);
        if(!image)fail(409,'头像图片已不可用，请重新上传并提交资料');
      }
      await query('UPDATE "user" SET name=$2,image=$3 WHERE id=$1',[d.author_id,p.name,p.avatarMediaId?`/api/v1/media/${p.avatarMediaId}`:null],client);
      await query('UPDATE profiles SET bio=$2,city=$3,avatar_media_id=$4 WHERE user_id=$1',[d.author_id,p.bio,p.city,p.avatarMediaId||null],client);
    } else if(d.kind==='community') {
      await query('INSERT INTO communities(id,name,description,city,visibility,owner_id) VALUES($1,$2,$3,$4,$5,$6)',[d.target_id,p.name,p.description,p.city,p.visibility,d.author_id],client);
      await query("INSERT INTO memberships(community_id,user_id,role,status) VALUES($1,$2,'admin','active')",[d.target_id,d.author_id],client);
    } else if(d.kind==='announcement') {
      await communityAccess(author,d.target_id,true,true,client);
      await query('UPDATE communities SET announcement=$2 WHERE id=$1',[d.target_id,p.announcement],client);
    } else if(d.kind==='event') {
      await communityAccess(author,p.communityId,true,true,client);
      if(new Date(p.startsAt)<=new Date())fail(409,'活动开始时间已过，请重新提交活动');
      await query('INSERT INTO events(id,community_id,organizer_id,title,description,city,address,starts_at,ends_at,capacity,agent_name) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)',[d.target_id,p.communityId,d.author_id,p.title,p.description,p.city,p.address,p.startsAt,p.endsAt,p.capacity,p.agentName],client);
    } else if(d.kind==='recap') {
      const [event]=await query('SELECT community_id FROM events WHERE id=$1 AND moderation_removed_at IS NULL',[d.target_id],client);
      if(!event)fail(404,'活动不存在');
      await communityAccess(author,event.community_id,true,true,client);
      await query('UPDATE events SET recap=$2 WHERE id=$1',[d.target_id,p.recap],client);
    }
    await query('INSERT INTO content_draft_heads(kind,target_id,current_draft_id) VALUES($1,$2,$3) ON CONFLICT(kind,target_id) DO UPDATE SET current_draft_id=EXCLUDED.current_draft_id',[d.kind,d.target_id,d.id],client);
  }
  await query('UPDATE content_drafts SET status=$2 WHERE id=$1',[id,status],client);
}
