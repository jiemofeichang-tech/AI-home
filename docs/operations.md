# 部署、备份与扩容

## 起步：约 100 人

网页、Worker、PostgreSQL、Redis、Meilisearch 可放在一台主机，媒体放在 OSS 私有桶。上传单图 10 MB、单帖最多 9 张；默认每人每天 20 张、全站每天 100 条短信、每月 1000 次图片处理，均可配置。

这些是请求数量控制，不是云账单金额保证。预算 500～2000 元/月应结合存储、流量、短信和模型账单监测。云账户另设费用预警；调整配置后重启服务。

生产要求 `DEV_MODE=false`、至少 32 字符认证密钥、正式 PostgreSQL / Redis / Meilisearch / OSS。用户数据与处理服务选择国内区域。站点部署和公开注册分开验收，先准备域名、HTTPS、适用备案和运营资料。

外部反向代理覆盖传入的真实 IP 请求头，不信任用户提供的 `X-Forwarded-For`。API 和 MCP 不缓存带认证的响应；代理限制上传体积，日志不记录授权头或 OAuth 回调查询参数。

`deploy/nginx.conf.example` 提供代理片段。Compose 将 AUTH_IP_HEADER 设置为 `x-real-ip`，必须由可信代理覆盖这个头；独立运行默认不信任请求提供的 IP 头，认证接口使用共享限流桶。

Compose 使用 `PGHOST / PGPORT / PGDATABASE / PGUSER / PGPASSWORD` 分开传入数据库连接参数，密码中的特殊字符不需要 URL 编码。独立运行 Node.js 时也可使用 `DATABASE_URL`（URI 中的密码必须编码）。切换独立数据库时设置 PGHOST 等配置；每个 Web / Worker 的连接池默认 10，可通过 DB_POOL_SIZE 调整。

## 健康与失败恢复

- `/api/v1/health` 检查数据库连通。
- `docker compose ps` 检查服务状态；`docker compose logs --tail 100 worker` 查看处理器错误。
- 管理页展示失败 / 阻塞任务及用量；用户已发布的正文不会因为处理失败而消失。
- 任务失败最多自动尝试 3 次；缺少图片模型密钥时标记 blocked，配置后由管理页重试。
- 任务记录留在 PostgreSQL。Worker 启动后恢复超过 5 分钟的旧 processing 任务；写回前检查原帖未删除。
- Meilisearch 不作为权限或唯一事实来源，搜索返回前始终读取数据库；索引不可用时回退 SQL。

## 备份与恢复

独立运行 Node.js 时，运行前加载目标环境变量：

```powershell
npm run backup
```

备份目录包含 `manifest.json`、逐行写出的 `tables/*.ndjson` 和独立的 `objects/*` 原图，每个文件都有 SHA-256 校验。默认写入 `backups/`，可用 BACKUP_DIR 更改；不会把全部图片放进一个巨大 JSON。Manifest 最后写出，未完成的备份不会被当作有效备份。备份包含账户、授权和私密内容，应放到受限目录并使用加密存储；认证密钥与云端凭据另行安全保管。

Compose 的 Worker 镜像有可写、持久化的 backup-data 卷，使用下面的命令，无需开放数据库端口：

```powershell
docker compose exec worker npm run backup
docker compose cp worker:/app/backups ./backups-export
```

迁移停机备份：先 `docker compose stop web worker`，再 `docker compose run --rm --no-deps worker npm run backup`，命令使用同一个持久卷。随后仍可从已有的已停止 Worker 容器执行 `docker compose cp worker:/app/backups ./backups-export` 导出。禁止运行 `docker compose down -v`，这会删除数据库和备份卷。

恢复流程：创建**新的空数据库**和新的存储目标 → 配置目标 `DATABASE_URL` / 存储变量 → 执行迁移 → 恢复。

```powershell
npm run db:migrate
npm run restore -- .\backups\community-日期
npm run search:rebuild
```

恢复工具校验所有表和对象，锁定目标表并按外键依赖顺序写入；如果目标已有业务数据，自动拒绝覆盖。对象迁移沿用相同 key，从本地存储转到 OSS 也不改变帖子引用。恢复前必须使用新的存储目录或新桶，保持网页与 Worker 停止；数据库写入失败会回滚，已写入的新桶对象保留，修正原因后可以重试。

Compose 恢复到另一套空数据库和新存储目标时，先配置新环境并运行 `docker compose up -d db redis search`、`docker compose run --rm migrate`；不要启动网页和 Worker。将备份目录放在本机 backups-import，再执行：

```powershell
docker compose run --rm --no-deps -v "${PWD}/backups-import:/restore:ro" worker npm run restore -- /restore/community-日期
docker compose run --rm --no-deps worker npm run search:rebuild
docker compose up -d web worker
```

## 迁移到正式服务器

1. 暂停旧实例写入和 Worker，生成一致备份，保留旧数据。
2. 新服务器部署相同代码版本，设置新数据库、对象存储及认证密钥。
3. 执行迁移、恢复、重建搜索；检查帖子、图片、私密内容、授权、活动与报名。
4. 若公开域名保持一致，保留原 `APP_URL` 与认证密钥。若更换域名，OAuth 客户端和用户需要按新 issuer / resource 重新连接。
5. 验证 HTTPS、短信与模型实际调用后切换域名流量。回退时恢复旧实例；不要把新旧实例同时指向不同可写数据源。

## 后续增加服务器

按瓶颈逐步扩展：

1. PostgreSQL、Redis、Meilisearch 独立部署；通过连接配置切换，网页保持业务代码不变。
2. 增加 Worker 实例，共享 PostgreSQL 和 Redis。SQL 原子领取任务，数据库唯一约束与事务控制业务幂等。
3. 多个网页实例共享同一数据库、认证密钥、Redis、搜索和对象存储，再通过负载均衡接入。不要使用各机器独立的本地上传目录。
4. 多实例部署移除 Compose 示例中固定的网页宿主机端口映射，由负载均衡连接容器端口；数据库迁移只运行一个实例。

先沿用同一个数据库，之后再按实际监控决定是否扩展数据库容量。活动报名由数据库活动行锁和唯一约束控制，增加网页实例不改变名额规则。
