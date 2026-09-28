# 志愿时长管理系统

重庆理工大学志愿服务时长的公开查询、管理员复核与活动管理系统。生产站点：
[查询页](https://zysc.hanyao.me/query/) · [管理后台](https://zysc.hanyao.me/admin/) · [状态页](https://zysc.hanyao.me/status/)。

## 部署结构

- Docker Compose：PostgreSQL、Redis、Fastify 后端、Nginx 静态站点与 API 代理。
- 宿主 Nginx：Cloudflare 后的 HTTPS 入口，将请求代理到 `127.0.0.1:8080`。
- 本地主库：`postgres-data/`；异地副本：Supabase Database；异地备份：Supabase Storage 私有 bucket。
- 原始公示 Excel 只保存在服务器的只读导入目录和本地私人归档，不进入 Git。

## 首次部署

需要 Docker Compose V2、Node.js、Python 3、Nginx 和 Certbot。服务器工作目录为 `/opt/volunteer-system`。

1. 从本仓库克隆代码，在服务器本地创建权限为 `600` 的 `.env`，设置 `DB_PASSWORD`、`JWT_SECRET`、`SUPABASE_URL`、`SUPABASE_SERVICE_ROLE_KEY`、`SUPABASE_BACKUP_BUCKET` 和 `SUPABASE_BACKUP_PREFIX`。不要把密钥写入仓库。
2. 构建两个前端：`npm --prefix frontend-query ci && npm --prefix frontend-query run build`；`npm --prefix frontend-admin ci && npm --prefix frontend-admin run build`。
3. 启动服务并迁移：`docker compose up -d --build`，然后 `sh scripts/migrate-db.sh`。
4. 把公示 Excel 放入对应的 `2025-2026志愿者时长库3月公示/`、`2025-2026志愿者时长库4月公示/`、`2025-2026志愿者时长库5月/`，仅授权 root 读取。容器只读挂载这些目录。
5. 将 `nginx/origin-zysc.conf` 安装为宿主站点配置，将 `nginx/cloudflare-realip.conf` 安装到 `/etc/nginx/cloudflare-realip.conf`；取得 `zysc.hanyao.me` 的有效证书后 `nginx -t && systemctl reload nginx`。
6. 将 `deploy/volunteer-backup.service` 和 `.timer` 安装到 `/etc/systemd/system/`，运行 `systemctl daemon-reload && systemctl enable --now volunteer-backup.timer`。

本仓库不含生产数据库、原始 Excel、管理员密码或 Supabase 密钥。初次建库后应通过受控方式创建管理员，不能使用示例密码。

## 验证与恢复

```bash
docker compose ps
npm --prefix backend ci
npm --prefix backend test
docker compose exec -T backend node scripts/recovery-smoke.js
systemctl start volunteer-backup.service
systemctl show volunteer-backup.service -p Result -p ExecMainStatus
```

`recovery-smoke.js` 会进行一次真实公开查询，成功查询计数会增加。数据库恢复是破坏性操作，必须先保存当前快照，再显式执行：

```bash
sh scripts/backup-postgres.sh
ALLOW_RESTORE=1 sh scripts/restore-postgres.sh backups/<verified-dump>.dump
```

恢复后运行 `sh scripts/migrate-db.sh`、`python3 scripts/sync-supabase-database.py`，并核对主库、云端记录数及关键表摘要。同步脚本默认只 upsert；不要在仍需保留云端备份时使用 `--replace`。

详细操作与 2026-09-28 恢复证据见 [运维流程.md](./运维流程.md) 和 [恢复记录](./恢复记录_2026-09-28.md)。
