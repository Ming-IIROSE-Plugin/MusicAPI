---
title: 环境 MUSIC_U 初始化及可诊断启动
type: bugfix
created: 2026-10-16
status: done
route: oneshot
baseline_commit: df05108e9b67d7f1c09e52ccee21497122909381
---

<frozen-after-approval>

## Intent

用户反馈编译运行后未使用环境凭证且缺少 debug 信息。修复缺失、损坏、不完整持久化 Cookie 时提前返回，允许配置的 MUSIC_U 尝试刷新；已有完整有效会话仍优先，明确失效时尝试环境候选，网络不确定不误替换。环境候选不混用旧登录 token/CSRF；成功响应须补齐必要字段、二次账号校验及原子保存，失败保留旧文件。单 token 是尝试而非成功保证。

提供默认可见的启动配置来源、存储路径、选中/跳过原因和结果摘要；DEBUG_NETEASE=true 启用详细脱敏阶段日志，包含时间、HTTP/业务码、耗时、错误分类及字段存在性/短指纹。绝不输出凭证、密文、个人信息、上游原文或音频 URL。明确 dotenv 基于 cwd 查找且进程环境优先。启动不能被公网 IP 查询无限阻塞，也不能对同一次失败自动重复刷新。验证真实编译产物和启动入口，以合成 .env、隔离文件及网络桩覆盖行为，测试不使用真实账号。无新依赖，无部署和推送。

</frozen-after-approval>

## Implementation Notes

## Review Triage Log

| 发现                                     | 判定           | 核验证据与处理                                                                      |
| ---------------------------------------- | -------------- | ----------------------------------------------------------------------------------- |
| 等待启动刷新失败的播放请求会立即重复刷新 | medium，已修复 | getCookie 原先 await 后再次触发缺失分支；现在等待者直接复用结果，新增并发失败回归。 |
| 播放空 URL、JSON 和网络失败缺少阶段日志  | medium，已修复 | 增加固定错误分类、耗时及数值歌曲状态；启动子进程覆盖路由失败诊断。                  |
| 账号 HTTP/业务码及 JSON 错误分类丢失     | medium，已修复 | 请求层保留受校验的结构化错误字段，测试区分 HTTP、业务与解析异常。                   |
| fetch 的嵌套 cause 错误码未读取          | medium，已修复 | 允许名单、有界深度提取系统码和数值 errno；测试 ENOTFOUND 与恶意字段过滤。           |
| 文件读写错误丢失操作阶段和系统码         | medium，已修复 | 读取分类及保存阶段增加安全诊断；测试损坏 JSON、读取/重命名失败与旧文件保留。        |
| dotenv ENOENT 被标为 error               | low，已修复    | 按 ENOENT 判 missing，子进程分别验证文件缺失及 EACCES。                             |
| PORT 接受垃圾后缀或越界值                | medium，已修复 | 完整纯数字与范围校验；非法输入固定提示并回退 9000，测试边界与实际动态端口。         |
| 播放 br 可把未校验上游原文写入日志       | medium，已修复 | 只记录有限数值，恶意字段及无 URL 场景回归检查无原文泄漏。                           |

以上审查发现均已处理，没有新增延期项。额外补齐 `.env` 单独提供 token 的启动证据及候选来源按分支标记，避免相同 token 错标来源。真实账号的上游刷新结果尚未验证。

## Implementation History

最终主会话独立执行 `npm test`、`npm run lint`、`git diff --check` 均通过：45 项测试无失败、无跳过。已完成独立审查，以下记录保留中间验证历史。

- 已确认旧版 CookieManager.performRefresh 的 incomplete 分支提前返回，index 忽略 boolean 刷新结果；dotenv 默认 cwd .env，已有进程变量优先。
- 局部修复会话选择与诊断，沿用单飞/原子保存；复用 Node test，新增启动子进程回归。
- 已实现集中式 cwd `.env` 加载、进程环境优先、`DEBUG_NETEASE` 脱敏阶段诊断、可选 `NETEASE_COOKIE_FILE` 与有界公网 IP 查询；启动初始化只执行一次，失败不会紧接着由 `getCookie()` 重复刷新。
- 缺失或不完整持久化会话现在会尝试环境 `MUSIC_U`；候选只包含该 token，刷新响应必须补齐必要 Cookie、通过二次账号校验并原子保存，失败保留旧文件；已有完整会话和网络不确定状态保持原会话。
- 验证结果（2026-10-16）：`npm run build`、`npm run lint`、`npm test` 全部通过；`npm test` 共 37 项隔离测试通过，新增测试使用临时 cwd、合成 `.env`、隔离 Cookie 文件和网络 stub 启动实际 `dist/index.js`，未访问真实账号、真实 `.env`、真实 `/mnt` 或外网。
- Review 修复（2026-10-16）：读取等待进行中的初始化/刷新后不再重试同一次失败；候选来源按选择分支记录，默认摘要包含选择及跳过原因。账号请求保留数值 HTTP/业务码，并区分 JSON、结构、业务和网络错误；错误字段使用固定分类及系统码允许名单，最多检查三层对象（含外层及两层 cause），errno 仅接受有限数值。
- Cookie 读取诊断区分 missing/invalid-json/invalid-shape/io-error，保存诊断记录操作阶段及安全错误字段。dotenv 的 ENOENT 正确显示 missing，其他读取错误显示 error。PORT 严格校验纯数字和 0..65535 范围，非法值仅输出固定回退提示；0 的启动日志显示实际端口。播放及路由失败诊断不再输出 br 原文、响应对象或错误原文。
- Review 后验证：`npm test`（含 TypeScript 构建）45/45 项通过，`npm run lint` 通过。44 项会话/诊断测试及 1 项启动测试；后者运行 13 个真实 `dist/index.js` 子进程场景，覆盖 dotenv-only 与进程环境优先、缺失/损坏/不完整会话、启动开关 true/false、单次刷新失败、持久会话优先、未知网络失败、debug 开关、dotenv 读取错误和播放路由诊断。子进程均使用 `/tmp/opencode` 下独立 cwd、合成凭证和 PORT=0；预加载桩拦截上游 fetch 及 /mnt 路径探测，仅通过本机回环访问测试 HTTP 服务。没有访问真实账号或真实 `.env`，没有向上游发请求；未提交或推送。上述 37 项为上一轮结果，以本条为当前验证结果。
