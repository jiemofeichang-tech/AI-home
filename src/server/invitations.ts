import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { fail, type Actor } from '../shared/contracts';
import { query, transaction } from './db';
import { active, adminAccess } from './permissions';

type CreatedInvitation = { id:string; code:string; label:string; expiresAt:Date };
type InvitationSummary = {
  id:string; label:string; codeHint:string; expiresAt:Date; createdAt:Date;
  usedAt:Date|null; usedByName:string|null; revokedAt:Date|null;
};
type AvailableInvitation = { id:string; expiresAt:Date };

/** Codes are case-sensitive; whitespace copied around them is not significant. */
export function hashInvitationCode(code:string):string {
  return createHash('sha256').update(code.trim()).digest('hex');
}

/**
 * Read availability without revealing the stored hash or member information.
 * A transaction client locks the matching row, but the auth transaction must
 * still conditionally UPDATE the unused, unrevoked, unexpired code and check
 * RETURNING before committing the newly created account.
 */
export async function findAvailableInvitation(code:string,client?:PoolClient):Promise<AvailableInvitation|undefined> {
  if(!code.trim())return undefined;
  const [invitation]=await query<AvailableInvitation>(`
    SELECT id,expires_at AS "expiresAt" FROM invitation_codes
    WHERE code_hash=$1 AND used_by IS NULL AND used_at IS NULL
      AND revoked_at IS NULL AND expires_at>now()
    ${client?'FOR UPDATE':''}
  `,[hashInvitationCode(code)],client);
  return invitation;
}

async function invitationAdmin(actor:Actor) {
  await active(actor);
  await adminAccess(actor);
}

export async function createInvitations(input:{count:number;days:number;label?:string},actor:Actor):Promise<{items:CreatedInvitation[]}> {
  await invitationAdmin(actor);
  if(!Number.isInteger(input.count)||input.count<1||input.count>20)fail(400,'每次可生成 1 至 20 个邀请码','INVALID_INPUT');
  if(!Number.isInteger(input.days)||input.days<1||input.days>30)fail(400,'邀请码有效期为 1 至 30 天','INVALID_INPUT');
  if(input.label!==undefined&&typeof input.label!=='string')fail(400,'请输入有效的邀请码备注','INVALID_INPUT');
  const label=input.label?.trim()||'';
  if(label.length>120)fail(400,'邀请码备注最多 120 个字符','INVALID_INPUT');
  return transaction(async client=>{
    const items:CreatedInvitation[]=[];
    for(let index=0;index<input.count;index++) {
      const code=randomBytes(18).toString('base64url');
      const [invitation]=await query<Omit<CreatedInvitation,'code'>>(`
        INSERT INTO invitation_codes(id,label,code_hash,code_hint,created_by,expires_at)
        VALUES($1,$2,$3,$4,$5,now()+$6::integer*interval '1 day')
        RETURNING id,label,expires_at AS "expiresAt"
      `,[randomUUID(),label,hashInvitationCode(code),code.slice(-4),actor.userId,input.days],client);
      items.push({...invitation,code});
    }
    return {items};
  });
}

export async function listInvitations(actor:Actor):Promise<{items:InvitationSummary[]}> {
  await invitationAdmin(actor);
  const items=await query<InvitationSummary>(`
    SELECT i.id,i.label,i.code_hint AS "codeHint",i.expires_at AS "expiresAt",
      i.created_at AS "createdAt",i.used_at AS "usedAt",u.name AS "usedByName",
      i.revoked_at AS "revokedAt"
    FROM invitation_codes i LEFT JOIN "user" u ON u.id=i.used_by
    ORDER BY i.created_at DESC,i.id DESC
  `);
  return {items};
}

export async function revokeInvitation(id:string,actor:Actor):Promise<{ok:true}> {
  await invitationAdmin(actor);
  if(typeof id!=='string'||!id.trim())fail(400,'请选择邀请码','INVALID_INPUT');
  const [invitation]=await query(`
    UPDATE invitation_codes SET revoked_at=COALESCE(revoked_at,now()) WHERE id=$1 RETURNING id
  `,[id]);
  if(!invitation)fail(404,'邀请码不存在');
  return {ok:true};
}
