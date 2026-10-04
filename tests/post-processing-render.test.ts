import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

const cssHook = registerHooks({
  load(url, context, nextLoad) {
    if (url.endsWith('/post-processing.module.css')) {
      return { format: 'module', source: 'export default {}', shortCircuit: true };
    }
    return nextLoad(url, context);
  },
});
const { PostProcessing } = await import('../src/components/post-processing');
cssHook.deregister();

const media = [{ id: 'first', mime: 'image/png' }, { id: 'second', mime: 'image/jpeg' }];
const imageJobs = [
  { id: 'job-second', kind: 'image', target_id: 'second', status: 'failed' },
  { id: 'job-first', kind: 'image', target_id: 'first', status: 'pending', attempts: 1 },
];
function render(jobs = imageJobs, displayed = media, busy = false) {
  return renderToStaticMarkup(createElement(PostProcessing, { jobs, media: displayed, busy, onRetry: () => { throw new Error('Rendering must not retry'); } }));
}

test('multiple image tasks collapse into one optional section in displayed image order', () => {
  const html = render();
  assert.equal((html.match(/<details/g) || []).length, 1);
  assert.doesNotMatch(html, /<details[^>]*\bopen/);
  assert.match(html, /图片辅助解析（可选）· 2 项/);
  assert.match(html, /可选的 AI 文字提取和描述，不影响已展示的原图/);
  assert.ok(html.indexOf('图片 1：等待自动重试') < html.indexOf('图片 2：辅助解析未完成'));
  assert.match(html, /aria-label="重试图片 2"/);
  assert.doesNotMatch(html, /aria-label="重试图片 1"|可重试重试/);
  assert.equal((html.match(/<button/g) || []).length, 1);
});

test('missing images get no invented number and retained retries honor the busy state', () => {
  const html = render(imageJobs, [media[1]], true);
  assert.match(html, /图片 1：辅助解析未完成/);
  assert.match(html, /未展示的图片：等待自动重试/);
  assert.doesNotMatch(html, /图片 2/);
  assert.match(html, /disabled="" aria-label="重试图片 1"/);
});

test('link parsing labels and retry actions remain outside the collapsed image section', () => {
  const jobs = [...imageJobs, { id: 'link-job', kind: 'link', target_id: 'link', status: 'failed' }];
  const html = render(jobs);
  assert.ok(html.indexOf('</details>') < html.indexOf('链接解析：解析失败，可打开原链接或重试'));
  assert.match(html, /aria-label="重试链接解析"/);
  assert.equal(render([], []), '');
});
