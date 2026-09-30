import { createHmac,randomUUID } from 'node:crypto';

export const SMS_OTP_LENGTH=6;
export const SMS_OTP_TTL_SECONDS=300;

const safeError=()=>new Error('验证码暂时无法发送，请稍后重试');
const encode=(value:string)=>encodeURIComponent(value).replace(/[!'()*]/g,c=>`%${c.charCodeAt(0).toString(16).toUpperCase()}`);

function settings() {
  const provider=process.env.SMS_PROVIDER?.trim()||'aliyun-sms';
  const dedicatedKey=process.env.SMS_ACCESS_KEY_ID?.trim()||'';
  const dedicatedSecret=process.env.SMS_ACCESS_KEY_SECRET?.trim()||'';
  // A partly configured dedicated pair must not silently use another identity.
  const dedicated=!!(dedicatedKey||dedicatedSecret);
  const key=dedicated?dedicatedKey:process.env.ALI_ACCESS_KEY_ID?.trim()||'';
  const secret=dedicated?dedicatedSecret:process.env.ALI_ACCESS_KEY_SECRET?.trim()||'';
  const signName=process.env.SMS_SIGN_NAME?.trim()||'';
  const templateCode=process.env.SMS_TEMPLATE_CODE?.trim()||'';
  if(!['aliyun-sms','aliyun-pnvs'].includes(provider)||!key||!secret||!signName||!templateCode)throw safeError();
  return {provider,key,secret,signName,templateCode};
}

/** Delivery only: Better Auth generates, stores and verifies this exact code.
 * PNVS accepts a literal verification code; CheckSmsVerifyCode cannot verify
 * developer-generated codes, so it must not replace our existing verifier.
 * https://help.aliyun.com/zh/pnvs/developer-reference/api-dypnsapi-2017-05-25-sendsmsverifycode
 */
export async function sendSmsMessage(phone:string,code:string):Promise<void> {
  try {
    if(typeof phone!=='string'||!/^(?:\+86)?1[3-9]\d{9}$/.test(phone)
      ||typeof code!=='string'||code.length!==SMS_OTP_LENGTH||!/^\d+$/.test(code))throw safeError();
    const {provider,key,secret,signName,templateCode}=settings();
    const pnvs=provider==='aliyun-pnvs';
    const number=phone.replace(/^\+86/,'');
    const params:Record<string,string>={AccessKeyId:key,Action:pnvs?'SendSmsVerifyCode':'SendSms',Format:'JSON',Version:'2017-05-25',
      RegionId:'cn-hangzhou',SignatureMethod:'HMAC-SHA1',SignatureVersion:'1.0',SignatureNonce:randomUUID(),
      Timestamp:new Date().toISOString().replace(/\.\d{3}Z$/,'Z'),SignName:signName,TemplateCode:templateCode,
      ...(pnvs?{PhoneNumber:number,CountryCode:'86',TemplateParam:JSON.stringify({code,min:String(SMS_OTP_TTL_SECONDS/60)}),
        ReturnVerifyCode:'false',AutoRetry:'0',Interval:'60',ValidTime:String(SMS_OTP_TTL_SECONDS),CodeLength:String(SMS_OTP_LENGTH)}
        :{PhoneNumbers:number,TemplateParam:JSON.stringify({code})})};
    const canonical=Object.keys(params).sort().map(name=>`${encode(name)}=${encode(params[name])}`).join('&');
    const signature=createHmac('sha1',`${secret}&`).update(`POST&%2F&${encode(canonical)}`).digest('base64');
    // Never retry an uncertain send or fall back to a second provider: the first
    // request may already have delivered and charged for the SMS.
    const response=await fetch(pnvs?'https://dypnsapi.aliyuncs.com/':'https://dysmsapi.aliyuncs.com/',{
      method:'POST',redirect:'error',headers:{'content-type':'application/x-www-form-urlencoded'},
      body:`${canonical}&Signature=${encode(signature)}`,signal:AbortSignal.timeout(15_000)
    });
    if(!response.ok)throw safeError();
    const result:unknown=await response.json();
    if(!result||typeof result!=='object'||Array.isArray(result))throw safeError();
    const data=result as Record<string,unknown>;
    if(data.Code!=='OK'||(pnvs&&data.Success!==true))throw safeError();
  } catch {
    // Transport errors and provider responses can contain phone numbers, codes
    // or signed requests. Keep those out of application logs and API errors.
    throw safeError();
  }
}
