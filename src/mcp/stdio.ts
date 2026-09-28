import 'dotenv/config';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createMcp } from './server';
const base=process.env.AICOMMUNITY_URL||'http://localhost:3100';
const token=process.env.AICOMMUNITY_TOKEN;
if(!token)throw new Error('Set AICOMMUNITY_TOKEN to a scoped token from the Agent settings page.');
const server=createMcp(async(action,input)=>{const r=await fetch(`${base}/api/v1/actions/${action}`,{method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${token}`},body:JSON.stringify(input)});const body=await r.json();if(!r.ok)throw new Error(body.error||`HTTP ${r.status}`);return body;});
await server.connect(new StdioServerTransport());
