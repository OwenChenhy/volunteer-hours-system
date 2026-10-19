# PR 合并后自动部署生产

本 PR 合并到 `main` 后启用 `Deploy production`。创建、更新或关闭未合并的 PR 不部署；已合并到 `main` 的 PR 自动部署。直接 push 不触发此流程。当前生产地址为 <https://zysc.hanyao.me>。

## 发布步骤

1. GitHub 在 `production` 环境中使用专用 SSH 密钥连接服务器。服务器固定主机密钥，部署密钥禁止交互 shell、端口转发和任意命令。
2. GitHub concurrency 和服务器 `flock` 串行发布。服务器只接受当前最新 `origin/main` 的完整提交 SHA；已经被更新提交取代的旧任务跳过。
3. 在服务器独立发布目录提取该提交，使用 `npm ci` 构建两个前端，构建后端 Docker 镜像，在无网络、无生产数据挂载的镜像容器中运行完整 `npm test`。产品回归需要的仓库工具只读挂载到测试容器。
4. 使用服务器现有 `DB_PASSWORD` 对数据库 dump、源码及原前端资源加密备份，完整解密读取验证；不落盘明文数据库或密钥，保留原后端镜像标签。
5. Git 仅允许 fast-forward 更新，构建成功后才替换服务和前端。后端在接收请求前执行自身有序、加锁的迁移；保留旧哈希静态资源供已打开的网页使用。
6. 验证本机及公网 `/health`、`/query/`、`/admin/`、`/status/`，确认运行镜像与目标镜像一致后写入 `.release-version.json`。

生产目录存在已暂存改动、未提交运行代码或未跟踪运行源文件时终止。现有未提交文档可以保留；若 Git 判断本次合并会覆盖它们，合并失败并保留原文件。

## 已配置的环境

- GitHub environment：`production`，部署分支限定 `main`，无需额外审批。
- Environment secret：`DEPLOY_SSH_KEY`。
- Environment variables：`DEPLOY_HOST`、`DEPLOY_USER`、`DEPLOY_PORT`、`DEPLOY_KNOWN_HOSTS`。
- 服务器受限入口：`/usr/local/sbin/volunteer-deploy-github`，源文件为 `deploy/github-deploy-command.sh`。
- 允许命令：`check`，或 `deploy <40位提交SHA>`。部署时从已验证的最新主分支读取 `scripts/deploy-production.sh`，不执行未合并 PR 的脚本。

专用私钥在配置过程中仅存在于内存，已通过 GitHub CLI 保存为加密 secret；未写入仓库或本机文件。原 SSH 登录密钥及已有 authorized_keys 条目保留。

## 手动检查与重跑

在 GitHub Actions 选择 `Deploy production` → `Run workflow`，分支选择 `main`。默认 `check_only=true`，只检查连接、服务器命令、Compose 配置和现有健康接口；取消该选项会部署当前 `main`。失败任务也可在 Actions 页面重跑；若目标提交已过期，服务器跳过该任务。

服务器也可通过原有管理员 SSH 入口检查：

```bash
SSH_ORIGINAL_COMMAND=check /usr/local/sbin/volunteer-deploy-github
python3 scripts/check-production-deploy.py
```

## 失败与恢复

构建、测试或备份失败时不切换生产。切换后失败自动恢复前一 Git 提交、镜像及前端，并在 Actions 标记失败。不会自动恢复数据库，以免覆盖发布后的业务写入；不兼容的 schema 变更仍须在合并前制定数据库恢复方案。

每次发布的私有日志、加密备份、`previous-commit`、`previous-image` 和旧版本元数据保存在 `/opt/volunteer-system-release-backups/<UTC时间>-auto-<SHA>.<随机后缀>/`。文件仅服务器 root 可读，不上传 Actions artifact。发布目录、构建缓存及回滚镜像需按运维保留需求定期整理。

## 2026-10-19 验证

- 服务器完成两前端构建和后端镜像构建；实际后端镜像内完整六组 `npm test` 通过。
- 部署脚本十组检查覆盖成功发布、构建/镜像测试/数据库备份失败、服务切换/健康检查失败后的代码回退、未提交/未跟踪运行代码、过期提交和 SSH 命令限制。测试使用临时 Git 仓库和模拟服务，不切换生产。
- 使用专用新密钥从本机真实连接生产服务器：`check` 成功，`bash` 与注入形式的命令均返回 64。
- 真实主库加密备份完整解码验证通过，校验只将 SQL 写入 `/dev/null`，没有执行数据库恢复；备份权限 `600`。
- GitHub `production` 环境、仅 `main` 的分支策略、四项变量及部署 secret 已实查。
- 配置期间生产仍为 `96acf62c54e54eebcf7765323309f97ef502d8bd`。本 PR 尚未合并，因此没有宣称 GitHub 已完成一次真实自动发布。

触发器与环境行为参考 [GitHub 事件文档](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows) 和 [部署控制文档](https://docs.github.com/en/actions/how-tos/deploy/configure-and-manage-deployments/control-deployments)。
