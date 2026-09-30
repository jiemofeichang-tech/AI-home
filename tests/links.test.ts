import test from 'node:test';
import assert from 'node:assert/strict';
import { extractWebUrls } from '../src/shared/links';

test('extracts a Douyin link from a complete pasted share message',()=>{
  const text='3.68 复制打开抖音，看看【AI 社群的作品】一起学习 AI！ https://v.douyin.com/tLxBk-Pyz3w/ 复制此链接，打开 Dou音搜索，直接观看视频！';
  assert.deepEqual(extractWebUrls(text),['https://v.douyin.com/tLxBk-Pyz3w/']);
});

test('extracts Xiaohongshu shares and keeps query parameters',()=>{
  const text='发现一个好用的 AI 工具 http://xhslink.com/a/AbC123，复制本条信息，打开【小红书】App查看精彩内容！\n完整链接：https://www.xiaohongshu.com/explore/abc?xsec_token=abc%2Bdef%3D&xsec_source=pc_share';
  assert.deepEqual(extractWebUrls(text),[
    'http://xhslink.com/a/AbC123',
    'https://www.xiaohongshu.com/explore/abc?xsec_token=abc%2Bdef%3D&xsec_source=pc_share'
  ]);
});

test('keeps link order, accepts uppercase schemes, deduplicates and does not limit the count',()=>{
  const links=Array.from({length:7},(_,index)=>`https://example.com/post/${index}`);
  const input=`HTTPS://EXAMPLE.COM/post/0\n${links.join(' ')}\n再次分享 ${links[2]}`;
  assert.deepEqual(extractWebUrls(input),['HTTPS://EXAMPLE.COM/post/0',...links.slice(1)]);
});

test('removes trailing Chinese and English punctuation and surrounding quotes',()=>{
  const endings=['。','，','！','？','；','：','、','…','.',',','!','?',';',':','...'];
  for(const ending of endings)assert.deepEqual(extractWebUrls(`链接 https://example.com/path${ending}`),['https://example.com/path'],ending);
  for(const [open,close] of [['"','"'],["'","'"],['“','”'],['‘','’'],['「','」'],['『','』'],['<','>']]) {
    assert.deepEqual(extractWebUrls(`${open}https://example.com/path${close}`),['https://example.com/path']);
  }
});

test('removes wrapper brackets while preserving balanced URL parentheses and IPv6 hosts',()=>{
  assert.deepEqual(extractWebUrls('(https://en.wikipedia.org/wiki/AI_(disambiguation)).'),['https://en.wikipedia.org/wiki/AI_(disambiguation)']);
  assert.deepEqual(extractWebUrls('（https://example.com/活动（杭州））'),['https://example.com/活动（杭州）']);
  assert.deepEqual(extractWebUrls('[https://example.com/a[b]] {https://example.com/a{b}} 【https://example.com/活动】'),[
    'https://example.com/a[b]','https://example.com/a{b}','https://example.com/活动'
  ]);
  assert.deepEqual(extractWebUrls('(https://example.com/path)后续文案'),['https://example.com/path']);
  assert.deepEqual(extractWebUrls('http://[::1]:3100/path'),['http://[::1]:3100/path']);
});

test('preserves paths, Chinese text, encoded characters, queries and hashes',()=>{
  const urls=[
    'https://example.com/中文路径?q=杭州&redirect=https%3A%2F%2Fexample.org%2Fa%3Fb%3D1#活动详情',
    'https://example.com/a%28b%29?name=%E6%9D%AD%E5%B7%9E&value=a+b%2Fc#part%21',
    'https://example.com/a_b-1/~user?q=(a+b)&arr=[x]#part(2)'
  ];
  assert.deepEqual(extractWebUrls(urls.join('\n')),urls);
});

test('preserves apostrophes inside paths and queries while removing surrounding quotes',()=>{
  const urls=[
    "https://en.wikipedia.org/wiki/Schrödinger's_cat",
    "https://example.com/search?q=don't&lang=en"
  ];
  assert.deepEqual(extractWebUrls(urls.join('\n')),urls);
  assert.deepEqual(extractWebUrls(urls.map(url=>`'${url}'`).join('\n')),urls);
});

test('ignores invalid URLs and non-web protocols without preventing later valid links',()=>{
  const input='ftp://example.com/file mailto:hello@example.com javascript:alert(1) data:text/plain,hello //example.com https:// https:///path https://?query=x https://[broken] https://example.com:99999 https://bad%host/path ftp://https://nested.example.com https://example.com\\path\nhttps://valid.example.com/path';
  assert.deepEqual(extractWebUrls(input),['https://valid.example.com/path']);
  assert.deepEqual(extractWebUrls('只有文案，没有链接 www.example.com'),[]);
});
