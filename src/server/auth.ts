import { betterAuth, type BetterAuthPlugin } from 'better-auth';
import { jwt, phoneNumber } from 'better-auth/plugins';
import { createAuthClient } from 'better-auth/client';
import { oauthProvider, extendOAuthProvider } from '@better-auth/oauth-provider';
import { oauthProviderResourceClient } from '@better-auth/oauth-provider/resource-client';
import { pool,query } from './db';
import { config,validateProduction } from './config';
import { sendSms } from './providers';
import { digest,ensureProfile } from './service';
import { active } from './permissions';
import { fail,scopes,type Actor } from '../shared/contracts';

validateProduction();
const grantBinding:BetterAuthPlugin={
  id:'community-grant-binding',
  init(ctx) {
    extendOAuthProvider(ctx,{
      claims:{accessToken:async input=>{
        if(!input.user) throw new Error('User authorization is required');
        const [g]=await query(`SELECT id FROM agent_grants WHERE user_id=$1 AND oauth_client_id=$2 AND revoked_at IS NULL AND expires_at>now() ORDER BY created_at DESC LIMIT 1`,[input.user.id,input.client.clientId]);
        if(!g) throw new Error('Community authorization is missing or revoked');
        return {community_grant_id:g.id};
      }}
    });
  }
};
function createAuth(){return betterAuth({
  appName:'AI 社区',baseURL:config.url,basePath:'/api/auth',secret:config.secret||'build-only-not-valid-for-production-secret',database:pool,
  trustedOrigins:[config.url],
  advanced:{database:{validateSchema:process.env.NEXT_PHASE!=='phase-production-build'},ipAddress:{ipAddressHeaders:process.env.AUTH_IP_HEADER?[process.env.AUTH_IP_HEADER]:[]}},
  rateLimit:{enabled:true,storage:'database',window:60,max:100},
  session:{cookieCache:{enabled:false}},
  user:{deleteUser:{enabled:false}},
  databaseHooks:{user:{create:{after:async u=>{await ensureProfile(u.id);if(process.env.ADMIN_PHONE&&u.phoneNumber===process.env.ADMIN_PHONE) await query(`UPDATE profiles SET role='admin' WHERE user_id=$1`,[u.id]);}}}},
  plugins:[
    phoneNumber({sendOTP:async ({phoneNumber,code})=>sendSms(phoneNumber,code),phoneNumberValidator:n=>/^\+86[1][3-9]\d{9}$/.test(n),expiresIn:300,allowedAttempts:5,signUpOnVerification:{getTempEmail:n=>`${digest(n).slice(0,24)}@phone.invalid`,getTempName:()=>`新朋友${Math.floor(Math.random()*10000).toString().padStart(4,'0')}`}}),
    jwt(),
    oauthProvider({loginPage:'/login',consentPage:'/consent',scopes:['openid','profile','offline_access',...scopes],grantTypes:['authorization_code','refresh_token'],allowDynamicClientRegistration:true,allowUnauthenticatedClientRegistration:true,resources:[`${config.url}/api/v1`,`${config.url}/mcp`],clientRegistrationDefaultResources:[`${config.url}/api/v1`,`${config.url}/mcp`]}),
    grantBinding
  ]
});}
// Route discovery during a production build must never connect to a live database.
let authInstance:ReturnType<typeof createAuth>|undefined;
export const auth=new Proxy({} as ReturnType<typeof createAuth>,{get(_target,key){const instance=authInstance??=createAuth();return Reflect.get(instance,key,instance);}});
function createResourceClient(){return createAuthClient({plugins:[oauthProviderResourceClient(auth)]});}
let resourceClient:ReturnType<typeof createResourceClient>|undefined;
export async function actorFromRequest(request:Request,resource=`${config.url}/api/v1`):Promise<Actor> {
  const authorization=request.headers.get('authorization');
  if(authorization) {
    const token=authorization.startsWith('Bearer ')?authorization.slice(7):'';
    if(!token) fail(401,'无效的授权凭据');
    let g;let tokenScopes:string[]|undefined;
    if(token.startsWith('aic_')) [g]=await query('SELECT * FROM agent_grants WHERE token_hash=$1 AND revoked_at IS NULL AND expires_at>now()',[digest(token)]);
    else {
      let payload;
      try {payload=await (resourceClient??=createResourceClient()).verifyAccessTokenRequest(request,{jwksUrl:`${config.url}/api/auth/jwks`,verifyOptions:{audience:resource,issuer:`${config.url}/api/auth`},requiredScopes:[]});}catch{fail(401,'OAuth 令牌无效或已过期');}
      [g]=await query('SELECT * FROM agent_grants WHERE id=$1 AND user_id=$2 AND revoked_at IS NULL AND expires_at>now()',[payload.community_grant_id,payload.sub]);
      tokenScopes=String(payload.scope||'').split(' ');
    }
    if(!g) fail(401,'Agent 授权已撤销或过期');
    const a:Actor={userId:g.user_id,grantId:g.id,agentName:g.name,scopes:g.scopes,tokenScopes,communityIds:g.community_ids};await active(a);return a;
  }
  const session=await auth.api.getSession({headers:request.headers});
  if(!session) return {};
  await ensureProfile(session.user.id);const a={userId:session.user.id};await active(a);return a;
}
