import { after,before,test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash,randomBytes } from 'node:crypto';
import { mkdir,mkdtemp } from 'node:fs/promises';
import path from 'node:path';
import EmbeddedPostgres from 'embedded-postgres';
import type pg from 'pg';
import type { Actor } from '../src/shared/contracts';
import { PRIVACY_VERSION } from '../src/shared/privacy';

const base='http://localhost:3198';
const admin:Actor={userId:'invitation-admin'},member:Actor={userId:'invitation-member'};
const adminPhone='+8613901000000',memberPhone='+8613901000001',bootstrapPhone='+8613901000099';
let engine:EmbeddedPostgres,pool:pg.Pool,query:any,execute:any,auth:any,actorFromRequest:any,agent:Actor;

before(async()=>{
  await mkdir('.local',{recursive:true});
  const root=await mkdtemp(path.resolve('.local','invitation-test-'));
  Object.assign(process.env,{
    DEV_MODE:'true',INVITE_ONLY:'true',ADMIN_PHONE:bootstrapPhone,APP_URL:base,
    DATABASE_URL:'postgresql://postgres:test-password@127.0.0.1:54332/postgres',
    BETTER_AUTH_SECRET:randomBytes(40).toString('hex'),AUTH_IP_HEADER:'x-forwarded-for',
    STORAGE_DRIVER:'local',LOCAL_STORAGE_DIR:path.join(root,'uploads'),REDIS_URL:'',MEILI_URL:'',
    DB_POOL_SIZE:'20',SMS_DAILY_LIMIT:'1000'
  });
  engine=new EmbeddedPostgres({databaseDir:path.join(root,'db'),user:'postgres',password:'test-password',port:54332,persistent:true,initdbFlags:['--encoding=UTF8','--locale=C'],postgresFlags:['-h','127.0.0.1'],onLog:()=>{},onError:()=>{}});
  await engine.initialise();await engine.start();
  ({pool,query}=await import('../src/server/db'));
  ({execute}=await import('../src/server/service'));
  ({auth,actorFromRequest}=await import('../src/server/auth'));
  await (await import('../scripts/migrate')).migrate();
  for(const [actor,name,phone,role] of [[admin,'邀请码管理员',adminPhone,'admin'],[member,'已有成员',memberPhone,'member']] as const) {
    await query(`INSERT INTO "user"(id,name,email,"emailVerified","phoneNumber","phoneNumberVerified","createdAt","updatedAt") VALUES($1,$2,$3,true,$4,true,now(),now())`,[actor.userId,name,`${actor.userId}@example.invalid`,phone]);
    await query('INSERT INTO profiles(user_id,handle,role) VALUES($1,$2,$3)',[actor.userId,actor.userId,role]);
  }
  const grant=await execute('grants_create',{name:'邀请码权限测试 Agent',scopes:['content:read'],days:1},admin);
  agent=await actorFromRequest(new Request(`${base}/api/v1/posts`,{headers:{Authorization:`Bearer ${grant.token}`}}));
},{timeout:120000});

after(async()=>{if(pool)await pool.end();if(engine)await engine.stop();});

function authRequest(endpoint:string,body:Record<string,unknown>,inviteCode?:string,cookie?:string):Promise<Response> {
  const phone=String(body.phoneNumber||'');
  // Separate phone fixtures have separate client IPs, keeping the real auth limiter enabled.
  const ip=`203.0.113.${Number(phone.slice(-3))%254+1}`;
  return auth.handler(new Request(`${base}/api/auth${endpoint}`,{
    method:'POST',headers:{Origin:base,'Content-Type':'application/json','X-Privacy-Version':PRIVACY_VERSION,'X-Forwarded-For':ip,...(inviteCode?{'X-Invite-Code':inviteCode}:{}),...(cookie?{Cookie:cookie}:{})},body:JSON.stringify(body)
  }));
}

async function expectSuccess(response:Response) {
  const result=await response.json();assert.equal(response.status,200,JSON.stringify(result));return result;
}
async function expectDenied(response:Response) {
  assert.ok(response.status>=400&&response.status<500,`${response.status}: ${await response.text()}`);
}
async function sendOtp(phoneNumber:string,inviteCode?:string) {
  await expectSuccess(await authRequest('/phone-number/send-otp',{phoneNumber},inviteCode));
  const [otp]=await query('SELECT count FROM usage_counters WHERE key=$1',[`dev-otp:${phoneNumber}`]);
  assert.ok(otp,'A successfully sent development OTP must be available');return String(otp.count).padStart(6,'0');
}
async function createInvitation(label='邀请测试') {
  return (await execute('invitations_create',{label},admin)).items[0];
}
async function invitationSummary(id:string) {
  return (await execute('invitations_list',{},admin)).items.find((item:any)=>item.id===id);
}
async function usersFor(phones:string[]) {
  return query(`SELECT u.id,u.name,u."phoneNumber",p.role FROM "user" u JOIN profiles p ON p.user_id=u.id WHERE u."phoneNumber"=ANY($1::text[]) ORDER BY u.id`,[phones]);
}
async function smsUsage() {
  return query("SELECT key,count FROM usage_counters WHERE key LIKE 'sms:%' ORDER BY key");
}

test('only human platform administrators manage single-use codes and lists never reveal their secrets',async()=>{
  const defaultInvite=(await execute('invitations_create',{},admin)).items;
  assert.equal(defaultInvite.length,1);assert.equal(defaultInvite[0].label,'');
  const lifetime=new Date(defaultInvite[0].expiresAt).getTime()-Date.now();assert.ok(lifetime>6.99*86400000&&lifetime<=7*86400000);
  const invites=(await execute('invitations_create',{count:2,days:3,label:'  第一批内测  '},admin)).items;
  assert.equal(invites.length,2);assert.equal(new Set(invites.map((item:any)=>item.code)).size,2);
  for(const invite of invites) {
    assert.equal(invite.label,'第一批内测');assert.ok(invite.code.length>=24);
    const [stored]=await query('SELECT * FROM invitation_codes WHERE id=$1',[invite.id]);
    assert.equal(stored.code_hash,createHash('sha256').update(invite.code).digest('hex'));
    assert.equal(JSON.stringify(stored).includes(invite.code),false);
    const summary=await invitationSummary(invite.id);
    assert.equal(summary.codeHint,invite.code.slice(-4));assert.equal(summary.usedAt,null);assert.equal(summary.revokedAt,null);
    assert.equal('code' in summary,false);assert.equal('code_hash' in summary,false);assert.equal('codeHash' in summary,false);
    assert.equal(JSON.stringify(summary).includes(invite.code),false);
  }
  for(const actor of [{},member,agent] as Actor[]) {
    const status=actor.userId?403:401;
    for(const [action,input] of [['invitations_create',{}],['invitations_list',{}],['invitations_revoke',{id:invites[0].id}]] as const) {
      await assert.rejects(execute(action,input,actor),(error:any)=>error.status===status);
    }
  }
  for(const input of [{count:0},{count:21},{days:0},{days:31},{label:'长'.repeat(121)}]) {
    await assert.rejects(execute('invitations_create',input,admin),(error:any)=>error.status===400);
  }
  assert.equal((await invitationSummary(invites[0].id)).revokedAt,null,'Denied revoke calls must leave the invitation active');
});

test('new users need an invitation before SMS and verification; wrong OTPs do not spend the code',async()=>{
  const blockedPhone='+8613901000010',phoneNumber='+8613901000011';
  const usageBefore=await smsUsage();
  for(const inviteCode of [undefined,'not-an-invitation'])await expectDenied(await authRequest('/phone-number/send-otp',{phoneNumber:blockedPhone},inviteCode));
  assert.deepEqual(await smsUsage(),usageBefore,'Rejected invitations must not consume SMS quota');
  assert.equal((await query('SELECT 1 FROM usage_counters WHERE key=$1',[`dev-otp:${blockedPhone}`])).length,0);
  assert.deepEqual(await usersFor([blockedPhone]),[]);

  const invite=await createInvitation();const code=await sendOtp(phoneNumber,invite.code);
  assert.equal((await invitationSummary(invite.id)).usedAt,null,'Sending an OTP must not redeem the invitation');
  await expectDenied(await authRequest('/phone-number/verify',{phoneNumber,code}));
  await expectDenied(await authRequest('/phone-number/verify',{phoneNumber,code},'not-an-invitation'));
  const wrongCode=String((Number(code)+1)%1_000_000).padStart(6,'0');
  await expectDenied(await authRequest('/phone-number/verify',{phoneNumber,code:wrongCode},invite.code));
  assert.equal((await invitationSummary(invite.id)).usedAt,null);assert.deepEqual(await usersFor([phoneNumber]),[]);
  const registered=await expectSuccess(await authRequest('/phone-number/verify',{phoneNumber,code},invite.code));
  const [user]=await usersFor([phoneNumber]);assert.ok(user);assert.equal(user.id,registered.user.id);assert.equal(user.role,'member');
  const used=await invitationSummary(invite.id);assert.ok(used.usedAt);assert.equal(used.usedByName,user.name);
  assert.equal(JSON.stringify(used).includes(invite.code),false);

  await execute('invitations_revoke',{id:invite.id},admin);
  const loginCode=await sendOtp(phoneNumber);
  const loggedIn=await expectSuccess(await authRequest('/phone-number/verify',{phoneNumber,code:loginCode}));
  assert.equal(loggedIn.user.id,user.id,'An existing member logs in without an invitation, even after revocation');
  assert.equal((await usersFor([phoneNumber])).length,1);
  assert.equal(String((await invitationSummary(invite.id)).usedAt),String(used.usedAt));
  const usageAfter=await smsUsage();
  await expectDenied(await authRequest('/phone-number/send-otp',{phoneNumber:blockedPhone},invite.code));
  assert.deepEqual(await smsUsage(),usageAfter,'A used invitation cannot send another new-user OTP');
});

test('revoked and expired invitations reject both sending and already-issued OTPs',async()=>{
  const revoked=await createInvitation('撤销测试'),expired=await createInvitation('过期测试');
  const cases=[{invite:revoked,phoneNumber:'+8613901000020'},{invite:expired,phoneNumber:'+8613901000021'}];
  const codes=await Promise.all(cases.map(item=>sendOtp(item.phoneNumber,item.invite.code)));
  await execute('invitations_revoke',{id:revoked.id},admin);
  await query("UPDATE invitation_codes SET created_at=now()-interval '2 days',expires_at=now()-interval '1 day' WHERE id=$1",[expired.id]);
  const usageBefore=await smsUsage();
  for(const [index,{invite,phoneNumber}] of cases.entries()) {
    await expectDenied(await authRequest('/phone-number/send-otp',{phoneNumber},invite.code));
    await expectDenied(await authRequest('/phone-number/verify',{phoneNumber,code:codes[index]},invite.code));
    assert.equal((await invitationSummary(invite.id)).usedAt,null);
  }
  assert.deepEqual(await usersFor(cases.map(item=>item.phoneNumber)),[]);assert.deepEqual(await smsUsage(),usageBefore);
});

test('concurrent verification of one invitation creates exactly one complete account and session',async()=>{
  const invite=await createInvitation('并发测试');
  const phones=Array.from({length:4},(_,index)=>`+861390100003${index}`);
  const codes=await Promise.all(phones.map(phone=>sendOtp(phone,invite.code)));
  const [sessionsBefore]=await query('SELECT count(*)::int AS n FROM session');
  const responses=await Promise.all(phones.map((phoneNumber,index)=>authRequest('/phone-number/verify',{phoneNumber,code:codes[index]},invite.code)));
  assert.equal(responses.filter(response=>response.status===200).length,1);
  for(const response of responses)if(response.status!==200)await expectDenied(response);
  const users=await usersFor(phones);assert.equal(users.length,1);assert.equal(users[0].role,'member');
  assert.equal((await query('SELECT count(*)::int AS n FROM "user" WHERE "phoneNumber"=ANY($1::text[])',[phones]))[0].n,1,'Failed contenders must not leave accounts without profiles');
  assert.equal((await query('SELECT count(*)::int AS n FROM session'))[0].n,sessionsBefore.n+1,'Only the successful registration receives a session');
  const [stored]=await query('SELECT used_by,used_at FROM invitation_codes WHERE id=$1',[invite.id]);
  assert.equal(stored.used_by,users[0].id);assert.ok(stored.used_at);
});

test('alternate signup and phone-update inputs cannot bypass invitation registration or promote a member',async()=>{
  const phoneNumber='+8613901000040',invite=await createInvitation('绕过测试');
  const code=await sendOtp(phoneNumber,invite.code);
  await expectDenied(await authRequest('/phone-number/verify',{phoneNumber,code,updatePhoneNumber:true},invite.code));
  assert.deepEqual(await usersFor([phoneNumber]),[]);assert.equal((await invitationSummary(invite.id)).usedAt,null);
  const email='invitation-bypass@example.invalid';
  await expectDenied(await authRequest('/sign-up/email',{email,password:'Invitation-test-password-2026!',name:'绕过注册',phoneNumber},invite.code));
  assert.equal((await query('SELECT 1 FROM "user" WHERE email=$1 OR "phoneNumber"=$2',[email,phoneNumber])).length,0);
  assert.equal((await invitationSummary(invite.id)).usedAt,null);

  const loginCode=await sendOtp(memberPhone);
  const response=await authRequest('/phone-number/verify',{phoneNumber:memberPhone,code:loginCode});await expectSuccess(response.clone());
  const cookie=response.headers.getSetCookie().map(value=>value.split(';')[0]).join('; ');assert.ok(cookie);
  await expectDenied(await authRequest('/update-user',{phoneNumber:bootstrapPhone},undefined,cookie));
  await expectDenied(await authRequest('/update-user',{phoneNumber:null},undefined,cookie));
  const [beforeProfile]=await query('SELECT name,image FROM "user" WHERE id=$1',[member.userId]);
  for(const body of [{name:'绕过审核的昵称'},{image:'https://example.invalid/unreviewed-avatar.png'},{image:null},{name:'昵称',image:'https://example.invalid/image.png'}])
    await expectDenied(await authRequest('/update-user',body,undefined,cookie));
  assert.deepEqual((await query('SELECT name,image FROM "user" WHERE id=$1',[member.userId]))[0],beforeProfile,'Native user updates cannot bypass profile moderation');
  const [memberAfter]=await usersFor([memberPhone]);assert.equal(memberAfter.id,member.userId);assert.equal(memberAfter.role,'member');
  assert.deepEqual(await usersFor([bootstrapPhone]),[]);
});

test('phone verification cannot smuggle unreviewed profile fields into a new account',async()=>{
  const phoneNumber='+8613901000080',invite=await createInvitation('资料审核绕过测试');
  const code=await sendOtp(phoneNumber,invite.code);
  for(const extra of [{name:'未经审核昵称'},{image:'https://example.invalid/unreviewed-avatar.png'},{image:null}]) {
    const denied=await authRequest('/phone-number/verify',{phoneNumber,code,...extra},invite.code);
    await expectDenied(denied);
    assert.deepEqual(await usersFor([phoneNumber]),[]);
    assert.equal((await invitationSummary(invite.id)).usedAt,null);
  }
  const registered=await expectSuccess(await authRequest('/phone-number/verify',{phoneNumber,code},invite.code));
  assert.match(registered.user.name,/^新朋友\d{4}$/);assert.equal(registered.user.image,null);
  assert.equal((await usersFor([phoneNumber])).length,1,'Denied extra fields do not consume the correct OTP or invitation');
});

test('open registration permits verified phones without consuming even a supplied invitation',async()=>{
  const {config}=await import('../src/server/config');const inviteOnly=config.inviteOnly;
  const invite=await createInvitation('开放注册不占用');
  try {
    config.inviteOnly=false;
    for(const [phoneNumber,inviteCode] of [['+8613901000060',undefined],['+8613901000061',invite.code]]) {
      const code=await sendOtp(phoneNumber,inviteCode);
      const registered=await expectSuccess(await authRequest('/phone-number/verify',{phoneNumber,code},inviteCode));
      const [user]=await usersFor([phoneNumber]);assert.equal(user.id,registered.user.id);assert.equal(user.role,'member');
    }
    const [stored]=await query('SELECT used_by,used_at FROM invitation_codes WHERE id=$1',[invite.id]);
    assert.deepEqual(stored,{used_by:null,used_at:null});
  } finally {
    config.inviteOnly=inviteOnly;
  }
  await expectDenied(await authRequest('/phone-number/send-otp',{phoneNumber:'+8613901000062'}));
});

test('a rejected invitation claim rolls back the new user, profile and session together',async()=>{
  const invite=await createInvitation('事务回滚测试'),phoneNumber='+8613901000070';
  const code=await sendOtp(phoneNumber,invite.code);
  const counts=()=>query('SELECT (SELECT count(*)::int FROM "user") AS users,(SELECT count(*)::int FROM profiles) AS profiles,(SELECT count(*)::int FROM session) AS sessions');
  const beforeClaim=await counts();
  await query(`CREATE FUNCTION test_reject_invitation_claim() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF OLD.used_by IS NULL AND NEW.used_by IS NOT NULL THEN RETURN NULL; END IF;
      RETURN NEW;
    END;
  $$`);
  try {
    await query('CREATE TRIGGER test_reject_invitation_claim BEFORE UPDATE OF used_by ON invitation_codes FOR EACH ROW EXECUTE FUNCTION test_reject_invitation_claim()');
    await expectDenied(await authRequest('/phone-number/verify',{phoneNumber,code},invite.code));
    assert.deepEqual(await counts(),beforeClaim,'A claim rejected after user/profile insertion must roll back all new account data');
    assert.equal((await query('SELECT 1 FROM "user" WHERE "phoneNumber"=$1',[phoneNumber])).length,0);
    const [stored]=await query('SELECT used_by,used_at FROM invitation_codes WHERE id=$1',[invite.id]);
    assert.deepEqual(stored,{used_by:null,used_at:null});
  } finally {
    await query('DROP TRIGGER IF EXISTS test_reject_invitation_claim ON invitation_codes');
    await query('DROP FUNCTION test_reject_invitation_claim()');
  }
  const retryCode=await sendOtp(phoneNumber,invite.code);
  await expectSuccess(await authRequest('/phone-number/verify',{phoneNumber,code:retryCode},invite.code));
  assert.equal((await usersFor([phoneNumber])).length,1);assert.ok((await invitationSummary(invite.id)).usedAt);
});

test('ADMIN_PHONE bootstraps only an empty administrator set and later invited registrations stay members',async()=>{
  await expectDenied(await authRequest('/phone-number/send-otp',{phoneNumber:bootstrapPhone}));
  const previousAdminPhone=process.env.ADMIN_PHONE;
  await query("UPDATE profiles SET role='member' WHERE user_id=$1",[admin.userId]);
  try {
    await expectDenied(await authRequest('/phone-number/send-otp',{phoneNumber:'+8613901000050'}));
    const code=await sendOtp(bootstrapPhone);
    await expectSuccess(await authRequest('/phone-number/verify',{phoneNumber:bootstrapPhone,code}));
    const [firstAdmin]=await usersFor([bootstrapPhone]);assert.equal(firstAdmin.role,'admin');
    assert.equal((await query("SELECT count(*)::int AS n FROM profiles WHERE role='admin'"))[0].n,1);
  } finally {
    await query("UPDATE profiles SET role='admin' WHERE user_id=$1",[admin.userId]);
  }
  const laterPhone='+8613901000051';
  try {
    process.env.ADMIN_PHONE=laterPhone;
    await expectDenied(await authRequest('/phone-number/send-otp',{phoneNumber:laterPhone}));
    const invite=await createInvitation('已有管理员后注册');const code=await sendOtp(laterPhone,invite.code);
    await expectSuccess(await authRequest('/phone-number/verify',{phoneNumber:laterPhone,code},invite.code));
    assert.equal((await usersFor([laterPhone]))[0].role,'member');
  } finally {
    if(previousAdminPhone===undefined)delete process.env.ADMIN_PHONE;else process.env.ADMIN_PHONE=previousAdminPhone;
  }
});
