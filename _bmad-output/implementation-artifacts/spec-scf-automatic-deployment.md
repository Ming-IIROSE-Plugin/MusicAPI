---
title: GitHub Actions 自动更新现有 MusicAPI 云函数
type: feature
created: 2026-10-16
status: done
deployment_status: blocked-on-config-migration
route: dispatch
review_loop_iteration: 0
baseline_commit: 0c57639114afac5736adb6f9e389b46ca39c22dc
context:
  - /root/个人/MusicAPI/AGENTS.md
---

<frozen-after-approval reason="human-owned intent">

## Intent

用户已经手动部署并成功运行 MusicAPI，希望后续代码推送到 GitHub 后自动验证、打包并更新现有腾讯云 SCF。目标固定为香港地域 `ap-hongkong`、命名空间 `default`、函数 `MusicAPI`，用户确认其为 WebFunction 且已挂载持久化存储。

使用 GitHub Actions 执行依赖安装、构建、隔离测试和 lint，成功后使用腾讯云官方 SDK 的代码更新接口更新目标函数。增加手动运行入口和串行部署约束，记录提交与部署结果。仅文档变化不触发部署。

## Boundaries & Constraints

**Always:** 保留现有环境变量、挂载存储、网络、超时及触发入口配置。生产包采用文件允许名单，包含编译产物、ESM package.json、生产依赖和经确认的启动文件。腾讯云鉴权从 GitHub Actions Secrets 读取，日志只记录必要的部署状态和错误码。部署前验证目标类型、运行时和状态，部署后等待完成并验证访问入口。

**Never:** 不创建或删除云函数，不把真实 `.env`、Cookie、挂载数据、云密钥或账号响应写入代码包/日志/构建产物。不凭猜测更改线上版本或别名。发布版本及流量切换方式须按实际绑定确定。

## I/O & Edge-Case Matrix

| 场景           | 输入/状态                    | 预期行为                                  |
| -------------- | ---------------------------- | ----------------------------------------- |
| main 代码变更  | 运行代码、依赖或部署文件变化 | CI 通过后更新指定函数                     |
| 文档变化       | 仅文档文件                   | 不触发自动部署                            |
| 手动运行       | main 的 workflow_dispatch    | 使用同一验证与部署流程                    |
| 检查失败       | 构建、测试或 lint 失败       | 不调用更新接口                            |
| 凭证缺失       | 未配置 Actions Secrets       | 明确配置失败，不尝试匿名部署              |
| 目标不兼容     | 镜像模式或不支持的运行时     | 更新前失败，不修改函数配置                |
| 版本绑定不匹配 | URL 指向非预期版本/别名      | 不宣称线上更新成功，不猜测切流            |
| 更新失败/超时  | API 失败或函数迟迟未恢复可用 | 工作流失败，保留可追踪部署记录            |
| 持久化数据     | SCF 已挂载存储               | 代码包与部署 API 不包含 Cookie 或缓存数据 |

</frozen-after-approval>

## Open Questions

1. 线上代码包含 `.env`，而云端 Environment 无 MUSIC_U 等字段；首次替换代码前需将必要配置保存在云端环境变量。当前流水线先验证和只读预检查，部署默认受仓库变量 SCF_DEPLOY_ENABLED 控制；在配置来源解决前不更新生产代码。

## Code Map

- `package.json`：npm test 已包含 build；lint 只扫描 src；没有部署依赖或脚本。
- `src/index.ts`：原生 HTTP 服务，默认 9000，首页存活检查不代表网易云会话初始化成功。
- `src/config/env.ts`：进程环境优先，支持 NETEASE_COOKIE_FILE。
- `src/accountManage/netease/CookieManager.ts`：优先配置文件路径，再选择已存在的 /mnt/account/netease。
- `src/service/cacheService.ts`：/mnt 存在时使用挂载目录缓存。
- `test/*.test.mjs`：隔离模拟测试及真实编译入口测试，CI 须先创建 /tmp/opencode。
- 当前没有 `.github/workflows`、SCF 启动文件或生产包脚本。

## Tasks & Acceptance

**Execution:**

- [x] `.github/workflows/deploy.yml`：配置 main 路径过滤、手动入口、最小 GitHub 权限、测试和串行部署。
- [x] `scripts/package-scf.*`：按确认的线上目录形态构建允许名单代码包，保存启动文件执行权限。
- [x] `scripts/deploy-scf.*`：官方 SDK 查询目标、验证兼容性、更新代码并等待；依据已确认版本绑定决定发布行为。
- [x] `test/`：测试打包排除、验证失败不部署、错误脱敏、异步状态及部署失败处理。
- [x] `docs/scf-deployment.md`：记录目标、Secrets 名称、CAM 所需权限、实际部署流程与回退步骤，不记录凭证值。

**Acceptance Criteria:**

- Given 配置完整，when main 代码 push 且 CI 通过，then 指定函数更新为对应提交的产物，工作流记录状态。
- Given 已挂载存储与环境变量，when 代码更新，then 部署不调用修改这些配置的 API。
- Given 任一验证失败，when 流水线执行，then 生产代码更新步骤不运行。

## Implementation Notes

2026-10-16 用户完成 GitHub workflow 授权，明确允许通过 Actions 查询腾讯云。只读检查运行 38958158656 成功：Runtime=Nodejs24.11、Type=HTTP、Status=Active、Timeout=3、InitTimeout=65、MemorySize=512、挂载 /mnt/、公网启用且配置 VPC。http 触发器绑定 $DEFAULT，别名指向 $LATEST 且无权重分流。ZIP 内有 dist/index.js、package.json、node_modules、可执行 scf_bootstrap，启动二进制 /var/lang/node24/bin/node。ZIP 中有 .env，但不读取输出其值。两个腾讯云 Secrets 已存在且鉴权成功。

用户已授权搭建现有函数的自动化及默认提交推送；据此先完成可逆的流水线、打包和只读预检查。仅代码部署在环境来源解决且开启 SCF_DEPLOY_ENABLED 后触发；不猜测删除现有 .env 不会影响业务，不复制凭证到产物。

2026-10-16 已通过本地调查和官方 API 文档确认 UpdateFunctionCode 支持 ZipFile，GetFunction 可返回 Runtime、Type、Status、ImageConfig 等。没有查询真实云端配置，没有使用聊天中的凭证，没有修改云函数。当前仅规划完成，流水线未实现或启用。

## Verification

- npm test、npm run lint，以及新增部署脚本离线测试。
- 检查生产包文件列表，确认无凭证、data 或开发工具目录。
- GitHub Actions 实际执行与云端部署验收须在鉴权配置和剩余函数信息明确后进行。

## Review Triage Log

代码已实现，实际部署被配置迁移与健康入口确认阻塞。先前“未发现问题”的自审结论由以下独立审查结果替代；离线通过不代表真实部署验收通过。

| #   | 发现                                     | 处置与验证                                                                                                                     |
| --- | ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| 1   | MUSIC_U 存在不能证明原 .env 配置迁移完成 | 已修复：增加 SCF_CONFIG_MIGRATED=true 门槛，文档逐项列出需人工迁移核对的键；缺少确认时不更新。                                 |
| 2   | 健康 URL 可缺失或指向其他函数            | 已修复：实际部署强制健康 URL，与目标 TriggerDesc 递归发现的 origin 匹配；缺失目标 URL 拒绝。自定义域需显式信任与人工映射确认。 |
| 3   | 冷启动暂时网络/5xx 失败立即终止          | 已修复：约 90 秒有限重试；重定向、4xx、错误正文不重试；mock 覆盖恢复及超时。                                                   |
| 4   | 大写 hex hash 比较可能误失败             | 已修复：GetFunctionAddress hex 转小写，保留 Base64 大小写；离线覆盖匹配，真实 ZIP/hash 等同性待实际部署验证。                  |
| 5   | 源码测试未验证最终生产 ZIP 依赖与入口    | 已修复：新鲜 ZIP 安全解压后覆盖 MUSICAPI_TEST_DIST_ENTRY，复用隔离启动测试，运行包内入口和依赖；不访问真实挂载或凭证。         |
| 6   | 只读门控结果未清晰报告配置缺项           | 已修复：摘要输出 preflight ready、failed conditions、skipped/unchecked；测试覆盖关闭门控且配置未迁移。                         |
| 7   | 完成状态容易误读为生产部署已验证         | 已修复：区分代码完成与 deployment_status=blocked-on-config-migration；未执行云端更新、提交或推送。                             |
