export type DouyinEmbed={videoId:string;width:number;height:number};

/** IDs stay strings: Douyin video IDs exceed JavaScript's safe integer range. */
export function isDouyinVideoId(value:unknown):value is string {
  return typeof value==='string'&&/^[1-9][0-9]{0,31}$/.test(value);
}

/** Accept exact HTTPS authorities, including rejecting explicit default ports. */
export function officialDouyinUrl(value:unknown,hosts:readonly string[]):URL|null {
  if(typeof value!=='string'||value.length>4096||/[\\\s]/.test(value))return null;
  const authority=value.match(/^https:\/\/([^/?#]+)(?:[/?#]|$)/i)?.[1];
  if(!authority||!hosts.includes(authority.toLowerCase()))return null;
  try {
    const url=new URL(value);
    return url.protocol==='https:'&&!url.username&&!url.password&&!url.port&&hosts.includes(url.hostname)?url:null;
  } catch {return null;}
}

/** Only documented video URL shapes; never infer IDs from arbitrary HTML. */
export function parseDouyinVideoId(value:unknown):string|null {
  if(isDouyinVideoId(value))return value;
  const url=officialDouyinUrl(value,['www.douyin.com','www.iesdouyin.com']);
  if(!url)return null;
  if(url.hostname==='www.iesdouyin.com') {
    const id=url.pathname.match(/^\/share\/video\/([1-9][0-9]{0,31})\/?$/)?.[1];
    return id||null;
  }
  const pathId=url.pathname.match(/^\/video\/([1-9][0-9]{0,31})\/?$/)?.[1];
  const modalIds=url.searchParams.getAll('modal_id');
  if(modalIds.length>1)return null;
  if(pathId)return modalIds.length&&modalIds[0]!==pathId?null:pathId;
  return url.pathname==='/'&&modalIds.length===1&&isDouyinVideoId(modalIds[0])?modalIds[0]:null;
}

export function isDouyinShortUrl(value:unknown):boolean {
  const url=officialDouyinUrl(value,['v.douyin.com']);
  return !!url&&/^\/[A-Za-z0-9_-]{1,200}\/?$/.test(url.pathname);
}

/** Shared validation is repeated at the rendering boundary, not just ingest. */
export function getDouyinEmbed(metadata:unknown):DouyinEmbed|null {
  if(!metadata||typeof metadata!=='object'||Array.isArray(metadata))return null;
  const value=(metadata as Record<string,unknown>).douyinEmbed;
  if(!value||typeof value!=='object'||Array.isArray(value))return null;
  const {videoId,width,height}=value as Record<string,unknown>;
  if(!isDouyinVideoId(videoId)||typeof width!=='number'||typeof height!=='number'
    ||!Number.isInteger(width)||!Number.isInteger(height)||width<1||height<1||width>16384||height>16384)return null;
  return {videoId,width,height};
}

export function douyinPlayerUrl(videoId:unknown):string|null {
  return isDouyinVideoId(videoId)?`https://open.douyin.com/player/video?vid=${videoId}&autoplay=0`:null;
}
