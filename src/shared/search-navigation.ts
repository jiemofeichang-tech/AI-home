import type { Item } from './contracts';

export const searchTypes=['all','posts','github','communities','events'] as const;
export type SearchState={q:string;type:typeof searchTypes[number];city:string;pages:number};
export const MAX_SEARCH_PAGES=20;
export function readSearchState(params:Pick<URLSearchParams,'get'>):SearchState {
  const type=params.get('type'),pages=Number(params.get('pages')||1);
  return {q:(params.get('q')||'').slice(0,200),type:searchTypes.includes(type as SearchState['type'])?type as SearchState['type']:'all',
    city:(params.get('city')||'').slice(0,60),pages:Number.isSafeInteger(pages)?Math.min(MAX_SEARCH_PAGES,Math.max(1,pages)):1};
}
export function searchHref(state:SearchState) {
  const params=new URLSearchParams();
  if(state.q)params.set('q',state.q);if(state.type!=='all')params.set('type',state.type);if(state.city)params.set('city',state.city);
  if(state.pages>1)params.set('pages',String(state.pages));
  return `/discover${params.size?`?${params}`:''}`;
}
/** Read the live address at event time: consecutive filter events can precede
 * React's next render. Null lets Next's history wrapper copy its own internals. */
export function replaceSearchQuery(target:{location:{search:string};history:Pick<History,'replaceState'>},patch:Partial<SearchState>,beforeReplace?:(href:string)=>void) {
  const current=readSearchState(new URLSearchParams(target.location.search));
  const next=readSearchState(new URLSearchParams({...current,...patch,pages:String(patch.pages??1)} as Record<string,string>));
  const href=searchHref(next);beforeReplace?.(href);target.history.replaceState(null,'',href);return href;
}
/** Only a canonical local search URL may be used by a detail page's return link. */
export function searchReturnHref(value:string|null|undefined):string|null {
  if(!value||!/^\/discover(?:\?|$)/.test(value)||value.length>3000)return null;
  try {const url=new URL(value,'https://community.invalid');return url.pathname==='/discover'&&!url.hash?searchHref(readSearchState(url.searchParams)):null;}catch{return null;}
}
export function searchEndpoint(state:SearchState) {
  return `search?${new URLSearchParams({q:state.q.trim(),type:state.type,city:state.city,limit:'20'})}`;
}
/** Re-fetch saved pagination using current permissions instead of caching posts. */
export async function loadSearchPages(state:SearchState,read:(endpoint:string)=>Promise<Item>,signal:AbortSignal,previous?:Item):Promise<Item> {
  const abort=()=>{if(signal.aborted)throw new DOMException('Search was cancelled','AbortError');};
  abort();if(!state.q.trim())return {posts:[],communities:[],events:[],searchLoadedPages:1};
  const target=Math.min(MAX_SEARCH_PAGES,Math.max(1,state.pages)),endpoint=searchEndpoint(state);
  const append=previous&&previous.searchLoadedPages<target&&previous.nextCursor;
  let pages=append?previous.searchLoadedPages:0,result:Item=append?previous:{},posts:Item[]=append?[...(previous.posts||[])]:[];
  const cursors=new Set<string>(),ids=new Set(posts.map(post=>post.id));
  while(pages<target) {
    abort();const cursor=pages?result.nextCursor:null;
    if(pages&&!cursor)break;if(cursor&&cursors.has(cursor))break;if(cursor)cursors.add(cursor);
    result=await read(`${endpoint}${cursor?`&cursor=${encodeURIComponent(cursor)}`:''}`);abort();pages++;
    for(const post of result.posts||[])if(!ids.has(post.id)){ids.add(post.id);posts.push(post);}
  }
  return {...result,posts,searchLoadedPages:pages};
}

export type SearchPosition={href:string;y:number;viewer:string;savedAt:number};
export function readSearchPosition(value:unknown,href:string,viewer:string,now=Date.now()):SearchPosition|null {
  if(!value||typeof value!=='object')return null;const item=value as SearchPosition;
  return item.href===href&&item.viewer===viewer&&Number.isFinite(item.y)&&item.y>=0&&item.y<=10_000_000&&
    Number.isFinite(item.savedAt)&&item.savedAt<=now&&now-item.savedAt<30*60_000?item:null;
}
