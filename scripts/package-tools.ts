import { build } from 'esbuild';
import { mkdir,writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
await mkdir('dist/tools',{recursive:true});
await build({entryPoints:{cli:'src/cli/index.ts',mcp:'src/mcp/stdio.ts'},outdir:'dist/tools',outExtension:{'.js':'.mjs'},bundle:true,platform:'node',format:'esm',target:'node22',sourcemap:false,banner:{js:'#!/usr/bin/env node\nimport {createRequire as __createRequire} from "node:module"; const require=__createRequire(import.meta.url);'},logLevel:'info'});
await writeFile('dist/tools/package.json',JSON.stringify({name:'ai-community-tools',version:'0.1.0',description:'CLI and stdio MCP for AI Community',type:'module',bin:{aicommunity:'cli.mjs','aicommunity-mcp':'mcp.mjs'},engines:{node:'>=22'},files:['cli.mjs','mcp.mjs']},null,2));
const npmExec=process.env.npm_execpath;if(!npmExec)throw new Error('Run using npm run build:tools');
const {stdout}=await promisify(execFile)(process.execPath,[npmExec,'pack','./dist/tools','--pack-destination','dist'],{windowsHide:true});console.log(stdout.trim());
