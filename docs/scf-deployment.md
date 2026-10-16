# SCF 部署

已于 2026-10-16 开启并完成首次完整验收：[自动部署运行 38964095180](https://github.com/jingming295/MusicAPI/actions/runs/38964095180)。提交 `30d827c` 的 push 触发构建、45 项应用测试、26 项部署测试、生产包启动测试和云端更新；函数恢复 Active，云端文件内容与产物匹配，HTTP 健康检查通过。`SCF_CONFIG_MIGRATED`、`SCF_DEPLOY_ENABLED` 已启用，健康入口已配置。

GitHub Actions 面向已经存在的腾讯云函数 `ap-hongkong/default/MusicAPI`，只更新代码包。工作流使用 Node 24 构建，生产 ZIP 只包含 `dist/`、`package.json`、生产依赖和可执行的 `scf_bootstrap`。`.env`、`data/`、Cookie、密钥、测试文件和开发依赖不会进入 ZIP。

工作流在 `main` 分支的代码、依赖、构建、部署脚本或启动文件变化时运行，也支持 `workflow_dispatch`。部署作业始终先执行只读预检；只有仓库变量 `SCF_DEPLOY_ENABLED` 与 `SCF_CONFIG_MIGRATED` 都精确为 `true`、云端 `MUSIC_U` 非空且全部预检通过，才调用 `UpdateFunctionCode`。开关关闭时，摘要显示“代码更新 skipped”、preflight ready 和未满足条件，不会宣称已经部署。

需要在仓库 Actions Secrets 中配置 `TENCENT_SECRET_ID` 和 `TENCENT_SECRET_KEY`。对应 CAM 身份需要 `GetFunction`、`GetFunctionAddress`、`GetAlias`、`ListTriggers` 和 `UpdateFunctionCode` 权限，范围限制为目标函数。不要把网易云 Cookie 或 `.env` 内容迁移到 GitHub Secrets 或代码包；在腾讯云函数 Environment 中配置 `MUSIC_U` 及现有运行所需的环境变量名称，例如 `REFRESH_COOKIE_NETEASE`、`DEBUG_NETEASE`、`NETEASE_COOKIE_FILE` 和 `PORT`，值由维护者在云端管理。

预检要求函数为 `HTTP` 类型、运行时为 `Nodejs24.11`、状态为 `Active`，存在 `/mnt/` CFS 挂载，云端 `MUSIC_U` 非空，`$DEFAULT` 别名指向 `$LATEST` 且没有流量权重，并存在绑定 `$DEFAULT` 的 HTTP 触发器。任一条件不满足都会在代码更新前失败。脚本不会调用配置、别名、触发器或存储修改接口。

更新只调用一次 `UpdateFunctionCode`，参数为 ZIP、`InstallDependency=FALSE`、`Publish=FALSE`。之后脚本在有限时间内轮询函数状态和代码 SHA256：要求函数恢复为 `Active`，并精确匹配上传 ZIP 的 hash；若服务端重新封装 ZIP，则在内存下载云端包，验证下载摘要及全部文件的路径、内容 SHA256 和执行权限与上传包一致。仅 hash 变化不能证明部署成功。实际部署必须配置仓库变量 `SCF_HEALTH_URL`。脚本递归读取该目标函数启用的 `$DEFAULT` HTTP 触发器 `TriggerDesc` 中的 HTTPS `*.tencentscf.com` URL，只接受其中发现的 origin，不接受同域后缀的其他函数地址。无法发现 URL 时阻止部署，不输出原始响应。

自定义域名必须额外设置 `SCF_HEALTH_TRUSTED_ORIGIN` 为其准确 HTTPS origin，并由维护者在控制台人工确认该域名确实映射到 `ap-hongkong/default/MusicAPI` 的 `$DEFAULT` HTTP 入口。该变量是人工映射确认，不是自动发现；不能用它放行其他 `*.tencentscf.com` 主机，且仍要求发现目标触发器 URL。

当前没有自动回滚或版本切流。若更新后验证失败，保留 Actions 日志中的提交、预检、hash 和状态信息，由维护者在腾讯云控制台确认现有 `$LATEST`、别名和触发器后手动恢复；不要猜测线上版本或修改挂载配置。工作流不会记录签名 URL，也不会落盘、解压或执行下载的云端包。

代码 hash 从 `GetFunctionAddress.CodeSha256` 读取，十六进制统一为小写，Base64 保持大小写；比较时按 32 字节摘要识别编码。实测云端包摘要与上传 ZIP 摘要不同，因此增加完整文件内容校验以兼容重新封装；`GetFunction` 仅用于状态与配置校验。触发器响应要求 `Type=http`、`Enable=1`；路由配置只接受已知的 `AdditionalVersionWeights`、`AddtionVersionMatchs` 空数组，非空或未知字段会阻止部署。

打包器在临时目录重新编译，并按 lockfile 安装生产依赖。原始及新生成的 dist 只接受 `.js`、`.d.ts`、`.js.map`，拒绝符号链接、隐藏文件和运行数据目录；依赖树中的符号链接也会被拒绝。压缩 ZIP 限制为 3 MiB，这是本项目为 Base64 内联请求预留空间的保守上限，并非腾讯云的官方配额声明；打包时与更新前均校验。

健康 URL 在代码更新前验证，必须是无 userinfo、查询参数或 fragment 的 HTTPS 根路径。健康检查禁止重定向，要求 HTTP 200 且正文精确为 `Music Redirect Server Running`；网络暂时故障与 HTTP 5xx 在约 90 秒总预算内重试，单次请求最多 10 秒。4xx、重定向、错误正文立即失败。无健康 URL 会阻止实际更新；仅只读预检时健康状态为 `unchecked`。首页通过仍不证明网易云会话有效。

两个作业均限制为 `main`，包括手动触发；Python 固定为 3.12，checkout 不保留 Git 凭证，作业分别限时 15/10 分钟，ZIP artifact 只保留 1 天。上传 ZIP 前，`scripts/smoke_scf.py` 只解压本次本地生成的产物到临时目录，检查路径越界、符号链接与解压大小，并通过 `MUSICAPI_TEST_DIST_ENTRY` 复用启动测试。执行的是包内 `dist/index.js` 和生产依赖，Cookie、环境值和 fetch 均使用隔离 fixture，不读取真实 `.env` 或 `/mnt`。该测试不验证腾讯云中的 bootstrap 二进制路径或真实上游。

首次启用的人工迁移步骤：

1. 在云端私下核对旧 `.env` 中 `MUSIC_U`、`REFRESH_COOKIE_NETEASE`、`DEBUG_NETEASE`、`NETEASE_COOKIE_FILE`、`PORT` 以及其他实际配置键。按既有含义迁移到函数 Environment；未使用的键也应确认其默认行为可接受。不要把值贴进日志、文档或 artifact。
2. 确认 token 有效性、刷新开关、调试开关、持久 Cookie 路径与监听端口符合现有服务需求。仅有 `MUSIC_U` 字段或非空值不能证明迁移完成；脚本不会自动迁移凭证。
3. 完成以上核对后手动设置仓库变量 `SCF_CONFIG_MIGRATED=true`，配置并核对健康入口，然后运行只读预检。配置改变后重新核对迁移状态。
4. 预检 ready 后，最后启用 `SCF_DEPLOY_ENABLED=true`。本项目已完成上述步骤；以后相关代码 push 到 main 自动执行验证与部署，纯文档变更不会触发。
