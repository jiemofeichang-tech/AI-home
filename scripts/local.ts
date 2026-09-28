import { PGlite } from '@electric-sql/pglite';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';
import { mkdir,readFile,writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { spawn,type ChildProcess } from 'node:child_process';
await mkdir('.local',{recursive:true});
let secret;try{secret=await readFile('.local/auth-secret','utf8');}catch{secret=randomBytes(40).toString('hex');await writeFile('.local/auth-secret',secret,{mode:0o600});}
const env={...process.env,DEV_MODE:'true',APP_URL:'http://localhost:3100',DATABASE_URL:'postgresql://postgres:postgres@127.0.0.1:54329/postgres',BETTER_AUTH_SECRET:secret,STORAGE_DRIVER:'local',REDIS_URL:'',MEILI_URL:'',DB_POOL_SIZE:'3'};
Object.assign(process.env,env);
const db=await PGlite.create('.local/postgres');
const server=new PGLiteSocketServer({db,host:'127.0.0.1',port:54329,maxConnections:20});await server.start();
const {migrate}=await import('./migrate');await migrate();
const {seed}=await import('./seed');await seed();
const children:ChildProcess[]=[];
children.push(spawn(process.execPath,['--import','tsx','src/server/worker.ts'],{env,stdio:'inherit',windowsHide:true}));
children.push(spawn(process.execPath,['node_modules/next/dist/bin/next','dev','--hostname','127.0.0.1','--port','3100'],{env,stdio:'inherit',windowsHide:true}));
console.log('本地社区：http://localhost:3100 · 演示管理员手机号 13800000001（验证码在登录页显示）');
let closing=false;async function close(){if(closing)return;closing=true;children.forEach(c=>c.kill());await server.stop();await db.close();process.exit(0);}
process.on('SIGINT',close);process.on('SIGTERM',close);
children.forEach(c=>c.on('exit',code=>{if(code&&!closing)close();}));
