import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp,rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { Queue,Worker } from 'bullmq';

// Uses real Redis and BullMQ Lua, never the preview Redis or PostgreSQL.
// Install redis-server or set REDIS_TEST_SERVER to an existing binary to run.
test('polling deduplicates queued/running jobs and both terminal states permit later retries',{timeout:20000},async t=>{
  const root=await mkdtemp('/tmp/ah-redis-');
  const server=spawn(process.env.REDIS_TEST_SERVER||'redis-server',[
    '--port','0','--unixsocket',`${root}/redis.sock`,'--unixsocketperm','700',
    '--save','','--appendonly','no','--dir',root
  ],{stdio:['ignore','pipe','pipe']});
  let queue:Queue|undefined,worker:Worker|undefined,closePool:(()=>Promise<void>)|undefined;
  try {
    try{await once(server,'spawn');}
    catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT'){t.skip('redis-server is unavailable; set REDIS_TEST_SERVER to run real queue integration');return;}throw error;}
    await new Promise<void>((resolve,reject)=>{
      let output='';
      const timer=setTimeout(()=>reject(new Error('Isolated Redis did not become ready')),5000);
      const read=(chunk:Buffer)=>{output+=chunk.toString();if(/Ready to accept connections/i.test(output)){clearTimeout(timer);resolve();}};
      server.stdout.on('data',read);server.stderr.on('data',read);
      server.once('exit',code=>{clearTimeout(timer);reject(new Error(`Isolated Redis exited: ${code}`));});
    });
    Object.assign(process.env,{NODE_ENV:'test',DEV_MODE:'true',DOTENV_CONFIG_PATH:'/dev/null',DATABASE_URL:'postgresql://test:test@127.0.0.1:1/unused',REDIS_URL:'',MEILI_URL:'',STORAGE_DRIVER:'local',LOCAL_STORAGE_DIR:root});
    const {enqueueJob}=await import('../src/server/worker');
    const {pool}=await import('../src/server/db');closePool=()=>pool.end();
    const connection={path:`${root}/redis.sock`};
    queue=new Queue(`worker-test-${randomUUID()}`,{connection});
    worker=new Worker(queue.name,async()=>{}, {connection,autorun:false});
    await queue.waitUntilReady();await worker.waitUntilReady();
    const id=randomUUID(),token=randomUUID();
    await Promise.all(Array.from({length:100},()=>enqueueJob(queue!,id)));
    assert.equal(await queue.getWaitingCount(),1,'Repeated polls must create one waiting transport job');
    const active=await worker.getNextJob(token,{block:false});assert.ok(active);assert.equal(active.id,id);
    await Promise.all(Array.from({length:100},()=>enqueueJob(queue!,id)));
    assert.equal(await queue.getActiveCount(),1);assert.equal(await queue.getWaitingCount(),0,'Active job must not acquire queued duplicates');
    await active.moveToCompleted('done',token,false);
    assert.equal(await queue.getJob(id),undefined,'Completed transport job must release its stable ID');
    await enqueueJob(queue,id);
    const retried=await worker.getNextJob(token,{block:false});assert.ok(retried);assert.equal(retried.id,id);
    await retried.moveToFailed(new Error('Transient database connection error'),token,false);
    assert.equal(await queue.getJob(id),undefined,'A BullMQ failure must not pin the pending database job forever');
    assert.equal(await queue.getFailedCount(),0);
    await enqueueJob(queue,id);
    const recovered=await worker.getNextJob(token,{block:false});assert.ok(recovered);assert.equal(recovered.id,id);
    await recovered.moveToCompleted('recovered',token,false);
    await enqueueJob(queue,id);
    assert.equal(await queue.getWaitingCount(),1,'The same DB ID remains usable for later manual retry or new derived work');
  }finally{
    await worker?.close(true);if(queue){await queue.obliterate({force:true});await queue.close();}
    await closePool?.();
    if(server.pid&&server.exitCode===null){const exit=once(server,'exit');server.kill('SIGTERM');await exit;}
    await rm(root,{recursive:true,force:true});
  }
});
