import { config } from '@/server/config';
import { scopes } from '@/shared/contracts';
export function GET(){return Response.json({resource:`${config.url}/api/v1`,authorization_servers:[`${config.url}/api/auth`],scopes_supported:scopes,bearer_methods_supported:['header']});}
