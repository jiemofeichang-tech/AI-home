import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loginReturnPath,loginUrl,requiresPostLogin } from '../src/shared/login-navigation';

test('pages with a post feed or post detail require login, including the explicit home route',()=>{
  for(const path of ['/','/home','/home/','/posts','/posts/post-123','/posts/post-123/','/discover','/profile','/profile/member_123','/communities/community-123','/communities/community-123/']) {
    assert.equal(requiresPostLogin(path),true,path);
  }
});

test('login, privacy, community directory and event pages remain publicly reachable',()=>{
  for(const path of ['/login','/login/','/consent','/privacy','/communities','/communities/','/events','/events/event-123','/events/event-123/']) {
    assert.equal(requiresPostLogin(path),false,path);
  }
});

test('valid internal destinations preserve the original post and privacy settings paths',()=>{
  for(const path of ['/','/posts/post-123','/posts/550e8400-e29b-41d4-a716-446655440000','/posts/post_123/','/privacy-settings','/profile/member-123','/communities/community-123','/events/event-123']) {
    assert.equal(loginReturnPath(path),path,path);
  }
  for(const value of [undefined,null,''])assert.equal(loginReturnPath(value),'/');
});

test('return destinations preserve search filters, pagination and the reader fragment',()=>{
  const input='/discover?q=Agent&type=github&city=北京&pages=2#results';
  const expected=`/discover?q=Agent&type=github&city=${encodeURIComponent('北京')}&pages=2#results`;
  assert.equal(loginReturnPath(input),expected);
  const destination=new URL(loginReturnPath(input),'https://community.example');
  assert.equal(destination.origin,'https://community.example');assert.equal(destination.pathname,'/discover');
  assert.deepEqual([...destination.searchParams],[['q','Agent'],['type','github'],['city','北京'],['pages','2']]);
  assert.equal(destination.hash,'#results');
  assert.equal(loginReturnPath('/posts/post-123#image-2'),'/posts/post-123#image-2');
});

test('nested post return context survives login without becoming the outer redirect destination',()=>{
  const search=`/discover?q=Agent&type=github&city=${encodeURIComponent('北京')}&pages=2`;
  for(const context of [search,'https://evil.example/posts/1','//evil.example']) {
    const post=`/posts/post-123?returnTo=${encodeURIComponent(context)}#image-2`;
    assert.equal(loginReturnPath(post),post);
    const login=new URL(loginUrl(post),'https://community.example');
    assert.equal(login.origin,'https://community.example');assert.equal(login.pathname,'/login');
    assert.deepEqual([...login.searchParams],[['returnTo',post]]);
    const destination=new URL(login.searchParams.get('returnTo')!,'https://community.example');
    assert.equal(destination.origin,'https://community.example');assert.equal(destination.pathname,'/posts/post-123');
    assert.equal(destination.searchParams.get('returnTo'),context);assert.equal(destination.hash,'#image-2');
  }
  const externalQuery='/posts/post-123?returnTo=https://evil.example';
  assert.equal(loginReturnPath(externalQuery),externalQuery);
  assert.equal(new URL(loginReturnPath(externalQuery),'https://community.example').origin,'https://community.example');
});

test('return paths reject external URLs, backslashes, control characters and encoded path separators',()=>{
  const unsafe=[
    'https://evil.example/posts/1','http://localhost:3100/posts/1','javascript:alert(1)',
    '//evil.example/posts/1','///evil.example/posts/1','posts/post-123','../posts/post-123',
    '\\evil.example','/\\evil.example','/posts\\post-123',
    '/\u0000evil.example','/\tevil.example','/\nevil.example','/\revil.example','/posts/post-123\u007f',
    '/%2Fevil.example','/%2fevil.example','/%2F%2Fevil.example','%2F%2Fevil.example',
    '/posts%2Fpost-123','/posts/%5Cevil.example','/%252F%252Fevil.example',
    '/posts/../login','/posts//post-123',
  ];
  for(const path of unsafe)assert.equal(loginReturnPath(path),'/',JSON.stringify(path));
});

test('login and consent destinations fall back home without blocking distinct route names',()=>{
  for(const path of ['/login','/login/','/login/verify','/login?foo=bar','/login?returnTo=%2Fposts%2Fpost-123#continue','/consent','/consent/','/consent/confirm','/consent?foo=bar#confirm']) {
    assert.equal(loginReturnPath(path),'/',path);
  }
  for(const path of ['/login-help','/consent-records'])assert.equal(loginReturnPath(path),path,path);
});

test('login URLs carry one encoded safe return destination and unsafe input falls back home',()=>{
  assert.equal(loginUrl('/posts/post-123'),'/login?returnTo=%2Fposts%2Fpost-123');
  assert.equal(loginUrl('/privacy-settings'),'/login?returnTo=%2Fprivacy-settings');
  for(const path of ['/posts/post-123','/privacy-settings','//evil.example','/login','/consent']) {
    const url=new URL(loginUrl(path),'https://community.example');
    assert.equal(url.origin,'https://community.example');assert.equal(url.pathname,'/login');
    assert.deepEqual([...url.searchParams],[['returnTo',loginReturnPath(path)]]);
  }
});
