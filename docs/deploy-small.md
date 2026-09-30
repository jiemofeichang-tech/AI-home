# 2 核 2 GiB 单机内测部署

`deploy/compose.small.yaml` 是现有 `compose.yaml` 的覆盖文件，面向 Linux amd64 小规模内测。保留网页、Worker、PostgreSQL、Redis、Meilisearch、OSS 和全部生产校验。它是资源预算起点，尚不代表在 2 GiB 主机上完成负载测试，也不保证可承载的人数。

尚未准备 HTTPS 或真实云服务配置时，先准备服务器、Docker 和发布镜像。按 [部署说明](operations.md)、[短信配置](sms-setup.md) 填写真实配置后，可以先启动仅监听本机的生产服务；对外访问前必须完成可信 HTTPS 入口。没有域名时，可以使用下文的公网 IP 证书方案，`APP_URL` 与实际 HTTPS 地址保持一致。开发验证码、演示账号和 `DEV_MODE=true` 不用于公网。

## 资源预算

| 服务 | 容器内存上限 | 主要限制 |
| --- | ---: | --- |
| Web | 512 MiB | Node 旧生代堆 256 MiB；数据库池 3；同时处理 1 次图片上传；单图 1200 万像素；动画最多 60 帧、总计 1200 万像素 |
| Worker | 384 MiB | Node 旧生代堆 192 MiB；数据库池 3；任务并发 1 |
| PostgreSQL | 256 MiB | 共享缓存 64 MB；最多 20 个连接；每次排序等操作的 `work_mem` 2 MB；维护内存 32 MB；关闭并行查询 |
| Redis | 96 MiB | 数据内存 32 MB；AOF 持久化；`noeviction`，不丢弃队列条目 |
| Meilisearch | 256 MiB | 索引预算 64 MiB、索引线程 1 |
| 迁移（临时） | 384 MiB | Node 旧生代堆 256 MiB；数据库池 3；Web/Worker 停止时执行 |

五个常驻服务的上限合计 1504 MiB，名义 2 GiB 主机剩余 544 MiB 用于系统、Docker、Nginx 等；实际可用内存需看服务器。内存上限不是预留量，也不是不会 OOM 的保证；Node 堆限制不覆盖图片原生内存，Meilisearch 索引预算不覆盖全部搜索进程内存。碰到 OOM、队列持续积压或明显延迟，先停止放量并检查资源，不靠反复重启掩盖问题。

上传处理达到并发上限时会返回繁忙提示；像素或动画超过限制时需要用户缩小图片。不要只降低每日上传数量来控制瞬时内存。Redis 达到数据上限会拒绝写入，应检查队列和内存后处理，不改成自动淘汰任务。

每个容器使用 Docker `local` 日志驱动，单文件 10 MB、最多 3 个文件。它不负责轮转宿主机 Nginx、系统日志，也不清理数据库和备份。

## 在构建机准备 amd64 镜像

先检查构建机有可用的 Docker Engine 和 Buildx；没有时优先用另一台构建机或 CI，不假定开发电脑已安装。已有业务运行时，不在 2 GiB 服务器上执行 Next.js 构建。首次部署的空机可以在确认磁盘余量、配置受限权限的交换文件后顺序构建，完成后检查退出码、内存和镜像架构；交换空间不能代替正常运行所需的内存。以下命令在项目根目录运行，构建两个目标，不能直接打包 macOS 的 `node_modules` 或 `.next`：

```sh
docker version
docker buildx version
release_tag=$(date -u +%Y%m%dT%H%M%SZ)
docker buildx build --platform linux/amd64 --target app --load -t "ai-community-web:$release_tag" .
docker buildx build --platform linux/amd64 --target jobs --load -t "ai-community-jobs:$release_tag" .
docker image inspect "ai-community-web:$release_tag" "ai-community-jobs:$release_tag" --format '{{.RepoTags}} {{.Os}}/{{.Architecture}}'
docker save -o "/tmp/ai-community-$release_tag.tar" "ai-community-web:$release_tag" "ai-community-jobs:$release_tag"
```

两张镜像必须输出 `linux/amd64`。镜像归档放在项目目录外，避免被下一次构建再次复制。通过已授权的 SSH 传输或可信私有镜像仓库发布；`web` 和 `jobs` 应来自同一次代码快照。保留上一个版本的镜像与配置用于回退。

## 合并检查与启动

服务器需要 Docker Engine、Compose v2，检查命令为 `docker version` 和 `docker compose version`。将项目部署文件放在同一项目目录，保留 `compose.yaml` 作为第一个 `-f` 参数。所有配置路径以它所在的目录为基准。

真实生产配置存入权限为 `600` 的 `.env.production`，不提交仓库、不贴到日志或聊天中。现有必填项仍由基础配置校验；小机覆盖文件不会填入占位密钥。按实际镜像发布标签，在该文件中增加以下两个**镜像引用**（替换日期标签）：

```dotenv
COMMUNITY_WEB_IMAGE=ai-community-web:20260930T120000Z
COMMUNITY_JOBS_IMAGE=ai-community-jobs:20260930T120000Z
```

导入匹配的镜像归档；如果选择镜像仓库，则改用该仓库的完整镜像引用并拉取。以下命令在服务器项目根目录运行：

```sh
docker load -i /path/to/ai-community-release.tar
dc() { docker compose --env-file .env.production -f compose.yaml -f deploy/compose.small.yaml "$@"; }
dc config --quiet
dc config --services
dc config --images
```

`config --quiet` 只检查解析与必填配置，不验证凭据有效性、镜像架构或云服务连通。不要把完整的 `docker compose config` 输出到共享日志，其中包含解析后的密钥。需要检查合并后的资源与端口时，可在安装了 Python 3 的服务器使用下面的字段白名单，输出不会包含环境密钥：

```sh
dc config --format json | python3 -c '
import json, sys
services = json.load(sys.stdin)["services"]
keys = ("DB_POOL_SIZE", "WORKER_CONCURRENCY", "IMAGE_UPLOAD_CONCURRENCY", "IMAGE_MAX_PIXELS", "IMAGE_MAX_ANIMATION_FRAMES", "IMAGE_MAX_ANIMATION_PIXELS", "MEILI_MAX_INDEXING_MEMORY", "MEILI_MAX_INDEXING_THREADS")
for name, service in services.items():
    env = service.get("environment", {})
    print(name, "memory=", service.get("mem_limit"), "platform=", service.get("platform"), "ports=", service.get("ports", []), "limits=", {key: env[key] for key in keys if key in env})
'
```

确认 6 个服务都在、Web 只发布 `127.0.0.1:3100`、数据库/Redis/搜索没有宿主机端口。环境映射按键合并，原有的 `DEV_MODE=false`、连接参数、密钥、OSS、健康检查和持久卷仍来自基础文件；`command` 会被本覆盖文件替换为小机参数。

基础配置的 `build` 仍然存在；指定镜像未导入时，不能依赖 `run` 不构建。启动前必须检查解析后的三个应用服务引用的镜像均已存在且架构正确。以下辅助函数需要 Python 3，只检查镜像，不启动容器：

```sh
check_app_images() {
  dc config --format json | python3 -c '
import json, subprocess, sys
services = json.load(sys.stdin)["services"]
for name in ("web", "worker", "migrate"):
    image = services[name]["image"]
    platform = subprocess.check_output(["docker", "image", "inspect", "--format", "{{.Os}}/{{.Architecture}}", image], text=True).strip()
    if platform != "linux/amd64":
        raise SystemExit("Wrong image architecture: " + name)
print("Application images exist locally and use linux/amd64")
'
}
check_app_images
```

升级已有站点时，先用**旧版本**部署配置及 jobs 镜像停写备份；此步骤完成后才把 `.env.production` 镜像引用切换至新版本。第一次部署没有业务数据时可略过备份。下面用 `&&` 保证前一步失败时不会继续：

```sh
check_app_images &&
dc stop web worker &&
dc run --rm --no-deps worker npm run backup &&
dc cp worker:/app/backups ./backups-export
```

将导出的备份安全复制到异地并核验，随后设置新镜像引用。不要照抄其他说明中的裸 `docker compose` 命令，这里每条都需要 `dc` 所携带的环境文件和覆盖文件。迁移不能与 Web/Worker 同时运行；用以下函数执行发布，任一步失败都停止后续动作，迁移失败时不会启动应用：

```sh
deploy_small() {
  dc config --quiet || return 1
  check_app_images || return 1
  dc stop web worker || return 1
  dc up -d --no-build --wait --wait-timeout 120 db redis search || return 1
  dc run --rm --no-deps migrate || return 1
  dc up -d --no-build --no-deps --wait --wait-timeout 120 web worker || return 1
  dc ps -a || return 1
  curl --fail http://127.0.0.1:3100/api/v1/health || return 1
  docker stats --no-stream
}
deploy_small
```

新 shell 中需要重新定义这些函数。`--no-build` 防止启动服务时意外构建；迁移使用预先检查的 jobs 镜像执行一次性 `run`，不要添加 `--build`。`--wait` 先等待数据库/Redis 健康及搜索进程启动；随后才对迁移、Web/Worker 使用 `--no-deps`，它不代表可跳过依赖检查。Meilisearch 启动后还应验证站内搜索/索引任务，健康接口仅验证数据库连通。资源配置更改后需重建对应容器，简单 `restart` 不会应用新限制。

## 网络、磁盘与上线验收

公网网站使用 80/443，由 Nginx 转 HTTPS；SSH 22 限制管理来源。不要开放 3100、5432、6379、7700，也不要改变 Web 的 localhost 绑定。域名部署可补齐 [Nginx 代理片段](../deploy/nginx.conf.example)；无域名部署使用 [IP HTTPS 示例](../deploy/nginx.ip.conf.example) 与下一节的自动续期配置。`APP_URL` 使用实际的 HTTPS 域名或公网 IP，修改后重建 Web/Worker 容器使配置生效。

40 GB 磁盘会同时保存系统、镜像、数据库/Redis/搜索数据及备份卷。用 `df -h`、`docker system df` 查看空间；清理已确认无用的旧镜像和构建缓存时保留可回退版本。备份包含从 OSS 下载的原图，须设保留期并复制到受限的异地存储。不要执行 `docker compose down -v`、`docker volume prune` 或清空数据卷来腾空间。

对外开放前，实测 HTTPS 登录、个人短信送达、邀请注册、图文审核、私密社群权限、任务处理、备份恢复；查看 `docker stats`、容器重启次数及 OOM 状态。先在低并发下逐步验证，不能用“服务已启动”代替这些验收。数据库迁移后的回退遵循 [恢复流程](operations.md)，不能盲目把旧代码连到已变更的数据结构。

## 无域名时使用可信 IP HTTPS

Let’s Encrypt 已支持公网 IP 证书，必须选择 `shortlived` 配置，有效期为 160 小时（约 6 天）。因此不能只靠手动续期；申请证书时就应配齐自动检查、续期和 Nginx 重新加载。[官方说明](https://letsencrypt.org/2026/01/15/6day-and-ip-general-availability)

下面以 Certbot 5.8、独立虚拟环境中的 `/opt/certbot/bin/certbot` 为例；安装路径不同时同步修改所有命令及 systemd 单元。`203.0.113.10` 是文档保留地址，必须全部换成自己的公网 IPv4，邮箱也换成运营者真实邮箱。此流程只配置服务器，不代表公网连接、签发或登录已经验收成功。

1. 安装 Nginx 和 Certbot，确认 `/opt/certbot/bin/certbot --version` 为 5.8 或支持 IP webroot 签发的更新版本。创建 `/var/www/letsencrypt/.well-known/acme-challenge`，让 Nginx 能读取。先将 [示例](../deploy/nginx.ip.conf.example) 中的 `log_format` 与 **80 端口 server 块** 放入 Nginx 的 `http {}` include 目录；证书尚未存在时不要加载 443 块。执行 `nginx -t` 后启动或 reload Nginx，确认安全组、主机防火墙及网络允许公网访问 80，ACME 验证路径可从外部读取。
2. 使用 webroot 获取 IP 证书。先在下面命令中增加 `--dry-run` 验证挑战，成功后去掉该参数申请可信证书。`--agree-tos` 表示运营者已阅读并接受证书服务条款。测试证书不能作为最终 HTTPS 证书；不使用 `--nginx` 自动安装 IP 证书。[Certbot IP 证书流程](https://letsencrypt.org/2026/03/11/shorter-certs-certbot)

   ```sh
   /opt/certbot/bin/certbot certonly --non-interactive --agree-tos \
     --email operator@example.com --cert-name ai-home-ip \
     --preferred-profile shortlived --webroot \
     --webroot-path /var/www/letsencrypt --ip-address 203.0.113.10
   ```

3. 成功签发后再启用示例的 443 块，证书目录固定为 `/etc/letsencrypt/live/ai-home-ip/`。将 `.env.production` 中的 `APP_URL` 设为 `https://203.0.113.10`（替换真实 IP），重建 Web/Worker。执行 `nginx -t && systemctl reload nginx`；从外部验证 HTTPS、HTTP 跳转和证书 IP SAN，不跳过证书校验。80 端口的 ACME 路径应持续保留，其他 HTTP 请求跳转到固定 HTTPS 地址。
4. 创建仅 root 可修改、可执行的 `/etc/letsencrypt/renewal-hooks/deploy/10-ai-home-nginx`，内容如下。先检查本机 `nginx`、`systemctl` 路径并按实际安装位置调整。deploy hook 仅在续期成功后运行；语法检查失败时保留当前 Nginx 进程，不加载错误配置。

   ```sh
   #!/bin/sh
   set -eu
   /usr/sbin/nginx -t
   /usr/bin/systemctl reload nginx
   ```

   ```sh
   chown root:root /etc/letsencrypt/renewal-hooks/deploy/10-ai-home-nginx
   chmod 750 /etc/letsencrypt/renewal-hooks/deploy/10-ai-home-nginx
   ```

5. 创建 `/etc/systemd/system/ai-home-certbot-renew.service`：

   ```ini
   [Unit]
   Description=Renew AI-home IP HTTPS certificate
   Wants=network-online.target
   After=network-online.target nginx.service

   [Service]
   Type=oneshot
   ExecStart=/opt/certbot/bin/certbot renew --cert-name ai-home-ip --non-interactive --quiet
   ```

   创建 `/etc/systemd/system/ai-home-certbot-renew.timer`，每天每隔 12 小时检查一次是否需要续期；不是强制重复签发：

   ```ini
   [Unit]
   Description=Check AI-home certificate renewal every 12 hours

   [Timer]
   OnCalendar=*-*-* 00,12:00:00
   RandomizedDelaySec=30m
   Persistent=true

   [Install]
   WantedBy=timers.target
   ```

   确认没有其他定时任务重复管理同一证书后，启用 timer，并验证挑战及 deploy hook。`--run-deploy-hooks` 会在 dry-run 成功后执行 hook，重新加载当前有效证书，不安装测试证书。[Certbot 续期说明](https://eff-certbot.readthedocs.io/en/stable/using.html#renewing-certificates)

   ```sh
   systemctl daemon-reload
   systemctl enable --now ai-home-certbot-renew.timer
   /opt/certbot/bin/certbot renew --cert-name ai-home-ip --dry-run --run-deploy-hooks
   systemctl list-timers ai-home-certbot-renew.timer
   journalctl -u ai-home-certbot-renew.service --no-pager -n 30
   openssl x509 -in /etc/letsencrypt/live/ai-home-ip/cert.pem -noout -dates -ext subjectAltName
   ```

持续检查 timer 下一次执行时间、续期日志和实际对外提供的证书到期时间；配置失败或续期失败时应及时处理，不能等浏览器报过期再人工续期。IP 变化时需重新申请与新地址匹配的证书，并同步修改 Nginx 与 `APP_URL`。

示例通过 Nginx 覆盖客户端 IP 和转发主机头，匹配应用的 `AUTH_IP_HEADER=x-real-ip`；不要把 3100 暴露到公网或直接信任来访者的转发头。`client_max_body_size 12m` 为应用的 10 MiB 图片上限留出 multipart 余量。响应关闭代理缓冲以支持 Next 流式页面，不启用代理缓存；访问日志不记录查询参数、Cookie 或 Authorization。项目当前没有 WebSocket，MCP 使用 JSON POST，无需额外的 Upgrade 配置。日志仍需设置受限权限和轮转。

配置依据：[Docker Compose 合并规则](https://docs.docker.com/reference/cli/docker/compose/)、[服务内存配置](https://docs.docker.com/reference/compose-file/services/)、[local 日志驱动](https://docs.docker.com/engine/logging/drivers/local/)、[Meilisearch 索引资源参数](https://specs.meilisearch.dev/specifications/text/0119-instance-options.html)。
