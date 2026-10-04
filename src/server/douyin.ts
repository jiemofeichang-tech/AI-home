import { safeFetch } from './providers';
import { getDouyinEmbed,isDouyinVideoId,officialDouyinUrl,type DouyinEmbed } from '../shared/douyin';

const apiPath='/api/douyin/v1/video/get_iframe_by_video';
const allowedAttributes=new Set(['src','width','height','frameborder','referrerpolicy','allowfullscreen','allow','scrolling']);

/** Read only one simple iframe's src. The HTML and its attributes are discarded. */
function trustedPlayer(code:unknown,videoId:string):boolean {
  if(typeof code!=='string'||code.length>8192)return false;
  let attributes=code.match(/^\s*<iframe\b([^<>]*)>\s*<\/iframe>\s*$/i)?.[1];
  if(attributes===undefined)return false;
  const seen=new Set<string>();let source:string|undefined;
  while(attributes.trim()) {
    const match=attributes.match(/^\s+([a-zA-Z][\w:-]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'`=<>]+)))?/);
    if(!match)return false;
    const name=match[1].toLowerCase();
    if(seen.has(name)||!allowedAttributes.has(name))return false;
    seen.add(name);
    if(name==='src')source=match[2]??match[3]??match[4];
    attributes=attributes.slice(match[0].length);
  }
  const url=officialDouyinUrl(source?.replace(/&amp;/gi,'&'),['open.douyin.com']);
  return !!url&&url.pathname==='/player/video'&&!url.hash&&url.searchParams.getAll('vid').length===1
    &&url.searchParams.get('vid')===videoId&&url.searchParams.getAll('autoplay').length<=1
    &&(!url.searchParams.has('autoplay')||url.searchParams.get('autoplay')==='0')
    &&[...url.searchParams.keys()].every(key=>key==='vid'||key==='autoplay');
}

/** null means no trustworthy public embed; transient provider errors throw so
 * the existing parsing queue retries without changing the original post. */
export async function fetchDouyinEmbed(videoId:string,fetchPage:typeof safeFetch=safeFetch):Promise<{embed:DouyinEmbed;title:string}|null> {
  if(!isDouyinVideoId(videoId))return null;
  const response=await fetchPage(`https://open.douyin.com${apiPath}?video_id=${videoId}`,64_000);
  const finalUrl=officialDouyinUrl(response.url,['open.douyin.com']);
  if(!finalUrl||finalUrl.pathname!==apiPath||finalUrl.hash||finalUrl.searchParams.size!==1||finalUrl.searchParams.get('video_id')!==videoId)return null;
  let payload:unknown;
  try {payload=JSON.parse(response.body);}catch {throw new Error('抖音播放器服务暂未返回有效数据');}
  if(!payload||typeof payload!=='object'||Array.isArray(payload))return null;
  const {err_no,data}=payload as Record<string,unknown>;
  if(err_no===28001005)throw new Error('抖音播放器服务暂时不可用，请稍后重试');
  if(err_no!==0||!data||typeof data!=='object'||Array.isArray(data))return null;
  const result=data as Record<string,unknown>;
  const embed=getDouyinEmbed({douyinEmbed:{videoId,width:result.video_width,height:result.video_height}});
  if(!embed||!trustedPlayer(result.iframe_code,videoId)||typeof result.video_title!=='string')return null;
  return {embed,title:result.video_title.slice(0,5000)};
}
