import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

const cssHook = registerHooks({
  load(url, context, nextLoad) {
    if (url.endsWith('/douyin-embed.module.css')) {
      return { format: 'module', source: 'export default {}', shortCircuit: true };
    }
    return nextLoad(url, context);
  },
});
const { DouyinEmbed } = await import('../src/components/douyin-embed');
cssHook.deregister();

const videoId = '7356906132482428172';
const url = `https://www.douyin.com/video/${videoId}`;
function render(metadata: unknown, originalUrl = url) {
  return renderToStaticMarkup(createElement(DouyinEmbed, {
    metadata, url: originalUrl, title: '抖音技术分享',
    children: createElement('a', { href: originalUrl }, '原链接卡片'),
  }));
}

test('approved embed metadata offers playback without loading a third-party frame before a click', () => {
  const shortUrl = 'https://v.douyin.com/test-share/';
  const html = render({ douyinEmbed: { videoId, width: 720, height: 1280 } }, shortUrl);
  assert.match(html, /播放抖音视频/);
  assert.match(html, /aria-expanded="false"/);
  assert.match(html, /在抖音打开/);
  assert.match(html, /href="https:\/\/v\.douyin\.com\/test-share\/"/);
  assert.doesNotMatch(html, /<iframe|open\.douyin\.com\/player|原链接卡片/);
});

test('a video URL alone cannot bypass missing or withheld derived metadata', () => {
  for (const metadata of [undefined, null, {}, { resolvedUrl: url }, { douyinEmbed: null }]) {
    const html = render(metadata);
    assert.match(html, /原链接卡片/);
    assert.doesNotMatch(html, /播放抖音视频|<iframe/);
  }
});

test('invalid embed dimensions, IDs, and arbitrary iframe HTML fall back to the original card', () => {
  for (const douyinEmbed of [
    { videoId: 'https://attacker.invalid/player', width: 720, height: 1280 },
    { videoId, width: 0, height: 1280 },
    { videoId, width: 720, height: -1 },
    { videoId, width: '720', height: 1280 },
  ]) {
    const html = render({ douyinEmbed, iframe_code: '<iframe src="https://attacker.invalid"></iframe>' });
    assert.match(html, /原链接卡片/);
    assert.doesNotMatch(html, /播放抖音视频|<iframe|attacker\.invalid/);
  }
});
