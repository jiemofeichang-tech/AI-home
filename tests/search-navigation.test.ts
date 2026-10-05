import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadSearchPages,MAX_SEARCH_PAGES,readSearchPosition,readSearchState,replaceSearchQuery,searchEndpoint,searchHref,searchReturnHref,type SearchState } from '../src/shared/search-navigation';

const state:SearchState={q:'阅读 AI / 新手',type:'posts',city:'杭州',pages:3};
test('a shared or refreshed search URL restores keyword, type, city and pagination',()=>{
  const href=searchHref(state);assert.equal(new URL(href,'https://example.test').pathname,'/discover');
  assert.deepEqual(readSearchState(new URL(href,'https://example.test').searchParams),state);
  const endpoint=new URL(searchEndpoint(state),'https://example.test');
  assert.equal(endpoint.searchParams.get('q'),state.q);assert.equal(endpoint.searchParams.get('type'),'posts');
  assert.equal(endpoint.searchParams.get('city'),'杭州');assert.equal(endpoint.searchParams.get('limit'),'20');
  assert.equal(searchHref({q:'',type:'all',city:'',pages:1}),'/discover');
});
test('detail return links only accept canonical local searches and bound untrusted URL state',()=>{
  assert.equal(searchReturnHref(searchHref(state)),searchHref(state));
  for(const value of ['https://evil.test/discover?q=x','//evil.test/discover','javascript:alert(1)','/discover/../admin','/discover#x','/admin','/discover\\evil'])assert.equal(searchReturnHref(value),null);
  const parsed=readSearchState(new URLSearchParams({q:'x'.repeat(300),city:'城'.repeat(100),type:'private',pages:'1000000'}));
  assert.equal(parsed.q.length,200);assert.equal(parsed.city.length,60);assert.equal(parsed.type,'all');assert.equal(parsed.pages,MAX_SEARCH_PAGES);
  assert.equal(readSearchState(new URLSearchParams('pages=NaN')).pages,1);
});
test('consecutive filter events merge the live URL and let the Next history wrapper synchronize hooks',()=>{
  const target={location:{search:''},history:{replaceState(data:unknown,_unused:string,url?:string|URL|null){
    assert.equal(data,null,'Passing Next internals such as __NA skips its search-param synchronization');
    target.location.search=new URL(String(url),'https://example.test').search;
  }}};
  replaceSearchQuery(target,{q:'阅读'});replaceSearchQuery(target,{type:'posts'});replaceSearchQuery(target,{city:'杭州'});
  replaceSearchQuery(target,{pages:3});assert.deepEqual(readSearchState(new URLSearchParams(target.location.search)),{q:'阅读',type:'posts',city:'杭州',pages:3});
  replaceSearchQuery(target,{q:'阅读教程'});assert.deepEqual(readSearchState(new URLSearchParams(target.location.search)),{q:'阅读教程',type:'posts',city:'杭州',pages:1});
});
test('return and reload re-fetch all saved pages, remove overlapping rows and keep current permissions',async()=>{
  const reads:string[]=[];const controller=new AbortController();
  const result=await loadSearchPages(state,async endpoint=>{
    const cursor=new URL(endpoint,'https://example.test').searchParams.get('cursor');reads.push(cursor||'first');
    if(!cursor)return {posts:[{id:'visible-1'},{id:'visible-2'}],nextCursor:'cursor / 2',communities:[],events:[]};
    if(cursor==='cursor / 2')return {posts:[{id:'visible-2'},{id:'visible-3'}],nextCursor:'cursor-3',communities:[],events:[]};
    return {posts:[{id:'visible-4'}],nextCursor:null,communities:[],events:[]};
  },controller.signal);
  assert.deepEqual(reads,['first','cursor / 2','cursor-3']);assert.equal(result.searchLoadedPages,3);
  assert.deepEqual(result.posts.map((post:{id:string})=>post.id),['visible-1','visible-2','visible-3','visible-4']);
  // No browser result cache is supplied on return; deleted/private old results
  // cannot be resurrected simply because the saved URL requested three pages.
  const reloaded=await loadSearchPages(state,async()=>({posts:[{id:'still-visible'}],nextCursor:null}),controller.signal);
  assert.deepEqual(reloaded.posts,[{id:'still-visible'}]);assert.equal(reloaded.searchLoadedPages,1);
});
test('load more appends just the next page while a manual refresh revalidates all loaded pages',async()=>{
  const previous={posts:[{id:'one'}],nextCursor:'next',searchLoadedPages:1};let calls=0;
  const appended=await loadSearchPages({...state,pages:2},async endpoint=>{calls++;assert.match(endpoint,/cursor=next$/);return {posts:[{id:'two'}],nextCursor:null};},new AbortController().signal,previous);
  assert.equal(calls,1);assert.deepEqual(appended.posts.map((post:{id:string})=>post.id),['one','two']);
  let first=true;
  const refreshed=await loadSearchPages({...state,pages:2},async endpoint=>{if(first){first=false;assert.equal(endpoint.includes('&cursor='),false);}return {posts:[{id:'new'}],nextCursor:null};},new AbortController().signal);
  assert.deepEqual(refreshed.posts,[{id:'new'}]);assert.deepEqual(previous.posts,[{id:'one'}]);
});
test('aborted requests and failed later pages cannot commit partial search results',async()=>{
  const controller=new AbortController();let calls=0;
  await assert.rejects(loadSearchPages(state,async()=>{calls++;controller.abort();return {posts:[{id:'old-user-private'}],nextCursor:'two'};},controller.signal),(error:Error)=>error.name==='AbortError');
  assert.equal(calls,1);
  calls=0;await assert.rejects(loadSearchPages(state,async()=>{if(++calls===1)return {posts:[{id:'one'}],nextCursor:'two'};throw new Error('network unavailable');},new AbortController().signal),/network unavailable/);
  assert.equal(calls,2);
});
test('scroll metadata is isolated to the exact search and viewer, expires and contains no result cache',()=>{
  const href=searchHref(state),saved={href,y:1534,viewer:'account-a',savedAt:1000};
  assert.deepEqual(readSearchPosition(saved,href,'account-a',1500),saved);
  assert.equal(readSearchPosition(saved,href,'account-b',1500),null);
  assert.equal(readSearchPosition(saved,searchHref({...state,city:'北京'}),'account-a',1500),null);
  assert.equal(readSearchPosition(saved,href,'account-a',1_801_001),null);
  for(const y of [-1,NaN,Infinity,1e20])assert.equal(readSearchPosition({...saved,y},href,'account-a',1500),null);
  assert.deepEqual(Object.keys(saved).sort(),['href','savedAt','viewer','y']);
});
