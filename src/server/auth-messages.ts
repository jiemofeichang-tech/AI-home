import { SMS_OTP_TTL_SECONDS } from './sms';

export const AUTH_RATE_LIMIT={window:60,max:100};
export const OTP_RATE_LIMIT={window:60,max:10};
export const OTP_ALLOWED_ATTEMPTS=5;

const phoneMessages:Record<string,string>={
  INVALID_OTP:'验证码不正确，请检查后重新输入',
  OTP_EXPIRED:`验证码已过期（有效期 ${SMS_OTP_TTL_SECONDS/60} 分钟），请重新获取`,
  OTP_NOT_FOUND:'还没有获取验证码，或验证码已失效，请重新获取',
  TOO_MANY_ATTEMPTS:`验证码输错已达 ${OTP_ALLOWED_ATTEMPTS} 次，这个验证码已作废，请重新获取`,
  INVALID_PHONE_NUMBER:'请输入有效的中国大陆手机号',
};

function rateLimitMessage(path:string,seconds:number) {
  const wait=seconds>=60?`请 ${Math.ceil(seconds/60)} 分钟后再试`:`请 ${seconds} 秒后再试`;
  if(path.endsWith('/phone-number/send-otp'))return `获取验证码太频繁：同一网络 1 分钟内最多获取 ${OTP_RATE_LIMIT.max} 次，${wait}`;
  if(path.endsWith('/phone-number/verify'))return `提交验证码太频繁：同一网络 1 分钟内最多提交 ${OTP_RATE_LIMIT.max} 次，${wait}`;
  return `操作太频繁：短时间内请求次数过多，${wait}`;
}

function rewrite(response:Response,status:number,body:Record<string,unknown>,retryAfter?:number) {
  const headers=new Headers(response.headers);
  headers.set('Content-Type','application/json');headers.delete('Content-Length');
  if(retryAfter)headers.set('Retry-After',String(retryAfter));
  return new Response(JSON.stringify(body),{status,headers});
}

/** Better Auth's limiter and phone plugin answer in English; members see these messages directly. */
export async function localizeAuthResponse(request:Request,response:Response):Promise<Response> {
  if(response.status<400)return response;
  const path=new URL(request.url).pathname;
  const retryHeader=response.headers.get('x-retry-after');
  if(response.status===429&&retryHeader!==null) {
    // Better Auth computes the delay by adding the window to the stored int8
    // timestamp, which pg returns as a string, so the header can be nonsense.
    // A full window is always enough for the bucket to reset.
    const window=path.includes('/phone-number/')?OTP_RATE_LIMIT.window:AUTH_RATE_LIMIT.window;
    const reported=Math.ceil(Number(retryHeader));
    const seconds=Number.isFinite(reported)&&reported>0&&reported<=window?reported:window;
    return rewrite(response,429,{code:'RATE_LIMITED',message:rateLimitMessage(path,seconds),retryAfter:seconds},seconds);
  }
  if(!response.headers.get('content-type')?.includes('application/json'))return response;
  const body=await response.clone().json().catch(()=>null) as Record<string,unknown>|null;
  const message=body&&typeof body.code==='string'?phoneMessages[body.code]:undefined;
  return message?rewrite(response,response.status,{...body,message}):response;
}
