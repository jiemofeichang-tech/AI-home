import { createHash } from 'node:crypto';
import { APIError, type BetterAuthOptions, type BetterAuthPlugin, type DBAdapter } from 'better-auth';
import { createAuthMiddleware } from 'better-auth/api';
import { createKyselyAdapter, kyselyAdapter } from '@better-auth/kysely-adapter';
import { config } from './config';
import { query } from './db';
import { findAvailableInvitation, hashInvitationCode } from './invitations';
import { PRIVACY_VERSION } from '../shared/privacy';

type Database = NonNullable<Awaited<ReturnType<typeof createKyselyAdapter>>['kysely']>;
type Admission = { phoneNumber:string; inviteCode:string; verifiedPhone:boolean };
const admissionProof=Symbol('verified-phone-registration');
const phonePattern=/^\+861[3-9]\d{9}$/;
const invitationError=()=>new APIError('FORBIDDEN',{code:'INVITATION_REQUIRED',message:'邀请码无效、已使用或已过期，请联系管理员获取新的邀请码'});
const profileInput=(body:Record<string,unknown>|undefined)=>['name','image'].some(field=>Object.prototype.hasOwnProperty.call(body||{},field));
const profileReviewError=()=>new APIError('FORBIDDEN',{code:'PROFILE_REVIEW_REQUIRED',message:'请在个人资料页面提交修改，昵称和头像需要经过内容审核'});
const configuredAdmin=(phone:string)=>phonePattern.test(phone)&&phone===process.env.ADMIN_PHONE;

async function canBootstrapAdmin(phone:string):Promise<boolean> {
  if(!configuredAdmin(phone))return false;
  return !(await query("SELECT 1 FROM profiles WHERE role='admin' LIMIT 1")).length;
}

/** Keep the normal adapter's schema/migration support, adding one atomic user
 * creation boundary. In particular, create.after hooks run too late to safely
 * claim an invitation: Better Auth can execute them after a commit. */
function protectUserCreation(adapter:DBAdapter,db:Database,options:BetterAuthOptions):DBAdapter {
  const create=adapter.create.bind(adapter);
  const transactionAdapter=(trx:Database)=>kyselyAdapter(trx,{type:'postgres',transaction:false})({
    ...options,
    advanced:{...options.advanced,database:{...options.advanced?.database,validateSchema:false}}
  });
  adapter.create=async <T extends Record<string,any>,R=T>(args:{model:string;data:Omit<T,'id'>;select?:string[];forceAllowId?:boolean}):Promise<R>=>{
    if(args.model!=='user')return create<T,R>(args);
    const {[admissionProof]:proof,...data}=args.data as Record<string,any>&{[admissionProof]?:Admission};
    if(config.inviteOnly&&!proof?.verifiedPhone)throw invitationError();
    async function register(trx:Database,insert:DBAdapter['create']) {
      let bootstrap=false;
      if(proof?.verifiedPhone&&configuredAdmin(proof.phoneNumber)) {
        // There is no existing admin row to lock during the first signup.
        // All bootstrap attempts share this transaction-scoped database lock.
        await trx.selectNoFrom(eb=>eb.fn('pg_advisory_xact_lock',[eb.val(1952805225)]).as('lock')).execute();
        bootstrap=!(await trx.selectFrom('profiles').select('user_id').where('role','=','admin').limit(1).execute()).length;
      }
      let invitationId:string|undefined;
      if(config.inviteOnly&&!bootstrap) {
        if(!proof?.inviteCode)throw invitationError();
        const invitation=await trx.selectFrom('invitation_codes').select('id')
          .where('code_hash','=',hashInvitationCode(proof.inviteCode))
          .where('used_by','is',null).where('used_at','is',null).where('revoked_at','is',null)
          .where(eb=>eb('expires_at','>',eb.fn<Date>('clock_timestamp',[]))).forUpdate().executeTakeFirst();
        if(!invitation)throw invitationError();
        invitationId=String(invitation.id);
      }
      const created=await insert<Record<string,any>,R>({...args,data});
      const user=created as Record<string,unknown>;
      await trx.insertInto('profiles').values({
        user_id:user.id,handle:`user_${createHash('sha256').update(String(user.id)).digest('hex').slice(0,12)}`,
        role:bootstrap?'admin':'member',privacy_version:proof?.verifiedPhone?PRIVACY_VERSION:null,
        privacy_accepted_at:proof?.verifiedPhone?new Date():null
      }).execute();
      if(invitationId) {
        const consumed=await trx.updateTable('invitation_codes')
          .set(eb=>({used_by:user.id,used_at:eb.fn<Date>('now',[])}))
          .where('id','=',invitationId).where('used_by','is',null).where('used_at','is',null).where('revoked_at','is',null)
          .where(eb=>eb('expires_at','>',eb.fn<Date>('clock_timestamp',[]))).returning('id').executeTakeFirst();
        if(!consumed)throw invitationError();
      }
      return created;
    }
    try {
      return db.isTransaction?await register(db,create):await db.transaction().execute(trx=>register(trx,transactionAdapter(trx).create));
    } catch(error) {
      if((error as {code?:string}).code==='23505')throw new APIError('CONFLICT',{code:'REGISTRATION_CONFLICT',message:'该手机号已注册，请重新获取验证码登录'});
      throw error;
    }
  };
  // Core sign-up flows may already have a transaction. Preserve our create
  // guard on those transaction adapters as well, so no alternate signup can
  // bypass the invitation boundary.
  adapter.transaction=async callback=>db.isTransaction?callback(adapter):db.transaction().execute(trx=>callback(protectUserCreation(transactionAdapter(trx),trx,options)));
  return adapter;
}

export function invitationAdmission():BetterAuthPlugin {
  return {
    id:'community-invitation-admission',
    async init(ctx) {
      const {kysely}=await createKyselyAdapter(ctx.options);
      if(!kysely)throw new Error('Invitation admission requires PostgreSQL');
      return {
        context:{adapter:protectUserCreation(ctx.adapter,kysely,ctx.options)},
        options:{databaseHooks:{user:{create:{before:async (user,context)=>{
          const verifiedPhone=context?.path==='/phone-number/verify'&&!context.body?.updatePhoneNumber
            &&typeof user.phoneNumber==='string'&&phonePattern.test(user.phoneNumber)
            &&user.phoneNumber===context.body?.phoneNumber&&user.phoneNumberVerified===true;
          if(verifiedPhone&&profileInput(context?.body))throw profileReviewError();
          if(config.inviteOnly&&!verifiedPhone)throw invitationError();
          const proof:Admission={phoneNumber:String(user.phoneNumber||''),inviteCode:context?.headers?.get('x-invite-code')?.trim()||'',verifiedPhone};
          // The phone plugin's catch-all body accepts extra user fields. Even
          // though it replaces name with getTempName, image can otherwise be
          // copied into a new user without passing the community review flow.
          return {data:{[admissionProof]:proof,...(verifiedPhone?{image:null}:{})}};
        }}}}}
      };
    },
    hooks:{before:[{
      matcher:ctx=>ctx.path==='/phone-number/send-otp'||ctx.path==='/phone-number/verify'
        ||ctx.path==='/update-user'&&(Object.prototype.hasOwnProperty.call(ctx.body||{},'phoneNumber')||profileInput(ctx.body)),
      handler:createAuthMiddleware(async ctx=>{
        if(ctx.path==='/update-user') {
          if(Object.prototype.hasOwnProperty.call(ctx.body||{},'phoneNumber'))throw new APIError('FORBIDDEN',{code:'PHONE_CHANGE_DISABLED',message:'暂不支持更换或清空登录手机号'});
          throw profileReviewError();
        }
        if(ctx.path==='/phone-number/verify'&&profileInput(ctx.body))throw profileReviewError();
        if(ctx.headers?.get('x-privacy-version')!==PRIVACY_VERSION)throw new APIError('FORBIDDEN',{code:'PRIVACY_CONSENT_REQUIRED',message:'请先阅读并确认个人信息处理说明，再获取或验证手机验证码'});
        const phone=ctx.body?.phoneNumber;
        if(typeof phone!=='string'||!phonePattern.test(phone))throw new APIError('BAD_REQUEST',{code:'INVALID_PHONE_NUMBER',message:'请输入有效的中国大陆手机号'});
        if(ctx.path==='/phone-number/verify'&&ctx.body?.updatePhoneNumber)throw new APIError('FORBIDDEN',{code:'PHONE_CHANGE_DISABLED',message:'暂不支持更换登录手机号'});
        if(!config.inviteOnly)return;
        if((await query('SELECT 1 FROM "user" WHERE "phoneNumber"=$1 LIMIT 1',[phone])).length)return;
        if(await canBootstrapAdmin(phone))return;
        const code=ctx.headers?.get('x-invite-code')?.trim()||'';
        if(!code||!await findAvailableInvitation(code))throw invitationError();
      })
    }]}
  };
}
