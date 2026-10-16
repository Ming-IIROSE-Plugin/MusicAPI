# 会话现状与目标流程

> 以下包含先前分析和初版实现的历史记录。最终实现与 36 项测试证据见 [构建规格](../../implementation-artifacts/spec-netease-session-fallback.md)。当前仅明确的登录失效业务码或明确匿名状态触发环境凭证刷新；临时错误不触发。缺失/不完整会话返回 NEEDS_SESSION_IMPORT；恢复入口为启动刷新和 /refresh/login，播放不对已有完整 Cookie 每次查询账号。

## 当前实际链路

```text
播放请求
  → CookieManager.getCookie()
  → 只在 cookie.json 不存在时调用 refreshCookie()
  → 从持久化 Cookie 取 MUSIC_U / __csrf
  → EAPI /api/song/enhance/player/url

手动刷新
  → checkAndRefreshCookie()
  → 只有文件不存在或保存时间超过 24 小时时才调用 refreshCookie()
  → refreshCookie() 优先取持久化 Cookie 的 MUSIC_U
  → 只有持久化 Cookie 中没有 MUSIC_U 才回退 env.MUSIC_U
  → EAPI /api/login/token/refresh
  → 只保存 response.headers.get('set-cookie')
```

当前最强的代码级证据是：如果运行时选中的持久化文件存在 `MUSIC_U`，它会覆盖 `.env` 中的新值；只有持久化 Cookie 中没有该字段才回退到 `.env`。项目数据文件确实存在 `MUSIC_U`、`__csrf`、`NMTID`、`MUSIC_R_U`、`MUSIC_R_T`、`MUSIC_SNS`、`MUSIC_A_T` 等字段，且其 `MUSIC_U` 与 `.env` 不同，但当前机器因为 `/mnt` 存在，代码选择的路径是 `/mnt/account/netease/cookie.json`，该文件目前不存在。因此必须在服务运行时打印脱敏来源和指纹，不能只根据项目数据目录判断实际使用值。

## 修复前确认的实现问题

1. `CookieManager.refreshCookie()` 优先使用旧持久化 `MUSIC_U`，新 `.env` 值不会覆盖它。
2. `getCookie()` 对已存在的过期、损坏或被拒绝的 Cookie 不会自动触发刷新。
3. 播放请求没有把 IP 传给 `CookieManager.getCookie()`，首次隐式刷新使用默认 `127.0.0.1`。
4. 刷新请求只构造了 `MUSIC_U` 和服务端字段；完整旧 Cookie 中的 `__csrf` 等字段没有作为独立会话来源管理。
5. 收到 `code=200` 但没有 `Set-Cookie` 时仍报告成功；落盘失败也被 `setCookie()` 吞掉。
6. 返回的 `Set-Cookie` 可能包含多个 Cookie 和属性，当前逻辑把合并字符串直接保存，后续读取不是可靠的 Cookie Jar 解析。
7. 服务缺少“当前会话来源、刷新前后指纹、账号校验结果”的安全诊断，所以无法确认请求是否真的使用了新凭证。

## 本次已实现

1. 账号检查确认持久化 `MUSIC_U` 明确失效后，`refreshCookie()` 才使用 `env.MUSIC_U` 作为候选；网络检查异常不会被误判成凭证失效。
2. 刷新响应必须同时满足 HTTP 成功、业务 `code=200`、存在 `Set-Cookie`、合并后的会话再次通过账号检查和原子写盘成功，才返回刷新成功。
3. `Set-Cookie` 会按 Cookie 名称合并，保留旧会话字段并更新服务端返回字段；Cookie 属性不会作为请求 Cookie 保存。
4. 刷新使用共享 Promise，重复并发调用只执行一个上游刷新任务。
5. Cookie 文件写入使用临时文件、`fsync` 和原子重命名，写入失败时保留旧文件。
6. `/mnt/account/netease` 目录不存在时使用项目 `data/account/netease`，并将播放请求的真实 IP 传入 Cookie 读取链路。

本次隔离模拟测试使用失效持久化凭证和脱敏 fixture：账号检查返回失效后成功切换到环境凭证；刷新请求次数为 1，账号检查次数为 3（持久化检查、刷新候选检查、刷新后检查），保存字段包含 `MUSIC_U`、`__csrf` 和 `NMTID`。测试没有访问网易云真实账号或线上接口。

静态检查结果：`npm run build` 通过，`npm run lint` 通过。构建配置已限制为 `src/**/*.ts`，lint 已限制为 `src`，不会把独立的 `api-enhanced` 参考仓库和 `dist` 产物混入检查。

## 目标行为

### 会话来源优先级

会话来源必须显式且可诊断：

1. 用户主动导入的完整 Cookie；
2. 配置指定的完整 Cookie；
3. 旧持久化 Cookie，仅在其仍通过账号校验且没有被新配置替换时使用；
4. 单独的 `MUSIC_U` 只作为不完整凭证，必须配合必要的会话字段和校验结果，不能静默覆盖完整 Cookie。

替换操作应使用临时文件写入、`fsync` 后原子重命名，并记录来源和脱敏指纹；失败时保留旧文件。

### 刷新状态机

```text
读取会话
  ├─ 缺少关键字段 → NEEDS_LOGIN 或 NEEDS_SESSION_IMPORT
  ├─ 账号校验有效 → 可播放；接近刷新期限时尝试续期
  ├─ 账号校验失败 → 尝试一次 refresh
  │    ├─ HTTP/业务/Set-Cookie/账号校验均有效 → 保存新会话
  │    └─ 任一失败 → 保留旧会话，分类为 REFRESH_REJECTED 或 NEEDS_LOGIN
  └─ 并发刷新 → 共享同一个 in-flight Promise
```

刷新结果至少应区分：

- `REFRESHED`：网易云返回成功、关键 Cookie 已合并保存、随后账号校验通过；
- `REFRESH_REJECTED`：网易云明确拒绝或返回业务失败；
- `REFRESH_RESPONSE_INVALID`：HTTP 成功但响应结构、Cookie 或账号校验不满足条件；
- `NEEDS_LOGIN`：当前登录来源或会话已经不能通过 refresh 恢复；
- `NEEDS_SESSION_IMPORT`：仅有 `MUSIC_U` 或持久化 Cookie 缺少必要字段；
- `IN_PROGRESS`：已有刷新任务，不重复请求。

### 兼容参考项目

`api-enhanced` v4.41.1 仍通过 `/api/login/token/refresh` 刷新，并在统一请求层维护完整 Cookie、设备字段、`NMTID` 和服务端返回 Cookie。它没有证明当前项目必须改用新的刷新 URL；应先修复会话来源和 Cookie Jar，再根据失败响应决定是否调整协议或请求指纹。

二维码登录是一个需要单独验证的风险点：公开文档和社区实现均提示二维码会话通常不支持 token refresh。若用户的最新 `MUSIC_U` 来自二维码登录，应把“重新扫码/完整登录”视作正常恢复路径，而不是无限重试 refresh。

## 验证矩阵

| 场景                            | 需要验证                 | 预期                                                             |
| ------------------------------- | ------------------------ | ---------------------------------------------------------------- |
| `.env` 新值，持久化旧值         | 请求前记录两个脱敏指纹   | 修复前会优先使用旧值；当前目标行为是在确认旧值失效后尝试环境凭证 |
| 完整 Cookie 导入                | 账号查询与播放请求       | 两者使用同一指纹，账号有效后播放成功                             |
| 仅 MUSIC_U，无 __csrf           | 刷新和账号查询           | 被标记为不完整会话，不报告刷新成功                               |
| refresh HTTP 200、业务失败      | 读取 code/msg            | 分类为 `REFRESH_REJECTED`，保留旧会话                            |
| refresh code 200、无 Set-Cookie | 检查响应与账号           | 不报告 `REFRESHED`，除非明确证明原 Cookie 仍有效                 |
| refresh 返回多个 Set-Cookie     | Cookie Jar 合并          | 保留必要旧字段，更新返回字段，属性不进入请求 Cookie              |
| 二维码来源 Cookie               | refresh 一次             | 若上游拒绝，分类为需重新登录，不循环重试                         |
| 并发刷新                        | 同时触发多次请求         | 只有一个上游请求，所有调用方收到同一结果                         |
| 写盘中断                        | 模拟临时文件或重命名失败 | 旧会话保持完整且可读取                                           |

## 不应记录的内容

- `MUSIC_U`、`__csrf`、`MUSIC_R_U`、`MUSIC_R_T`、`MUSIC_SNS`、`NMTID` 原值；
- 完整 `Cookie` 请求头；
- 网易云带签名或过期参数的音频 URL；
- 刷新请求的完整密文 `params`。

允许记录字段名、存在性、长度、哈希前 8–12 位、HTTP 状态、业务 code、脱敏错误分类和时间。
