# 抖音视频嵌入

发布帖子时粘贴抖音视频链接或包含链接的分享文案。Worker 解析视频 ID，并向抖音官方 `get_iframe_by_video` 接口确认嵌入信息。预览审核通过后，帖子出现“播放抖音视频”按钮；点击才加载 iframe，默认不自动播放，支持收起，始终保留“在抖音打开”。

官方接口文档：[通过 VideoID 获取 IFrame 代码](https://partner.open-douyin.com/docs/resource/zh-CN/dop/develop/openapi/video-management/douyin/iframe-player/get-iframe-by-video)。文档注明无需申请接口权限。视频状态、平台可用性和访问网络仍可能影响实际播放；iframe 的 `load` 事件不代表视频播放成功。

## 解析与展示边界

- 数字视频 ID 始终作为字符串处理，避免 JavaScript 大整数精度丢失。
- 短链接复用 `safeFetch` 的逐跳 DNS / IP 校验、响应体大小及超时限制；不执行来源网页的 JavaScript。
- 仅识别明确的官方视频地址，从固定官方 API 获取元信息，验证返回播放器地址和视频 ID 一致。
- 不保存或执行接口返回的原始 HTML。`metadata.douyinEmbed` 只存视频 ID、宽、高；前端再次验证字段并构造固定官方播放器 URL。
- 请求暂时失败沿用任务重试机制；不支持嵌入或非公开视频保持普通链接卡片。原帖不会因可选解析失败而重新进入审核。
- 视频媒体直接从抖音加载，不经社区服务器下载、转码或转发。

## 审核与旧帖子

播放器元信息沿用独立派生内容审核。原帖未公开，或预览未审核通过时，公共 API 不返回播放器元信息。隐藏、删除、私密社群等规则继续由原帖访问权限决定。

当前审核检查帖子、链接、标题和结构化元信息，不等同于检查外部视频的全部画面或音频。

已由管理员定稿的原帖或预览保持原决定，普通重试不会覆盖它们。因此这类旧链接不会自动补出播放器，也不应通过批量清除人工审核记录进行回填。

## 验证与发布

没有新增依赖或数据库迁移。功能需要同时更新 Web 与 Worker；仅更新前端不会给新链接产生播放器元信息。

```sh
node --import tsx --test tests/douyin.test.ts tests/douyin-integration.test.ts
npm run typecheck
npm run build -- --webpack
```

集成测试使用独立 PostgreSQL 测试库，覆盖预览审核前后的公开数据、短链、非公开视频、人工审核与网络响应的竞态，以及管理员隐藏和删除后的访问控制。真实播放验收还需要实际公开视频及能访问抖音播放器的浏览器网络。
