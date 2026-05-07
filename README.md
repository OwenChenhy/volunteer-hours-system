# 志愿时长管理系统部署文档

## 1. 环境准备
由于我们使用了 Docker Compose 编排前后端和服务，您只需要在一台 Linux 服务器上安装以下环境：
- Docker (>= 20.10)
- Docker Compose (V2 推荐)

建议服务器配置：
- CPU：2 核
- 内存：4 GB 或以上

## 2. 代码准备与配置
将本项目的全部代码上传至服务器某目录下（例如 `/opt/volunteer-system`）。

在根目录下创建 `.env` 文件（或修改 `backend/.env`），包含关键配置：
```bash
# 生成随机 JWT 密钥：
# openssl rand -base64 64
JWT_SECRET=在这里填入你生成的极长随机字符串
```

> **注意**：数据库、Redis等配置已经默认写在了 `docker-compose.yml` 中，如果需要对外暴露端口，可自行修改。

## 3. 构建前端资源
在启动 Docker Compose 前，需要先构建前端静态文件。如果在服务器上安装了 Node.js，可以在服务器上执行；否则在本地执行后一并上传。

**构建查询页前端**:
```bash
cd frontend-query
npm install
npm run build
```

**构建管理后台前端**:
```bash
cd ../frontend-admin
npm install
npm run build
```
执行完毕后，`frontend-query/dist` 和 `frontend-admin/dist` 目录将会生成。`docker-compose.yml` 中配置了将这两个目录挂载到 Nginx 容器中。

## 4. 启动服务
回到项目根目录（包含 `docker-compose.yml` 的目录），执行以下命令：

```bash
docker compose up -d --build
```

系统会自动拉取所需镜像（PostgreSQL, Redis, Nginx, Node），构建后端镜像并启动。

### 检查服务状态
```bash
docker compose ps
docker compose logs -f backend
```

## 5. 数据库初始化与管理员账号
由于 `backend/src/db/migrations/001_init.sql` 被挂载到 PostgreSQL 的 `/docker-entrypoint-initdb.d`，首次启动时数据库会自动建表。

**（如果您使用 Supabase）**：
如果您决定完全使用外部的 Supabase 数据库，请：
1. 注释掉 `docker-compose.yml` 中的 `postgres` 容器及相关卷。
2. 将 `backend` 容器的 `DATABASE_URL` 环境变量修改为您的 Supabase 连接字符串（包含用户名密码和连接池）。
3. 前置已在 Supabase 的 SQL 编辑器中运行了建表 SQL。

如果需要**创建初始超级管理员**，可通过命令行连接数据库执行（Docker Postgres 方式）：
```bash
docker compose exec postgres psql -U postgres -d volunteer_db
```
执行 SQL（密码以 `123456` 为例，需先生成对应的 bcrypt hash。`123456` 的 hash 为 `$2b$10$YOUR_HASH_HERE`）：
```sql
-- 这里假设生成的密码 Hash 已经生成
INSERT INTO users (username, password_hash, real_name, role, org_name) 
VALUES ('admin', '$2b$12$D2M6b4g2D9z9G1B6R8K1uO1n2H3s4f5d6g7h8j9k0l1z2x3c4v5b', '超级管理员', 'admin', '校青协');
```
*提示：在实际部署中可以使用一个简单的 node 脚本生成 bcrypt hash。*

## 6. 访问系统
- **公开查询页**：访问 `http://服务器IP/` 或 `http://服务器IP/query`
- **管理后台**：访问 `http://服务器IP/admin`
- **API 地址**：`http://服务器IP/api/v1/...`

## 7. 常见问题
- **更新代码后如何重启**：在根目录下执行 `docker compose up -d --build`。如果更新了前端代码，记得先重新执行 `npm run build`。
- **数据备份**：PostgreSQL 数据保存在 `pgdata` volume 中。建议定期使用 `pg_dump` 备份数据库。
