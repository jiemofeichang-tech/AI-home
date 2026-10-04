import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

const cssHook = registerHooks({
  load(url, context, nextLoad) {
    if (url.endsWith('/uploaded-video.module.css')) {
      return { format: 'module', source: 'export default {}', shortCircuit: true };
    }
    return nextLoad(url, context);
  },
});
const { UploadedVideo } = await import('../src/components/uploaded-video');
cssHook.deregister();

test('uploaded videos use native controls without autoplay or an iframe', () => {
  const html = renderToStaticMarkup(createElement(UploadedVideo, {
    src: '/api/v1/media/video-id', mime: 'video/mp4', label: '帖子视频',
  }));
  assert.match(html, /<video[^>]*src="\/api\/v1\/media\/video-id"/);
  assert.match(html, /controls=""/);
  assert.match(html, /playsInline=""/);
  assert.match(html, /preload="metadata"/);
  assert.match(html, /aria-label="帖子视频"/);
  assert.match(html, /href="\/api\/v1\/media\/video-id"/);
  assert.doesNotMatch(html, /autoplay|autoPlay|<iframe|<img/);
});

test('moderation video playback and its fallback link keep the authenticated preview route', () => {
  const html = renderToStaticMarkup(createElement(UploadedVideo, {
    src: '/api/v1/moderation/media/video-id', mime: 'video/webm', label: '提交的视频',
  }));
  assert.match(html, /src="\/api\/v1\/moderation\/media\/video-id"/);
  assert.match(html, /href="\/api\/v1\/moderation\/media\/video-id"/);
  assert.match(html, /打开视频文件/);
  assert.doesNotMatch(html, /暂时无法播放/);
});

test('unsupported media types never mount a video player', () => {
  for (const mime of ['image/jpeg', 'text/html', 'video/quicktime', '']) {
    assert.equal(renderToStaticMarkup(createElement(UploadedVideo, { src: '/api/v1/media/id', mime })), '');
  }
});
