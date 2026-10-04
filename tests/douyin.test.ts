import { test } from 'node:test';
import assert from 'node:assert/strict';
import { douyinPlayerUrl,getDouyinEmbed,isDouyinShortUrl,parseDouyinVideoId } from '../src/shared/douyin';
import { fetchDouyinEmbed } from '../src/server/douyin';

const id='7356906132482428172',otherId='7356906132482428173';
const api=`https://open.douyin.com/api/douyin/v1/video/get_iframe_by_video?video_id=${id}`;
const player=`https://open.douyin.com/player/video?vid=${id}&autoplay=0`;
const frame=`<iframe width="720" height="1280" frameborder="0" src="${player}" referrerpolicy="unsafe-url" allowfullscreen></iframe>`;
function payload(data:Record<string,unknown>={},extra:Record<string,unknown>={}) {
  return {err_no:0,data:{video_width:720,video_height:1280,video_title:'公开技术视频',iframe_code:frame,...data},...extra};
}
async function response(data:unknown,url=api) {
  return fetchDouyinEmbed(id,async()=>({url,headers:{},body:JSON.stringify(data)}));
}

test('documented video links and decimal IDs retain full precision',()=>{
  for(const value of [id,`https://www.douyin.com/video/${id}`,`https://www.douyin.com/video/${id}/?share=1`,
    `https://www.iesdouyin.com/share/video/${id}/?region=CN`,`https://www.douyin.com/?modal_id=${id}`,
    `https://www.douyin.com/video/${id}?modal_id=${id}`,`https://WWW.DOUYIN.COM/video/${id}`])assert.equal(parseDouyinVideoId(value),id,value);
  assert.equal(douyinPlayerUrl(id),player);
});

test('only exact trusted HTTPS hosts and video URL shapes can identify an embed',()=>{
  for(const value of [undefined,null,Number(id),'','0','01','-1','1e19','9'.repeat(33),
    `https://www.douyin.com/note/${id}`,`https://www.douyin.com/user/${id}?modal_id=${id}`,`https://www.douyin.com/video/${id}/details`,
    `https://douyin.com/video/${id}`,`https://www.douyin.com.evil.example/video/${id}`,`https://evil.example/?modal_id=${id}`,
    `https://user@www.douyin.com/video/${id}`,`https://www.douyin.com@evil.example/video/${id}`,`https://www.douyin.com:443/video/${id}`,
    `https://www.douyin.com:8443/video/${id}`,`http://www.douyin.com/video/${id}`,`//www.douyin.com/video/${id}`,
    `https://www.douyin.com\\@evil.example/video/${id}`,` https://www.douyin.com/video/${id}`,`https://www.douyin.com/video/${id}\n`,
    `https://www.douyin.com/?modal_id=${id}&modal_id=${otherId}`,`https://www.douyin.com/?modal_id=${id}&modal_id=${id}`,
    `https://www.douyin.com/video/${id}?modal_id=${otherId}`,`https://www.iesdouyin.com/video/${id}`,`https://v.douyin.com/${id}/`,
    `<script>video_id=${id}</script>`,`https://www.douyin.com/?modal_id=${id}%26autoplay%3D1`])assert.equal(parseDouyinVideoId(value),null,String(value));
  for(const value of [Number(id),`https://www.douyin.com/video/${id}`,`${id}&autoplay=1`])assert.equal(douyinPlayerUrl(value),null);
});

test('metadata validation rejects invalid dimensions and IDs and copies only typed fields',()=>{
  const embed={videoId:id,width:720,height:1280};
  assert.deepEqual(getDouyinEmbed({douyinEmbed:{...embed,src:'https://evil.example',iframe_code:'<script>bad</script>'}}),embed);
  for(const value of [null,[],{},{douyinEmbed:null},{douyinEmbed:[]},{douyinEmbed:JSON.stringify(embed)},
    {douyinEmbed:{...embed,videoId:Number(id)}},{douyinEmbed:{...embed,videoId:`${id}&autoplay=1`}},
    ...[0,-1,Infinity,NaN,1.5,'720',16385].map(width=>({douyinEmbed:{...embed,width}})),
    ...[0,-1,Infinity,NaN,1.5,'1280',16385].map(height=>({douyinEmbed:{...embed,height}}))])assert.equal(getDouyinEmbed(value),null);
});

test('only the trusted short-share host can resolve into a video ID',()=>{
  assert.equal(isDouyinShortUrl('https://v.douyin.com/Ab12_-Cd/'),true);
  for(const value of ['https://v.douyin.com/','https://other.douyin.com/Ab12/','https://v.douyin.com.evil.example/Ab12/',
    'http://v.douyin.com/Ab12/','https://v.douyin.com:443/Ab12/','https://user@v.douyin.com/Ab12/',
    'https://v.douyin.com/Ab12/extra',`https://www.douyin.com/video/${id}`])assert.equal(isDouyinShortUrl(value),false,value);
});

test('official provider uses one fixed endpoint and never returns raw HTML or iframe attributes',async()=>{
  let requested='';let size=0;
  const result=await fetchDouyinEmbed(id,async(url,limit)=>{requested=url;size=limit!;return {url,headers:{},body:JSON.stringify(payload())};});
  assert.equal(requested,api);assert.equal(size,64_000);
  assert.deepEqual(result,{embed:{videoId:id,width:720,height:1280},title:'公开技术视频'});
  assert.ok(!JSON.stringify(result).includes('iframe'));assert.ok(!JSON.stringify(result).includes('unsafe-url'));
  assert.deepEqual(await response(payload({iframe_code:frame.replace('&autoplay','&amp;autoplay')})),result);
  assert.deepEqual(await response(payload({iframe_code:`<iframe src='${player}' allowfullscreen></iframe>`})),result);
});

test('non-public, unknown error and malformed public payloads cannot generate a player',async()=>{
  for(const item of [{err_no:28003004,data:payload().data},{err_no:28001007},{err_no:'0',data:payload().data},null,[],{},
    payload({iframe_code:null}),payload({video_title:123}),payload({video_width:'720'}),payload({video_height:0})])assert.equal(await response(item),null);
  let fetched=false;assert.equal(await fetchDouyinEmbed('invalid',async()=>{fetched=true;throw new Error('must not fetch');}),null);assert.equal(fetched,false);
});

test('iframe code is accepted only as one unambiguous matching official player',async()=>{
  const sources=[`https://evil.example/player/video?vid=${id}`,`https://open.douyin.com.evil.example/player/video?vid=${id}`,
    `https://user@open.douyin.com/player/video?vid=${id}`,`https://open.douyin.com:443/player/video?vid=${id}`,
    `http://open.douyin.com/player/video?vid=${id}`,`https://open.douyin.com/player/video?vid=${otherId}`,
    `${player}&vid=${id}`,`${player}&autoplay=0`,`${player}&redirect=https://evil.example`,`${player}#fragment`,
    `https://open.douyin.com/player/other?vid=${id}`,`javascript:alert(1)`];
  const codes=[...sources.map(src=>`<iframe src="${src}"></iframe>`),`${frame}${frame}`,`<div>${frame}</div>`,
    `<iframe src="${player}" src="${player}"></iframe>`,`<iframe src="${player}" SRC="https://evil.example"></iframe>`,
    `<iframe data-src="${player}"></iframe>`,`<iframe src="${player}" onload="alert(1)"></iframe>`,
    `<iframe src="${player}" srcdoc="bad"></iframe>`,`<iframe src="${player}"><script>bad</script></iframe>`,
    `<iframe src="${player}"broken></iframe>`,`<iframe title='src="${player}"'></iframe>`];
  for(const code of codes)assert.equal(await response(payload({iframe_code:code})),null,code);
});

test('provider redirects must retain the exact trusted API request identity',async()=>{
  for(const url of [api.replace('open.douyin.com','evil.example'),api.replace('open.douyin.com','open.douyin.com.evil.example'),
    api.replace('open.douyin.com','user@open.douyin.com'),api.replace('open.douyin.com','open.douyin.com:443'),api.replace('https:','http:'),
    api.replace(id,otherId),`${api}&video_id=${id}`,`${api}&extra=true`,`${api}#fragment`,api.replace('get_iframe_by_video','other')])assert.equal(await response(payload(),url),null,url);
});

test('transient failures propagate to the durable job retry path without fabricating an embed',async()=>{
  await assert.rejects(response({err_no:28001005}),/暂时不可用/);
  await assert.rejects(fetchDouyinEmbed(id,async()=>{throw new Error('timeout');}),/timeout/);
  await assert.rejects(fetchDouyinEmbed(id,async()=>({url:api,headers:{},body:'not json'})),/有效数据/);
});
