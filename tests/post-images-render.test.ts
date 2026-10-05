import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

const cssHook = registerHooks({ load(url, context, nextLoad) {
  if (url.endsWith('/post-images.module.css')) return { format: 'module', source: 'export default {}', shortCircuit: true };
  return nextLoad(url, context);
} });
const { PostImages } = await import('../src/components/post-images');
cssHook.deregister();

test('post images preserve supplied order and dimensions without opening raw image links', () => {
  const html = renderToStaticMarkup(createElement(PostImages, { media: [
    { id: 'third', url: '/api/v1/media/third', mime: 'image/png', width: 500, height: 9000 },
    { id: 'first', url: '/api/v1/media/first', mime: 'image/jpeg', width: 800, height: 1200 },
  ] }));
  assert.ok(html.indexOf('src="/api/v1/media/third"') < html.indexOf('src="/api/v1/media/first"'));
  assert.match(html, /width="500" height="9000"/);
  assert.match(html, /aria-label="查看第 1 张图片，共 2 张"/);
  assert.match(html, /aria-label="查看第 2 张图片，共 2 张"/);
  assert.doesNotMatch(html, /<a\b|target=|<dialog/);
});

test('videos and unsupported attachments never enter the image sequence', () => {
  const html = renderToStaticMarkup(createElement(PostImages, { media: [
    { id: 'video', url: '/video', mime: 'video/mp4' },
    { id: 'image', url: '/image', mime: 'image/webp' },
    { id: 'pdf', url: '/pdf', mime: 'application/pdf' },
  ] }));
  assert.match(html, /查看第 1 张图片，共 1 张/);
  assert.doesNotMatch(html, /src="\/video"|src="\/pdf"/);
  assert.equal(renderToStaticMarkup(createElement(PostImages, { media: [] })), '');
});
