import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { createMcp } from '@/mcp/server';
import { actorFromRequest } from '@/server/auth';
import { execute } from '@/server/service';
import { errorResponse } from '@/server/http';
import { config } from '@/server/config';
import { fail } from '@/shared/contracts';
export const runtime='nodejs';
export const dynamic='force-dynamic';
export async function POST(request:Request){
  try{
    const origin=request.headers.get('origin');if(origin&&origin!==new URL(config.url).origin)fail(403,'不允许此来源');
    const actor=await actorFromRequest(request,`${config.url}/mcp`);if(!actor.userId)fail(401,'请授权 MCP 客户端访问社区');
    const server=createMcp((action,input)=>execute(action,input,actor));
    const transport=new WebStandardStreamableHTTPServerTransport({sessionIdGenerator:undefined,enableJsonResponse:true});await server.connect(transport);
    const response=await transport.handleRequest(request);await transport.close();await server.close();return response;
  }catch(e){return errorResponse(e,'mcp');}
}
export function GET(){return new Response(null,{status:405,headers:{Allow:'POST'}});}
export const DELETE=GET;
