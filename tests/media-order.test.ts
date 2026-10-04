import { after,before,test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes,randomUUID } from 'node:crypto';
import { mkdir,mkdtemp } from 'node:fs/promises';
import path from 'node:path';
import EmbeddedPostgres from 'embedded-postgres';
import type pg from 'pg';
import type { Actor } from '../src/shared/contracts';

const author:Actor={userId:'media-order-author'},other:Actor={userId:'media-order-other'},admin:Actor={userId:'media-order-admin'};
let engine:EmbeddedPostgres,pool:pg.Pool;
let query:typeof import('../src/server/db').query,execute:typeof import('../src/server/service').execute;
let moderation:typeof import('../src/server/moderation');

before(async()=>{
  await mkdir('.local',{recursive:true});const root=await mkdtemp(path.resolve('.local','media-order-test-'));
  Object.assign(process.env,{DEV_MODE:'true',INVITE_ONLY:'false',ADMIN_PHONE:'',APP_URL:'http://localhost:3197',
    DATABASE_URL:'postgresql://postgres:test-password@127.0.0.1:54343/postgres',BETTER_AUTH_SECRET:randomBytes(40).toString('hex'),
    STORAGE_DRIVER:'local',LOCAL_STORAGE_DIR:path.join(root,'uploads'),REDIS_URL:'',MEILI_URL:'',CONTENT_MODERATION_PROVIDER:'manual'});
  engine=new EmbeddedPostgres({databaseDir:path.join(root,'db'),user:'postgres',password:'test-password',port:54343,persistent:true,
    initdbFlags:['--encoding=UTF8','--locale=C'],postgresFlags:['-h','127.0.0.1'],onLog:()=>{},onError:()=>{}});
  await engine.initialise();await engine.start();
  ({pool,query}=await import('../src/server/db'));({execute}=await import('../src/server/service'));
  await (await import('../scripts/migrate')).migrate();moderation=await import('../src/server/moderation');
  for(const actor of [author,other,admin]) {
    await query(`INSERT INTO "user"(id,name,email,"emailVerified","createdAt","updatedAt") VALUES($1,$1,$2,true,now(),now())`,[actor.userId,`${actor.userId}@example.invalid`]);
    await query('INSERT INTO profiles(user_id,handle,role) VALUES($1,$1,$2)',[actor.userId,actor===admin?'admin':'member']);
  }
},{timeout:120000});
after(async()=>{if(pool)await pool.end();if(engine)await engine.stop();});

// Ordering does not read object bytes, so these fixtures contain DB records only.
async function image(id:string,createdAt:string,owner=author,postId:string|null=null) {
  await query(`INSERT INTO media(id,owner_id,post_id,storage_key,mime,bytes,original_name,created_at,moderation_status)
    VALUES($1,$2,$3,$4,'image/png',100,'image.png',$5,$6)`,[id,owner.userId,postId,`fixtures/${id}.png`,createdAt,postId?'approved':'pending']);
  return id;
}
async function approve(result:{moderationId:string}) {
  await moderation.moderationDecide(admin,{id:result.moderationId,decision:'approve',reason:'确认图片顺序的集成测试审核'});
}
const mediaIds=(post:{media:{id:string}[]})=>post.media.map(media=>media.id);

test('chosen image order survives locking, moderation, background updates and repeated feed reads',async()=>{
  const suffix=randomUUID();const a=await image(`a-${suffix}`,'2026-01-03T00:00:00Z');
  const b=await image(`b-${suffix}`,'2026-01-01T00:00:00Z');
  const c=await image(`c-${suffix}`,'2026-01-02T00:00:00Z');
  const chosen=[c,a,b];const createdAtBefore=await query('SELECT id,created_at FROM media WHERE id=ANY($1::text[]) ORDER BY id',[chosen]);
  const result=await execute('posts_create',{body:'MEDIA-ORDER-CHOSEN',mediaIds:chosen,idempotencyKey:`order-${suffix}`},author);
  assert.deepEqual((await query('SELECT id,position FROM media WHERE post_id=$1 ORDER BY position',[result.id])),chosen.map((id,position)=>({id,position})));
  const review=(await moderation.moderationList(admin,{mine:false})).items.find(item=>item.id===result.moderationId)!;
  assert.deepEqual(review.images,chosen,'Reviewer must see the same image sequence as the author');
  await approve(result);
  for(const id of [b,c,a])await query("UPDATE media SET status='failed',error='fixture processing unavailable' WHERE id=$1",[id]);
  assert.deepEqual(await query('SELECT id,created_at FROM media WHERE id=ANY($1::text[]) ORDER BY id',[chosen]),createdAtBefore,'Sorting must not rewrite upload times');
  for(let read=0;read<3;read++) {
    assert.deepEqual(mediaIds(await execute('posts_get',{id:result.id},{})),chosen);
    assert.deepEqual(mediaIds((await execute('posts_list',{},{})).items.find((post:{id:string})=>post.id===result.id)),chosen);
  }
  assert.deepEqual((await execute('admin_content_list',{targetType:'post',status:'visible',q:'MEDIA-ORDER-CHOSEN'},admin)).items[0].images,chosen);
  const repeat=await execute('posts_create',{body:'MEDIA-ORDER-CHOSEN',mediaIds:chosen,idempotencyKey:`order-${suffix}`},author);
  assert.equal(repeat.id,result.id,'Request retries reuse the post and its saved order');
  await assert.rejects(execute('posts_create',{body:'MEDIA-ORDER-CHOSEN',mediaIds:[b,a,c],idempotencyKey:`order-${suffix}`},author),/幂等键/);
  await query("UPDATE media SET moderation_status='rejected' WHERE id=$1",[a]);
  assert.deepEqual(mediaIds(await execute('posts_get',{id:result.id},{})),[c,b],'Filtering a hidden image must preserve the order of the remaining images');
});

test('legacy posts use upload time with a deterministic ID tie-breaker and old writers remain compatible',async()=>{
  const postId=randomUUID();await query("INSERT INTO posts(id,author_id,body,moderation_status) VALUES($1,$2,'Legacy ordered images','approved')",[postId,author.userId]);
  const suffix=randomUUID();const c=await image(`c-${suffix}`,'2026-01-02T00:00:00Z',author,postId);
  const a=await image(`a-${suffix}`,'2026-01-02T00:00:00Z',author,postId);
  const b=await image(`b-${suffix}`,'2026-01-01T00:00:00Z',author,postId);
  for(const id of [b,a,c])await query("UPDATE media SET status='ready' WHERE id=$1",[id]);
  assert.deepEqual(mediaIds(await execute('posts_get',{id:postId},{})),[b,a,c]);
  assert.ok((await query('SELECT position FROM media WHERE post_id=$1',[postId])).every(row=>row.position===null));
});

test('invalid image claims do not attach or assign order to any image',async()=>{
  const mine=await image(randomUUID(),'2026-01-01T00:00:00Z');
  const theirs=await image(randomUUID(),'2026-01-02T00:00:00Z',other);
  const before=(await query('SELECT count(*)::int AS count FROM posts'))[0].count;
  await assert.rejects(execute('posts_create',{body:'Claim foreign image',mediaIds:[mine,theirs]},author),/不属于你/);
  await assert.rejects(execute('posts_create',{body:'Duplicate image',mediaIds:[mine,mine]},author),/重复/);
  assert.equal((await query('SELECT count(*)::int AS count FROM posts'))[0].count,before);
  assert.ok((await query('SELECT post_id,position FROM media WHERE id=ANY($1::text[])',[[mine,theirs]])).every(row=>row.post_id===null&&row.position===null));
});

test('database rejects duplicate or out-of-range positions without changing the saved order',async()=>{
  const first=await image(randomUUID(),'2026-01-01T00:00:00Z'),second=await image(randomUUID(),'2026-01-02T00:00:00Z');
  const result=await execute('posts_create',{body:'Position integrity',mediaIds:[second,first]},author);await approve(result);
  await assert.rejects(query('UPDATE media SET position=0 WHERE id=$1',[first]),(error:{code:string})=>error.code==='23505');
  for(const position of [-1,9])await assert.rejects(query('UPDATE media SET position=$2 WHERE id=$1',[first,position]),(error:{code:string})=>error.code==='23514');
  assert.deepEqual(mediaIds(await execute('posts_get',{id:result.id},{})),[second,first]);
});
