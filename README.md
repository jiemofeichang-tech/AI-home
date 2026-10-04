# AI 社区

为约 100 人的 AI 社群提供图文与链接分享、同城社群、线下活动，以及共享权限的 API、CLI、MCP。支持电脑和手机网页。

## 本地启动

需要 Node.js 22.12+。已在 Windows / Node.js 24 和 macOS 26.6.2（Apple Silicon）/ Node.js 24.21.0 验证本地启动。macOS 终端（zsh / bash）与 Windows PowerShell 使用相同命令：

```sh
npm ci
npm run dev:local
```

打开 **http://localhost:3100**。本地入口自动启动 PostgreSQL 协议兼容的 PGlite 数据库、任务处理器和网页。数据保存在忽略提交的 `.local/` 中，重启后仍保留。它只绑定本机地址，不用于公开运营。

本地预览无需额外安装 PostgreSQL、Redis 或 Docker，也无需填写生产 `.env`。启动前确保 `3100` 和 `54329` 端口空闲；在终端按 `Ctrl+C` 停止。若 macOS 的终端已设置 `NODE_ENV=production`，使用 `NODE_ENV=development npm run dev:local` 启动。

演示管理员手机号：`13800000001`。本地登录页显示开发验证码，不发送真实短信。初始帖子和活动明确标为演示数据。真实生产环境拒绝启用 `DEV_MODE`。

## 已实现

- 动态、图文、[视频上传](docs/video-upload.md)、GitHub / 小红书 / 抖音 / 网页链接、评论、点赞、收藏、转发、关注、屏蔽、个人资料。
- 按城市建立公开或私密社群，申请审批、公告、社群讨论。
- 免费活动发布、名额限制、姓名和手机号预约及取消、管理员签到、活动回顾；预约成功后才返回详细地址，报名姓名和手机号仅活动所属社群的管理员可查看，不公开。
- 图片上传、独立 OCR / 描述字段及异步处理；外链状态、错误和重试；GitHub 官方 API 获取公开 README 和仓库信息。
- 内容、图片提取文字、README、社群和活动的中文搜索。Meilisearch 返回候选 ID，最终内容由数据库按实时权限读取；索引不可用时回退数据库查询。
- 手机验证码账户、站内通知、举报处置、封禁和处理任务管理。
- 内容先审后发、阿里云文本 / 图片审核适配、自动隔离、真人复核和作者申诉；缺少云配置时保留人工待审。资料、社群和活动修改使用审核草稿。
- 可过期和撤销的 Agent 授权、社群范围、代发标记、审计记录；OAuth 2.1 + PKCE。
- API、CLI、远程 MCP、stdio MCP；所有操作调用同一个业务服务。
- Docker 单机部署、独立 Worker、数据库迁移、备份恢复及对象存储迁移。

抖音公开视频支持[帖子内嵌入播放](docs/douyin-embed.md)：官方接口确认可嵌入且预览审核通过后，点击加载抖音播放器，并保留原链接。视频由抖音提供，不上传或下载外部视频。不保证小红书、抖音任意页面全文可读：链接仍可发布，解析失败显示状态，不绕过登录和访问限制。普通网页仅提取公开元信息；GitHub 读取公开仓库，不执行源码。

## 验证

```powershell
npm run typecheck
npm test
npm run build
npm run build:tools
```

测试自动在 `127.0.0.1:54331` 启动独立的 **原生 PostgreSQL 17**，在 `127.0.0.1:3199` 启动测试 API，建立 100 个测试账户。不会操作本地预览库或云端数据。测试结束关闭进程，数据库留在 `.local/test-*` 便于检查。

测试覆盖私密帖子 / 公告 / 附件、撤权、社群范围、转发原帖删除、幂等请求、并发报名、签到、搜索权限、SSRF、HTTP 和 stdio MCP、CLI、OAuth，以及完整数据和文件的恢复。负载与恢复结果在 `test-results/`。

## 生产接入

复制 `.env.example` 为 `.env`，填写数据库、认证随机密钥、OSS 私有桶、短信签名和模板、百炼 API Key、管理员手机号等。不要提交 `.env`。`ADMIN_PHONE` 使用 `+86` 国际格式。

个人内测可使用阿里云号码认证的“短信认证”：设置 `SMS_PROVIDER=aliyun-pnvs`，填写其赠送签名、赠送模板和短信专用 AccessKey。原企业短信接入使用 `aliyun-sms`；未设置该变量时保留原接口。具体入口、配置和验收步骤见[个人短信接入](docs/sms-setup.md)。

```powershell
docker compose build
docker compose up -d
docker compose ps
```

Compose 先执行迁移，再启动网页和 Worker。PostgreSQL、Redis 和 Meilisearch 不暴露宿主机端口；网页默认仅映射 `127.0.0.1:3100`，由 HTTPS 反向代理对外提供访问。

真实短信、OSS、图片理解和公网部署必须用运营方凭据联调；没有配置时，不能把本地验证码、模拟模型测试或本地存储当作真实服务验收。

## 文档

- [邀请码小规模内测](docs/invite-beta.md)
- [个人短信接入](docs/sms-setup.md)
- [隐私保护与资料处理](docs/privacy.md)
- [内容审核与内测运营](docs/moderation.md)
- [API / CLI / MCP 接入](docs/agent-access.md)
- [部署、备份、迁移和扩容](docs/operations.md)
- [2 核 2 GiB 内测服务器部署](docs/deploy-small.md)
- [验收与已知限制](docs/verification.md)
- 运行时 OpenAPI：`/api/v1/openapi.json`

## 代码结构

`src/server/service.ts` 是共享业务入口，`permissions.ts` 负责当前权限，`http.ts` 负责 HTTP 映射。CLI 和 MCP 不另写一套权限逻辑。所有长任务通过数据库任务记录进入独立 Worker，生产由 Redis / BullMQ 分发。

文件读取经过鉴权接口代理，私密对象不返回可绕过撤权的公开地址。授权和社群成员关系每次重新检查。数据库只保存对象 key，不保存个人电脑绝对路径。
