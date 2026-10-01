import { createHash,createHmac,randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { getObject,imageMime } from './storage';
import { extractWebUrls } from '../shared/links';

export type ModerationDecision='approved'|'review'|'rejected';
export type ModerationInput={text:string;images:Array<{storageKey:string;mime:string}>;dataId:string;
  /** Internal context from attached link records, never a public moderation parameter. */
  linkUrls?:string[]};
export type ModerationResult={decision:ModerationDecision;labels:string[];provider:string};

// Green 2022-03-02 RPC protocol and temporary-upload flow:
// https://help.aliyun.com/zh/document_detail/433945.html
// https://help.aliyun.com/zh/document_detail/467828.html
// Text labels/limits: https://help.aliyun.com/en/document_detail/2684669.html
// ImageModeration checks only the first GIF frame:
// https://help.aliyun.com/zh/document_detail/467829.html
const provider='aliyun';
const regions=new Set(['cn-shanghai','cn-beijing','cn-hangzhou','cn-shenzhen']);
const safeMessage='内容审核服务暂不可用，请等待人工审核';
/** Retriable failures carry no upstream message, response, or credentials. */
export class ModerationTransientError extends Error {
  constructor(){super(safeMessage);this.name='ModerationTransientError';}
}
const safeError=(transient=false)=>transient?new ModerationTransientError():new Error(safeMessage);
const object=(value:unknown):Record<string,unknown>|undefined=>value!==null&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,unknown>:undefined;
const encode=(value:string)=>encodeURIComponent(value).replace(/[!'()*]/g,c=>`%${c.charCodeAt(0).toString(16).toUpperCase()}`);
const sha256=(value:string|Buffer)=>createHash('sha256').update(value).digest('hex');
const transientStatus=(value:unknown)=>typeof value==='number'&&(value===429||value>=500&&value<=599)
  ||typeof value==='string'&&(/^(429|5\d\d)$/.test(value)||/^(Throttling(?:\.[A-Za-z]+)?|ServiceUnavailable|InternalError|RequestTimeout)$/.test(value));
const networkError=(error:unknown)=>error instanceof TypeError||error instanceof DOMException&&['TimeoutError','AbortError'].includes(error.name);

// Process-local, approval-only cache: restart clears it; no text, image bytes,
// object keys, or user identifiers are retained. Bump this version whenever
// label policy, animation checks, text chunking, or service parameters change.
const cachePolicy='approval-v2-text600-overlap60-exact-share-url-recheck-image-static';
const cacheTtlMs=10*60_000,cacheMaxEntries=512;
type CheckResult=Omit<ModerationResult,'provider'>;
const approvals=new Map<string,{expires:number;labels:string[]}>();
function cacheKey(kind:'text'|'image',content:string|Buffer,s:ReturnType<typeof settings>,mime='',linkUrls:string[]=[]) {
  const scope=JSON.stringify([provider,s.region,s.key,cachePolicy,s.policyVersion,kind,kind==='text'?'comment_detection_pro':'postImageCheck:textInImage',mime,linkUrls]);
  return sha256(`${sha256(scope)}:${sha256(content)}`);
}
function cachedApproval(key:string):CheckResult|undefined {
  const entry=approvals.get(key);
  if(!entry)return;
  if(entry.expires<=Date.now()){approvals.delete(key);return;}
  return {decision:'approved',labels:[...entry.labels]};
}
function saveApprovals(results:Map<string,CheckResult>) {
  const now=Date.now();
  for(const [key,entry] of approvals)if(entry.expires<=now)approvals.delete(key);
  for(const [key,result] of results) {
    if(result.decision!=='approved')continue;
    approvals.delete(key);
    while(approvals.size>=cacheMaxEntries)approvals.delete(approvals.keys().next().value!);
    approvals.set(key,{expires:now+cacheTtlMs,labels:[...result.labels]});
  }
}

async function cloudFetch(url:string,init:RequestInit) {
  try {return await fetch(url,{...init,cache:'no-store'});}
  catch(error){throw safeError(networkError(error));}
}
async function cloudJson(response:Response):Promise<unknown> {
  try {return await response.json();}
  catch(error){throw safeError(networkError(error));}
}

function settings() {
  return {
    provider:process.env.CONTENT_MODERATION_PROVIDER||'manual',
    region:process.env.CONTENT_MODERATION_REGION||'cn-shanghai',
    key:process.env.CONTENT_MODERATION_ACCESS_KEY_ID?.trim()||'',
    secret:process.env.CONTENT_MODERATION_ACCESS_KEY_SECRET?.trim()||'',
    // Increment when changing the cloud-side moderation policy to invalidate
    // approvals immediately, without waiting for the ten-minute expiry.
    policyVersion:process.env.CONTENT_MODERATION_POLICY_VERSION||'1',
  };
}
export function moderationProviderStatus():{provider:string;configured:boolean} {
  const s=settings();
  return {provider:s.provider===provider?provider:s.provider==='manual'?'manual':'unsupported',configured:s.provider===provider&&regions.has(s.region)&&!!s.key&&!!s.secret};
}

/** Never pass the provider's response, risk words, or credential errors upstream. */
async function rpc(action:string,parameters:Record<string,string>,s:ReturnType<typeof settings>,deadline:number):Promise<Record<string,unknown>> {
  const values:Record<string,string>={Action:action,Version:'2022-03-02',Format:'JSON',AccessKeyId:s.key,RegionId:s.region,
    SignatureMethod:'HMAC-SHA1',SignatureVersion:'1.0',SignatureNonce:randomUUID(),Timestamp:new Date().toISOString().replace(/\.\d{3}Z$/,'Z'),...parameters};
  const canonical=Object.keys(values).sort().map(key=>`${encode(key)}=${encode(values[key])}`).join('&');
  const signature=createHmac('sha1',`${s.secret}&`).update(`POST&%2F&${encode(canonical)}`).digest('base64');
  const response=await cloudFetch(`https://green-cip.${s.region}.aliyuncs.com/`,{method:'POST',redirect:'error',headers:{'content-type':'application/x-www-form-urlencoded'},body:`${canonical}&Signature=${encode(signature)}`,signal:timeout(deadline)});
  if(!response.ok)throw safeError(transientStatus(response.status));
  const payload=object(await cloudJson(response));
  if(payload?.Code!==200||!object(payload.Data))throw safeError(transientStatus(payload?.Code));
  return payload.Data as Record<string,unknown>;
}
function timeout(deadline:number) {
  const remaining=deadline-Date.now();if(remaining<=0)throw safeError(true);
  return AbortSignal.timeout(Math.min(20_000,remaining));
}

// This is a provider-label policy, not a text keyword detector. Broad categories
// such as political figures, uniforms, crowds, and weapons are reviewed, because
// their presence alone does not establish prohibited graphic violence.
const rejectLabels=new Set(['porn','pornographic_adult','pornographic_adultContent','pornographic_adultContent_tii',
  'violent_incidents','violent_blood','violent_horrific','violent_horrific_tii','horrific_blood','horrific_organs']);
const riskLevels=new Set(['none','low','medium','high']);
function mapResult(data:Record<string,unknown>,dataId:string):Omit<ModerationResult,'provider'> {
  if(data.DataId!==undefined&&data.DataId!==dataId)throw safeError();
  if(typeof data.RiskLevel!=='string'||!riskLevels.has(data.RiskLevel)||!Array.isArray(data.Result)||!data.Result.length)throw safeError();
  const onlyRejectCategory=data.Result.every(raw=>{
    const label=object(raw)?.Label;return typeof label==='string'&&rejectLabels.has(label.replace(/_lib$/,''));
  });
  let decision:ModerationDecision='approved';const labels:string[]=[];
  for(const raw of data.Result) {
    const row=object(raw);const label=row?.Label;
    if(typeof label!=='string'||!label||label.length>128||!/^[a-zA-Z][a-zA-Z0-9_]*$/.test(label))throw safeError();
    if(row!.Confidence!==undefined&&(typeof row!.Confidence!=='number'||!Number.isFinite(row!.Confidence)||row!.Confidence<0||row!.Confidence>100))throw safeError();
    if(row!.RiskLevel!==undefined&&(typeof row!.RiskLevel!=='string'||!riskLevels.has(row!.RiskLevel)))throw safeError();
    const risk=(row!.RiskLevel??data.RiskLevel) as string;
    labels.push(label);
    // Unknown/custom/allow-list matches never auto-approve. Only the documented
    // no-risk label combined with an explicit low/none risk result can pass.
    const base=label.replace(/_lib$/,'');
    // A top-level maximum cannot attribute a mixed political/porn response to
    // the porn label. Without per-label risk, mixed categories need a person.
    if(risk==='high'&&rejectLabels.has(base)&&(row!.RiskLevel==='high'||onlyRejectCategory))decision='rejected';
    else if(decision!=='rejected'&&(label!=='nonLabel'||!['none','low'].includes(risk)))decision='review';
  }
  if(!['none','low'].includes(data.RiskLevel)&&decision==='approved')decision='review';
  if(data.ManualTaskId&&decision==='approved')decision='review';
  return {decision,labels};
}

/** UTF-16-safe chunks stay within 600 units, with overlap across boundaries. */
function* textChunks(text:string) {
  const points=Array.from(text);let start=0;
  while(start<points.length) {
    let end=start,units=0;
    while(end<points.length&&units+points[end].length<=600){units+=points[end].length;end++;}
    yield points.slice(start,end).join('');
    if(end===points.length)return;
    start=Math.max(start+1,end-60);
  }
}

function attachedWebUrls(values:string[]|undefined) {
  return [...new Set((values??[]).filter(value=>{
    if(typeof value!=='string')return false;
    const links=extractWebUrls(value);
    return links.length===1&&links[0]===value;
  }))].sort();
}

/** Only whole URL candidates accepted by the shared parser may be replaced. */
function withoutAttachedUrls(text:string,urls:string[]) {
  const attached=new Set(urls);
  // Consume the whole candidate before matching: an attached URL must not erase
  // its prefix in another URL, a query parameter, or a word containing a URL.
  return text.replace(/(?<![A-Za-z0-9_+./-])https?:\/\/[^\s<>"“”‘’«»「」『』，。！？；：、…]+/giu,candidate=>{
    const links=extractWebUrls(candidate),url=links[0];
    if(links.length!==1||!attached.has(url)||!candidate.startsWith(url))return candidate;
    // The parser trims prose wrappers/punctuation; keep that surrounding text.
    return `[分享链接]${candidate.slice(url.length)}`;
  });
}

function shareUrlRetryAllowed(data:Record<string,unknown>,result:CheckResult) {
  if(data.ManualTaskId)return false;
  const rows=data.Result as Record<string,unknown>[]; // mapResult already validated these rows.
  // pt_to_contact is the documented suspected contact-advertising label, even
  // at high confidence/risk. It is eligible for another scan, never a pass by
  // itself. A medium/high result attributed to anything else stays isolated.
  if(rows.some(row=>row.Label!=='pt_to_contact'&&(row.Label!=='nonLabel'||!['none','low'].includes((row.RiskLevel??data.RiskLevel) as string))))return false;
  return result.decision==='approved'||result.labels.includes('pt_to_contact');
}

type UploadToken={key:string;secret:string;securityToken:string;bucket:string;prefix:string;endpoint:string;region:string;expires:number};
function uploadToken(data:Record<string,unknown>):UploadToken {
  for(const name of ['AccessKeyId','AccessKeySecret','SecurityToken','BucketName','FileNamePrefix','OssInternetEndPoint'])
    if(typeof data[name]!=='string'||!data[name]||/[\r\n]/.test(data[name] as string))throw safeError();
  if(typeof data.Expiration!=='number'||!Number.isFinite(data.Expiration)||data.Expiration*1000<=Date.now()+30_000)throw safeError();
  const endpoint=new URL(data.OssInternetEndPoint as string);
  // The upstream upload target is validated before sending any image or token.
  // Only official mainland OSS endpoints are used; redirects are forbidden.
  const match=/^oss-(cn-[a-z]+)\.aliyuncs\.com$/.exec(endpoint.hostname);
  if(endpoint.protocol!=='https:'||!match||!regions.has(match[1])||endpoint.port||endpoint.username||endpoint.password||endpoint.search||endpoint.hash||endpoint.pathname!=='/')throw safeError();
  if(!/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(data.BucketName as string)||!/^[-a-zA-Z0-9_/]+\/$/.test(data.FileNamePrefix as string))throw safeError();
  return {key:data.AccessKeyId as string,secret:data.AccessKeySecret as string,securityToken:data.SecurityToken as string,
    bucket:data.BucketName as string,prefix:data.FileNamePrefix as string,endpoint:endpoint.hostname,region:match[1],expires:data.Expiration};
}

/** Official OSS V4 signing. The temporary object retains private access. */
async function uploadImage(bytes:Buffer,mime:string,token:UploadToken,deadline:number) {
  const ext=mime==='image/jpeg'?'jpg':mime.split('/')[1];
  const key=`${token.prefix}${randomUUID()}.${ext}`;
  const stamp=new Date().toISOString().replace(/[:-]|\.\d{3}/g,'');const date=stamp.slice(0,8);
  // The service-issued STS token cannot override ACLs; inherit the vendor bucket's private access.
  const headers:Record<string,string>={'content-type':mime,'content-md5':createHash('md5').update(bytes).digest('base64'),
    'x-oss-content-sha256':'UNSIGNED-PAYLOAD','x-oss-date':stamp,'x-oss-security-token':token.securityToken};
  const canonicalHeaders=Object.keys(headers).sort().map(name=>`${name}:${headers[name].trim()}\n`).join('');
  const canonical=['PUT',`/${token.bucket}/${key}`,'',canonicalHeaders,'','UNSIGNED-PAYLOAD'].join('\n');
  const scope=`${date}/${token.region}/oss/aliyun_v4_request`;
  const hmac=(key:string|Buffer,value:string)=>createHmac('sha256',key).update(value).digest();
  const signingKey=hmac(hmac(hmac(hmac(`aliyun_v4${token.secret}`,date),token.region),'oss'),'aliyun_v4_request');
  const signature=createHmac('sha256',signingKey).update(`OSS4-HMAC-SHA256\n${stamp}\n${scope}\n${sha256(canonical)}`).digest('hex');
  headers.authorization=`OSS4-HMAC-SHA256 Credential=${token.key}/${scope},Signature=${signature}`;
  const response=await cloudFetch(`https://${token.bucket}.${token.endpoint}/${key}`,{method:'PUT',redirect:'error',headers,body:new Uint8Array(bytes),signal:timeout(deadline)});
  if(!response.ok)throw safeError(transientStatus(response.status));
  await response.body?.cancel();
  return key;
}

function animatedPng(bytes:Buffer) {
  for(let offset=8;offset+12<=bytes.length;) {
    const length=bytes.readUInt32BE(offset);if(offset+12+length>bytes.length)throw safeError();
    const chunk=bytes.toString('ascii',offset+4,offset+8);
    if(chunk==='acTL')return true;if(chunk==='IEND')return false;
    offset+=12+length;
  }
  return false;
}

export async function moderateContent(input:ModerationInput):Promise<ModerationResult> {
  if(!moderationProviderStatus().configured)throw safeError();
  const s=settings();const deadline=Date.now()+110_000;
  const pendingApprovals=new Map<string,CheckResult>();
  let decision:ModerationDecision='approved';const labels=new Set<string>();let examined=0;
  const merge=(result:Omit<ModerationResult,'provider'>)=>{
    for(const label of result.labels)labels.add(label);
    if(result.decision==='rejected'||decision==='approved')decision=result.decision;
  };
  try {
    // Do not forward a user-selected identifier (which may contain a phone or
    // other personal data) into the provider's request identifiers.
    const id=sha256(input.dataId).slice(0,40);let part=0;
    async function scanText(text:string) {
      const result:CheckResult={decision:'approved',labels:[]};
      const textLabels=new Set<string>();let retryAllowed=true;
      for(const content of textChunks(text)) {
        const dataId=`${id}.t${part++}`;
        const data=await rpc('TextModerationPlus',{Service:'comment_detection_pro',ServiceParameters:JSON.stringify({content,dataId})},s,deadline);
        const chunk=mapResult(data,dataId);
        retryAllowed=shareUrlRetryAllowed(data,chunk)&&retryAllowed;
        for(const label of chunk.labels)textLabels.add(label);
        if(chunk.decision==='rejected'||result.decision==='approved')result.decision=chunk.decision;
      }
      result.labels=[...textLabels];return {result,retryAllowed};
    }
    if(input.text.trim()) {
      // The whole text is the cache unit, preserving context across edits and
      // overlapping chunks; an unchanged substring cannot inherit approval.
      const linkUrls=attachedWebUrls(input.linkUrls);
      const key=cacheKey('text',input.text,s,'',linkUrls);let result=cachedApproval(key);
      if(!result) {
        const original=await scanText(input.text);result=original.result;
        if(result.decision==='review'&&original.retryAllowed&&linkUrls.length) {
          const replacement=withoutAttachedUrls(input.text,linkUrls);
          if(replacement!==input.text) {
            // The complete original was checked first. Recheck all surrounding
            // prose, including phone/contact text, and even a URL-only marker.
            // Only explicit nonLabel none/low results can pass mapResult; this
            // exception never changes image decisions or retries recursively.
            const checked=await scanText(replacement);
            result={decision:checked.result.decision,labels:[...new Set([...result.labels,...checked.result.labels])]};
          }
        }
        pendingApprovals.set(key,result);
      }
      merge(result);examined++;
    }
    let token:UploadToken|undefined;
    for(let index=0;index<input.images.length;index++) {
      const image=input.images[index];
      if(!['image/png','image/jpeg','image/webp','image/gif'].includes(image.mime)){merge({decision:'review',labels:['unsupported_image']});continue;}
      const bytes=await getObject(image.storageKey);
      if(!bytes.length||bytes.length>20*1024*1024||imageMime(bytes)!==image.mime)throw safeError();
      // Always read the object first: a reused storage key may contain new bytes.
      const key=cacheKey('image',bytes,s,image.mime);const cached=cachedApproval(key)||pendingApprovals.get(key);
      if(cached?.decision==='approved'){merge(cached);examined++;continue;}
      const meta=await sharp(bytes,{animated:true,limitInputPixels:100_000_000}).metadata();
      if(image.mime==='image/gif'||(meta.pages??1)>1||image.mime==='image/png'&&animatedPng(bytes)) {
        merge({decision:'review',labels:['animation_requires_review']});continue;
      }
      if(!token||token.expires*1000<Date.now()+30_000)token=uploadToken(await rpc('DescribeUploadToken',{},s,deadline));
      const objectName=await uploadImage(bytes,image.mime,token,deadline);const dataId=`${id}.i${index}`;
      const result=mapResult(await rpc('ImageModeration',{Service:'postImageCheck',ServiceParameters:JSON.stringify({ossBucketName:token.bucket,ossObjectName:objectName,ossRegionId:token.region,dataId,infoType:'textInImage'})},s,deadline),dataId);
      merge(result);pendingApprovals.set(key,result);examined++;
    }
    if(!examined)merge({decision:'review',labels:['no_complete_cloud_result']});
    // A partial success from an otherwise failed/reviewed submission is not cached.
    if(decision==='approved')saveApprovals(pendingApprovals);
    return {decision,labels:[...labels],provider};
  } catch(error) {if(error instanceof ModerationTransientError)throw error;throw safeError();}
}
