import assert from 'node:assert/strict';
import { test } from 'node:test';
import { linkPreviewLabel, parsingJobLabel, shouldPollParsing, shouldClearPageOnError } from '../src/shared/parsing-progress';

test('expired sessions, lost access and removed content clear cached pages while transient failures preserve them', () => {
  for (const status of [401, 403, 404]) assert.equal(shouldClearPageOnError(status), true);
  for (const status of [undefined, 429, 500, 502, 503, 504]) assert.equal(shouldClearPageOnError(status), false);
});

test('first queueing, delayed retries, processing and terminal failures have distinct labels', () => {
  assert.equal(parsingJobLabel({ kind: 'link', status: 'pending', attempts: 0 }), '排队中');
  for (const attempts of [1, 2]) assert.equal(parsingJobLabel({ kind: 'link', status: 'pending', attempts }), `等待自动重试（已尝试 ${attempts} 次）`);
  assert.equal(parsingJobLabel({ kind: 'link', status: 'processing', attempts: 2 }), '处理中');
  assert.equal(parsingJobLabel({ kind: 'link', status: 'failed', attempts: 3 }), '解析失败，可打开原链接或重试');
  assert.equal(parsingJobLabel({ kind: 'link', status: 'blocked' }), '解析暂不可用，可打开原链接或重试');
  assert.equal(parsingJobLabel({ kind: 'image', status: 'failed' }), '处理失败，可重试');
});

test('each link matches its own parsing job, including a failed resource awaiting automatic retry', () => {
  const jobs = [
    { kind: 'link', target_id: 'other', status: 'failed', attempts: 3 },
    { kind: 'image', target_id: 'current', status: 'processing' },
    { kind: 'link', target_id: 'current', status: 'pending', attempts: 2 },
  ];
  assert.equal(linkPreviewLabel({ id: 'current', status: 'failed' }, jobs), '等待自动重试（已尝试 2 次）');
  assert.equal(linkPreviewLabel({ id: 'other', status: 'pending' }, jobs), '解析失败，可打开原链接或重试');
  assert.equal(linkPreviewLabel({ id: 'unmatched', status: 'pending' }, jobs), '暂未获取详情，可打开原链接');
  assert.equal(linkPreviewLabel({}, [{ kind: 'link', status: 'pending' }]), '暂未获取详情，可打开原链接');
});

test('missing or finished jobs never promise endless parsing or fabricate a saved preview', () => {
  for (const status of ['pending', 'partial', 'failed', 'ready']) {
    assert.equal(linkPreviewLabel({ id: 'link', status }), '暂未获取详情，可打开原链接');
    assert.equal(linkPreviewLabel({ id: 'link', status }, [{ kind: 'link', target_id: 'link', status: 'done' }]), '暂未获取详情，可打开原链接');
  }
  assert.equal(linkPreviewLabel({ id: 'link', title: '已有预览', status: 'partial' }), '已保存链接预览');
});

const owned = { author_id: 'me', processing: [{ kind: 'link', target_id: 'link', status: 'pending', attempts: 1 }] };
const context = { userId: 'me', visible: true, inFlight: false };

test('current feed, search/profile/community list and post-detail shapes can trigger polling', () => {
  for (const page of [{ items: [owned] }, { posts: [owned] }, { post: owned }]) {
    assert.equal(shouldPollParsing({ ...context, page }), true);
  }
  assert.equal(shouldPollParsing({ ...context, page: { post: { ...owned, processing: [{ kind: 'image', status: 'processing' }] } } }), true);
});

test('polling pauses when hidden or busy and never follows another account or unrelated jobs', () => {
  const page = { items: [owned] };
  assert.equal(shouldPollParsing({ ...context, page, visible: false }), false);
  assert.equal(shouldPollParsing({ ...context, page, inFlight: true }), false);
  assert.equal(shouldPollParsing({ ...context, page, userId: undefined }), false);
  assert.equal(shouldPollParsing({ ...context, page, userId: 'another-account' }), false);
  assert.equal(shouldPollParsing({ ...context, page: {} }), false);
  assert.equal(shouldPollParsing({ ...context, page: { post: { ...owned, processing: [{ kind: 'moderation', status: 'pending' }] } } }), false);
});

test('polling stops after completion or terminal failure, independent of resource status', () => {
  for (const status of ['done', 'failed', 'blocked']) {
    assert.equal(shouldPollParsing({ ...context, page: { post: { ...owned, processing: [{ kind: 'link', status }] } } }), false);
  }
  assert.equal(shouldPollParsing({ ...context, page: { post: { author_id: 'me' } } }), false);
});

test('a quoted original belonging to this user triggers polling only within the eight-level API boundary', () => {
  type Post = NonNullable<Parameters<typeof shouldPollParsing>[0]['page']['post']>;
  let post: Post = owned;
  for (let depth = 0; depth < 8; depth++) post = { author_id: 'another-user', original: post };
  assert.equal(shouldPollParsing({ ...context, page: { post } }), true);
  assert.equal(shouldPollParsing({ ...context, page: { post: { author_id: 'another-user', original: post } } }), false);
});
