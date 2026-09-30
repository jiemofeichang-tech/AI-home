import { request as httpsRequest } from 'node:https';
import { request as httpRequest } from 'node:http';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { query } from './db';
import { config } from './config';
import { fail } from '../shared/contracts';
import { sendSmsMessage } from './sms';
export async function consumeQuota(key:string,limit:number) {
  const rows=await query(`INSERT INTO usage_counters(key,count) VALUES($1,1) ON CONFLICT(key) DO UPDATE SET count=usage_counters.count+1,updated_at=now() WHERE usage_counters.count<$2 RETURNING count`,[key,limit]);
  if(!rows.length) fail(429,'当前处理额度已用完，请稍后重试','QUOTA_EXCEEDED');
}
export async function sendSms(phone:string,code:string) {
  const day=new Date().toISOString().slice(0,10);
  await consumeQuota(`sms:${day}`,Number(process.env.SMS_DAILY_LIMIT||100));
  await consumeQuota(`sms:${day}:${phone}`,10);
  if(config.dev) {
    await query(`INSERT INTO usage_counters(key,count) VALUES($1,$2) ON CONFLICT(key) DO UPDATE SET count=$2,updated_at=now()`,[`dev-otp:${phone}`,Number(code)]);return;
  }
  await sendSmsMessage(phone,code);
}
export function isPublicAddress(address:string) {
  if(address.includes(':')) {
    const ip=address.toLowerCase();
    // Only global unicast IPv6; reject IPv4 mapping, transition and local ranges.
    return /^[23][0-9a-f]{3}:/.test(ip)&&!ip.startsWith('2001:db8:')&&!ip.startsWith('2002:')&&!ip.startsWith('2001:0:');
  }
  const [a,b]=address.split('.').map(Number);
  return !([0,10,127].includes(a)||a>=224||a===169&&b===254||a===172&&b>=16&&b<=31||a===192&&[0,168].includes(b)||a===100&&b>=64&&b<=127||a===198&&[18,19,51].includes(b)||a===203&&b===0);
}
export async function safeFetch(url:string,limit=1_500_000,redirects=0):Promise<{body:string;url:string;headers:Record<string,unknown>}> {
  const u=new URL(url);if(!['http:','https:'].includes(u.protocol)||u.username||u.password||u.port&&!['80','443'].includes(u.port)) throw new Error('不支持此链接地址');
  const host=u.hostname.replace(/^\[|\]$/g,'');
  const addresses=isIP(host)?[{address:host,family:isIP(host)}]:await lookup(host,{all:true});
  if(!addresses.length||addresses.some(x=>!isPublicAddress(x.address))) throw new Error('不允许读取本地或内网地址');
  const chosen=addresses[0];
  return new Promise((resolve,reject)=>{
    const request=(u.protocol==='https:'?httpsRequest:httpRequest)(u,{method:'GET',headers:{'User-Agent':'AICommunity/0.1 (+link-preview)','Accept':'text/html,application/json,text/plain','Accept-Encoding':'identity'},lookup:((_hostname:unknown,options:{all?:boolean},callback:any)=>options.all?callback(null,[chosen]):callback(null,chosen.address,chosen.family)) as any},res=>{
      if(res.statusCode&&[301,302,303,307,308].includes(res.statusCode)) {res.resume();if(redirects>=4||!res.headers.location) return reject(new Error('链接重定向过多'));safeFetch(new URL(res.headers.location,u).href,limit,redirects+1).then(resolve,reject);return;}
      if(!res.statusCode||res.statusCode<200||res.statusCode>=300) {res.resume();return reject(new Error(`来源返回 ${res.statusCode}`));}
      let size=0;const chunks:Buffer[]=[];
      res.on('data',(chunk:Buffer)=>{size+=chunk.length;if(size>limit){res.destroy();reject(new Error('页面内容超出大小限制'));}else chunks.push(chunk);});
      res.on('end',()=>resolve({body:Buffer.concat(chunks).toString('utf8'),url:u.href,headers:res.headers}));res.on('error',reject);
    });
    request.setTimeout(12000,()=>request.destroy(new Error('链接读取超时')));request.on('error',reject);request.end();
  });
}
