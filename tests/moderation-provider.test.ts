import { after,before,test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash,createHmac } from 'node:crypto';
import { mkdtemp,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import sharp from 'sharp';

let directory:string;
let moderateContent:typeof import('../src/server/moderation-provider').moderateContent;
let moderationProviderStatus:typeof import('../src/server/moderation-provider').moderationProviderStatus;
let putObject:typeof import('../src/server/storage').putObject;
const originalFetch=globalThis.fetch;
const savedEnvironment={...process.env};
const settings={CONTENT_MODERATION_PROVIDER:'aliyun',CONTENT_MODERATION_ACCESS_KEY_ID:'test-moderation-key',CONTENT_MODERATION_ACCESS_KEY_SECRET:'test-moderation-secret',CONTENT_MODERATION_REGION:'cn-shanghai'};
const normal={RiskLevel:'none',Result:[{Label:'nonLabel'}]};
type Params={action:string;data:Record<string,any>;form:URLSearchParams};
function parse(init?:RequestInit):Params {
  const form=new URLSearchParams(String(init?.body));
  return {action:form.get('Action')||'',data:JSON.parse(form.get('ServiceParameters')||'{}'),form};
}
function answer(data:Record<string,unknown>=normal){return Response.json({Code:200,Data:data});}
function input(text='用于审核的社区消息'){return {text,images:[],dataId:'post-123'};}

before(async()=>{
  directory=await mkdtemp(path.join(tmpdir(),'community-moderation-provider-'));
  Object.assign(process.env,settings,{STORAGE_DRIVER:'local',LOCAL_STORAGE_DIR:directory});
  ({moderateContent,moderationProviderStatus}=await import('../src/server/moderation-provider'));
  ({putObject}=await import('../src/server/storage'));
});
after(async()=>{
  globalThis.fetch=originalFetch;
  for(const name of Object.keys(process.env))if(!(name in savedEnvironment))delete process.env[name];
  Object.assign(process.env,savedEnvironment);
  if(directory)await rm(directory,{recursive:true,force:true});
});

test('manual, missing credentials and unsupported configuration never call the cloud',async()=>{
  let calls=0;globalThis.fetch=async()=>{calls++;return answer();};
  try {
    for(const provider of ['manual','something-else']) {
      process.env.CONTENT_MODERATION_PROVIDER=provider;
      assert.equal(moderationProviderStatus().configured,false);
      await assert.rejects(moderateContent(input()),/人工审核/);
    }
    Object.assign(process.env,settings);delete process.env.CONTENT_MODERATION_ACCESS_KEY_SECRET;
    process.env.ALI_ACCESS_KEY_SECRET='general-key-must-not-enable-paid-scans';
    assert.equal(moderationProviderStatus().configured,false);
    await assert.rejects(moderateContent(input()),/人工审核/);
    Object.assign(process.env,settings,{CONTENT_MODERATION_REGION:'https://untrusted.example'});
    assert.equal(moderationProviderStatus().configured,false);
    await assert.rejects(moderateContent(input()),/人工审核/);
    assert.equal(calls,0);
  } finally {Object.assign(process.env,settings);}
});

test('RPC POST signature covers UTF-8 business parameters and keeps content out of URL',async()=>{
  const content="中文 + & = / ' * ! ~ 😀";
  globalThis.fetch=async(url,init)=>{
    assert.equal(String(url),'https://green-cip.cn-shanghai.aliyuncs.com/');assert.equal(init?.method,'POST');assert.equal(init?.redirect,'error');
    assert.ok(init?.signal instanceof AbortSignal);
    const {action,data,form}=parse(init);
    assert.equal(action,'TextModerationPlus');assert.equal(form.get('Version'),'2022-03-02');assert.equal(form.get('Service'),'comment_detection_pro');
    assert.equal(data.content,content);assert.match(data.dataId,/^[a-f0-9]{40}\.t0$/);assert.ok(!data.dataId.includes('13812345678'));
    const signature=form.get('Signature');form.delete('Signature');
    const esc=(s:string)=>encodeURIComponent(s).replace(/[!'()*]/g,char=>`%${char.charCodeAt(0).toString(16).toUpperCase()}`);
    const ordered=[...form.entries()].sort(([a],[b])=>a<b?-1:a>b?1:0).map(([key,value])=>`${esc(key)}=${esc(value)}`).join('&');
    assert.equal(signature,createHmac('sha1','test-moderation-secret&').update(`POST&%2F&${esc(ordered)}`).digest('base64'));
    return answer({...normal,DataId:data.dataId});
  };
  assert.equal((await moderateContent({...input(content),dataId:'13812345678'})).decision,'approved');
});

test('only explicit no-risk labels pass; politics and ambiguous violence remain reviewable',async()=>{
  const cases:Array<[Record<string,unknown>,string]>=[
    [normal,'approved'],[{RiskLevel:'low',Result:[{Label:'nonLabel'}]},'approved'],
    [{RiskLevel:'high',Result:[{Label:'pornographic_adult',Confidence:99}]},'rejected'],
    [{RiskLevel:'high',Result:[{Label:'pornographic_adultContent_tii_lib',Confidence:99}]},'rejected'],
    [{RiskLevel:'high',Result:[{Label:'violent_blood',Confidence:99}]},'rejected'],
    [{RiskLevel:'medium',Result:[{Label:'pornographic_adult',Confidence:80}]},'review'],
    [{RiskLevel:'high',Result:[{Label:'political_figure',Confidence:99}]},'review'],
    [{RiskLevel:'low',Result:[{Label:'political_entity',Confidence:30}]},'review'],
    [{RiskLevel:'high',Result:[{Label:'violent_crowding',Confidence:99}]},'review'],
    [{RiskLevel:'high',Result:[{Label:'violent_weapons',Confidence:99}]},'review'],
    [{RiskLevel:'none',Result:[{Label:'nonLabel_lib'}]},'review'],
    [{RiskLevel:'none',Result:[{Label:'unrecognized_future_label'}]},'review'],
    [{RiskLevel:'none',Result:[{Label:'nonLabel'}],ManualTaskId:'manual-task'},'review'],
    [{RiskLevel:'high',Result:[{Label:'political_figure',Confidence:99},{Label:'pornographic_adult',Confidence:20,RiskLevel:'low'}]},'review'],
    [{RiskLevel:'high',Result:[{Label:'political_figure',Confidence:99},{Label:'pornographic_adult',Confidence:20}]},'review'],
    [{RiskLevel:'high',Result:[{Label:'political_figure',Confidence:99},{Label:'pornographic_adult',Confidence:99,RiskLevel:'high'}]},'rejected'],
  ];
  for(const [index,[data,decision]] of cases.entries()) {
    globalThis.fetch=async()=>answer(data);
    // Each provider response describes different content; an earlier approval
    // of identical bytes intentionally uses the application's approval cache.
    assert.equal((await moderateContent(input(`风险映射用例 ${index}`))).decision,decision,JSON.stringify(data));
  }
});

test('empty, malformed, stale, errored and timed-out cloud responses fail closed without raw details',async()=>{
  const responses:Array<()=>Response|Promise<Response>>=[
    ()=>answer({RiskLevel:'none',Result:[]}),()=>answer({Result:[{Label:'nonLabel'}]}),
    ()=>answer({RiskLevel:'future',Result:[{Label:'nonLabel'}]}),()=>answer({...normal,DataId:'another-content'}),
    ()=>answer({RiskLevel:'none',Result:[{Label:'nonLabel',Confidence:'100'}]}),
    ()=>answer({RiskLevel:'none',Result:[{Label:'nonLabel',Confidence:101}]}),
    ()=>answer({RiskLevel:'none',Result:[{Description:'looks fine but no Label'}]}),
    ()=>Response.json({Code:500,Message:'PRIVATE-TEXT-and-API-secret'}),
    ()=>new Response('PRIVATE-HTML-error',{status:503}),()=>new Response('broken JSON'),
    ()=>{throw new DOMException('private-timeout-request-body','TimeoutError');},
  ];
  for(const [index,response] of responses.entries()) {
    globalThis.fetch=async()=>response();
    await assert.rejects(moderateContent(input(`异常响应用例 ${index}`)),(error:Error)=>{
      assert.equal(error.message,'内容审核服务暂不可用，请等待人工审核');assert.equal('cause' in error,false);return true;
    });
  }
});

test('long Unicode text is scanned completely with overlap; a risky tail cannot be skipped',async()=>{
  const text=Array.from({length:1700},(_,i)=>String.fromCodePoint(0x4e00+i)).join('')+'😀'.repeat(40)+'END-TAIL';
  const chunks:string[]=[];
  globalThis.fetch=async(_url,init)=>{
    const {data}=parse(init);chunks.push(data.content);
    assert.ok(data.content.length<=600);assert.ok(!/[\uD800-\uDBFF]$|^[\uDC00-\uDFFF]/.test(data.content));
    return answer(data.content.includes('END-TAIL')?{RiskLevel:'high',Result:[{Label:'political_entity',Confidence:99}]}:normal);
  };
  assert.equal((await moderateContent(input(text))).decision,'review');assert.ok(chunks.length>=3);
  let covered='';
  for(const chunk of chunks) {
    if(!covered){covered=chunk;continue;}
    const overlap=Array.from(covered).slice(-60).join('');assert.ok(chunk.startsWith(overlap));covered+=chunk.slice(overlap.length);
  }
  assert.equal(covered,text);
});

const tokenData=()=>({AccessKeyId:'STS.test-key',AccessKeySecret:'temporary-secret',SecurityToken:'temporary-sts-token',BucketName:'oss-cip-shanghai',FileNamePrefix:'upload/test/',OssInternetEndPoint:'https://oss-cn-shanghai.aliyuncs.com',Expiration:Math.floor(Date.now()/1000)+1800});

test('every image inherits private temporary OSS access without an ACL override; V4 binds the object and STS token',async()=>{
  const fixtures=await Promise.all(['#427','#527'].map(background=>sharp({create:{width:250,height:250,channels:3,background}}).png().toBuffer()));
  const keys=['images/first.png','images/second.png'];for(const [index,key] of keys.entries())await putObject(key,fixtures[index],'image/png');
  let uploaded=0,scanned=0,tokens=0;const uploadedKeys:string[]=[];
  globalThis.fetch=async(url,init)=>{
    if(init?.method==='PUT') {
      const bytes=fixtures[uploaded++];const u=new URL(String(url));assert.equal(u.hostname,'oss-cip-shanghai.oss-cn-shanghai.aliyuncs.com');assert.equal(u.search,'');
      assert.equal(init.redirect,'error');assert.ok(Buffer.from(init.body as Uint8Array).equals(bytes));
      const headers=new Headers(init.headers);
      if(headers.has('x-oss-object-acl'))return new Response('<Error><Code>AccessDenied</Code><EC>0003-00000301</EC></Error>',{status:403});
      assert.equal(headers.has('x-oss-object-acl'),false);assert.equal(headers.get('x-oss-security-token'),'temporary-sts-token');
      assert.equal(headers.get('content-md5'),createHash('md5').update(bytes).digest('base64'));
      const stamp=headers.get('x-oss-date')!;assert.match(stamp,/^\d{8}T\d{6}Z$/);
      const scope=`${stamp.slice(0,8)}/cn-shanghai/oss/aliyun_v4_request`;
      const canonicalHeaders=[...headers.entries()].filter(([name])=>name!=='authorization').sort(([a],[b])=>a<b?-1:1).map(([name,value])=>`${name}:${value}\n`).join('');
      const canonical=`PUT\n/oss-cip-shanghai${u.pathname}\n\n${canonicalHeaders}\n\nUNSIGNED-PAYLOAD`;
      let signingKey:Buffer=Buffer.from('aliyun_v4temporary-secret');for(const value of [stamp.slice(0,8),'cn-shanghai','oss','aliyun_v4_request'])signingKey=createHmac('sha256',signingKey).update(value).digest();
      const signature=createHmac('sha256',signingKey).update(`OSS4-HMAC-SHA256\n${stamp}\n${scope}\n${createHash('sha256').update(canonical).digest('hex')}`).digest('hex');
      assert.equal(headers.get('authorization'),`OSS4-HMAC-SHA256 Credential=STS.test-key/${scope},Signature=${signature}`);
      uploadedKeys.push(u.pathname.slice(1));return new Response(null,{status:200});
    }
    const {action,data,form}=parse(init);
    if(action==='DescribeUploadToken'){tokens++;return answer(tokenData());}
    assert.equal(action,'ImageModeration');assert.equal(form.get('Service'),'postImageCheck');assert.equal(data.imageUrl,undefined);
    assert.equal(data.ossBucketName,'oss-cip-shanghai');assert.equal(data.ossRegionId,'cn-shanghai');assert.ok(uploadedKeys.includes(data.ossObjectName));scanned++;
    return answer(scanned===2?{RiskLevel:'high',Result:[{Label:'violent_blood',Confidence:99}]}:normal);
  };
  assert.equal((await moderateContent({text:'',images:keys.map(storageKey=>({storageKey,mime:'image/png'})),dataId:'two-images'})).decision,'rejected');
  assert.equal(tokens,1);assert.equal(uploaded,2);assert.equal(scanned,2);assert.notEqual(uploadedKeys[0],uploadedKeys[1]);
});

test('GIF and animated WebP require manual review and are never approved from their first frame',async()=>{
  // Two stacked pages are encoded as animation by sharp's raw pageHeight.
  const data=Buffer.alloc(4*8*3,80);data.fill(160,4*4*3);
  for(const format of ['gif','webp'] as const) {
    const bytes=await sharp(data,{raw:{width:4,height:8,channels:3,pageHeight:4}})[format]({loop:0,delay:[100,100]}).toBuffer();
    assert.equal((await sharp(bytes,{animated:true}).metadata()).pages,2,'Fixture must preserve both animation frames');
    const key=`images/animated.${format}`;await putObject(key,bytes,`image/${format}`);
    let calls=0;globalThis.fetch=async()=>{calls++;return answer();};
    const result=await moderateContent({text:'',images:[{storageKey:key,mime:`image/${format}`}],dataId:'animation'});
    assert.equal(result.decision,'review');assert.ok(result.labels.includes('animation_requires_review'));assert.equal(calls,0);
  }
});

test('temporary upload errors or foreign upload endpoints cannot produce approval',async()=>{
  const bytes=await sharp({create:{width:8,height:8,channels:3,background:'#234'}}).png().toBuffer();await putObject('images/failure.png',bytes,'image/png');
  for(const mode of ['foreign-host','expired','upload-error']) {
    let uploads=0,scans=0;
    globalThis.fetch=async(_url,init)=>{
      if(init?.method==='PUT'){uploads++;return new Response(null,{status:403});}
      const {action}=parse(init);if(action==='ImageModeration'){scans++;return answer();}
      const data=tokenData();if(mode==='foreign-host')data.OssInternetEndPoint='https://private-content.example';if(mode==='expired')data.Expiration=1;
      return answer(data);
    };
    await assert.rejects(moderateContent({text:'',images:[{storageKey:'images/failure.png',mime:'image/png'}],dataId:'failure'}),/人工审核/);
    assert.equal(scans,0);assert.equal(uploads,mode==='upload-error'?1:0);
  }
});
