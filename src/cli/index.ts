import 'dotenv/config';
import { Command } from 'commander';
import { readFile } from 'node:fs/promises';
import { contracts,type Action } from '../shared/contracts';
const program=new Command().name('aicommunity').version('0.1.0').description('AI 社区 CLI：读取与操作共享同一套权限').option('--url <url>','社区地址',process.env.AICOMMUNITY_URL||'http://localhost:3100').option('--json','输出机器可读 JSON');
async function call(action:Action,input:unknown){
  try{const validated=contracts[action].parse(input);const headers:Record<string,string>={'Content-Type':'application/json',Origin:new URL(program.opts().url).origin};if(process.env.AICOMMUNITY_TOKEN)headers.Authorization=`Bearer ${process.env.AICOMMUNITY_TOKEN}`;
    const r=await fetch(`${program.opts().url}/api/v1/actions/${action}`,{method:'POST',headers,body:JSON.stringify(validated)});const result=await r.json();if(!r.ok)throw new Error(result.error||`HTTP ${r.status}`);console.log(JSON.stringify(result,null,program.opts().json?0:2));
  }catch(e){console.error(JSON.stringify({error:(e as Error).message}));process.exitCode=1;}
}
program.command('search <query>').option('--type <type>','all / posts / github / communities / events','all').option('--city <city>').action((q,opts)=>call('search',{q,type:opts.type,city:opts.city}));
program.command('feed').option('--community <id>').option('--limit <n>','每页条数','20').action(opts=>call('posts_list',{communityId:opts.community,limit:Number(opts.limit)}));
const posts=program.command('posts');posts.command('get <id>').action(id=>call('posts_get',{id}));posts.command('create').option('--body <text>').option('--file <path>','从 UTF-8 文件读取正文').option('--link <url...>').option('--community <id>').option('--original <id>').option('--key <key>','幂等键').action(async opts=>call('posts_create',{body:opts.file?await readFile(opts.file,'utf8'):opts.body||'',links:opts.link||[],communityId:opts.community,originalId:opts.original,idempotencyKey:opts.key}));
program.command('comment <postId> <body>').option('--key <key>').action((id,body,opts)=>call('comments_create',{id,body,idempotencyKey:opts.key}));
program.command('bookmark <postId>').option('--remove').action((id,opts)=>call('reactions_set',{id,kind:'bookmark',active:!opts.remove}));
program.command('communities').option('--city <city>').action(opts=>call('communities_list',opts));
const events=program.command('events');events.command('list').option('--city <city>').action(opts=>call('events_list',opts));events.command('get <id>').action(id=>call('events_get',{id}));events.command('rsvp <id>').option('--cancel').action((id,opts)=>call('events_rsvp',{id,attending:!opts.cancel}));events.command('create <jsonFile>').action(async file=>call('events_create',JSON.parse(await readFile(file,'utf8'))));
program.command('call <action>').option('--input <json>','JSON 参数','{}').option('--file <path>').action(async(action,opts)=>{if(!(action in contracts))throw new Error('Unknown action');await call(action,opts.file?JSON.parse(await readFile(opts.file,'utf8')):JSON.parse(opts.input));});
program.command('login').description('显示安全接入方法，不在命令行传递令牌').action(()=>console.log(`在 ${program.opts().url}/agents 创建授权，然后通过 AICOMMUNITY_TOKEN 环境变量提供令牌。`));
await program.parseAsync(process.argv);
