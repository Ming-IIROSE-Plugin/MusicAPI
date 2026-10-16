---
title: "网易云失效会话使用环境凭证兜底刷新"
type: "bugfix"
created: "2026-10-16"
status: "done"
route: "dispatch"
review_loop_iteration: 0
baseline_commit: "NO_VCS"
context:
  - /root/个人/MusicAPI/AGENTS.md
  - /root/个人/MusicAPI/_bmad-output/specs/spec-netease-login-session-refresh/SPEC.md
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** 服务当前可能继续使用已失效的持久化 `MUSIC_U`，即使 `.env` 已经配置了新的凭证；刷新结果还可能因 Cookie 合并和成功判定不完整而无法真正保存可用会话。这样会导致账号状态和播放请求持续失败，且管理员无法判断失败发生在哪一步。

**Approach:** 在刷新前验证持久化会话；只有账号接口明确确认该会话失效时，才使用 `.env` 的 `MUSIC_U` 作为候选进行刷新。刷新返回的 Cookie 必须正确合并，服务端返回的新值优先，并在二次账号校验和原子写盘成功后才替换本地会话。

## Boundaries & Constraints

**Always:** 保留现有 EAPI 刷新接口和播放链路；网络异常不能被误判为凭证失效；刷新失败保留旧 Cookie；日志只允许输出字段存在性、长度、短指纹、HTTP 状态和业务状态，不输出凭证原文或完整 Cookie。

**Never:** 不实现新的登录流程；不把 `.env` 的单独 `MUSIC_U` 宣称为完整登录恢复保证；不在未通过二次账号校验时覆盖持久化 Cookie；不访问真实账号作为自动化测试的一部分。

## I/O & Edge-Case Matrix

| Scenario                 | Input / State                                         | Expected Output / Behavior                                        | Error Handling                         |
| ------------------------ | ----------------------------------------------------- | ----------------------------------------------------------------- | -------------------------------------- |
| 持久化会话有效           | 账号接口返回 `code=200` 且账号资料存在                | 不使用 `.env` 候选；按刷新策略继续使用持久化会话                  | 保留现有 Cookie                        |
| 持久化会话明确失效       | 账号接口返回业务失败或空账号资料，`.env.MUSIC_U` 存在 | 使用 `.env.MUSIC_U` 请求刷新，并保留旧会话中的必要非 token Cookie | 候选刷新失败时保留旧文件               |
| 刷新返回轮换后的 MUSIC_U | `Set-Cookie` 包含新的 `MUSIC_U`                       | 服务端返回值覆盖候选值并写入合并 Cookie                           | 缺少必要 Cookie 或二次校验失败时不写盘 |
| 账号检查网络异常         | 请求抛错或 HTTP 响应不可解析                          | 不触发 `.env` 兜底，返回刷新失败                                  | 记录脱敏错误分类，旧会话不变           |
| 并发刷新                 | 多个调用同时触发刷新                                  | 共享一个刷新任务，上游只请求一次                                  | 所有调用方获得同一结果                 |

</frozen-after-approval>

## Code Map

- `src/accountManage/netease/CookieManager.ts` -- 会话文件选择、账号有效性判断、环境凭证兜底、Cookie 合并、原子保存和并发刷新；复用现有 `refreshCookie` / `checkAndRefreshCookie` 入口。
- `src/sendRequest/netease/neteaseAccount.ts` -- 复用现有 EAPI `/api/login/token/refresh` 和 WEAPI 账号查询；补充 HTTP 响应和业务结果边界。
- `src/accountManage/netease/AccountManager.ts` -- 保持管理接口的账号状态语义与 Cookie 读取方式一致，避免把网络异常误报成账号失效。
- `src/sendRequest/netease/GetMusicPlayUrl.ts` -- 保持播放请求使用同一份持久化 Cookie，并传递实际 IP。
- `src/index.ts` -- 保持启动刷新入口和布尔环境变量解析；启动时等待 Cookie 初始化完成。
- `tsconfig.json`、`package.json`、`eslint.config.mjs` -- 仅检查 `src`，避免独立 `api-enhanced` 参考仓库和 `dist` 产物污染项目检查。
- `AGENTS.md`、`_bmad-output/specs/spec-netease-login-session-refresh/session-flow.md` -- 项目约束和既有分析依据；实现需遵守敏感凭证脱敏要求。

## Tasks & Acceptance

**Execution:**

- [x] `CookieManager.ts` -- 完善失效判定、`.env.MUSIC_U` 兜底、Set-Cookie 合并、二次账号校验、原子保存和单飞刷新 -- 确保新会话只有在完整验证后替换旧会话。
- [x] `neteaseAccount.ts` / `AccountManager.ts` -- 统一 HTTP、业务码和账号资料的失败边界 -- 让网络异常与明确失效可区分。
- [x] `GetMusicPlayUrl.ts` / `index.ts` -- 保持实际 IP 和启动初始化链路 -- 让播放和刷新使用一致上下文。
- [x] `tsconfig.json` / `package.json` / `eslint.config.mjs` -- 限制构建与 lint 范围 -- 使验证只覆盖根项目源码。
- [x] 隔离 mock 验证 -- 覆盖旧凭证失效、环境凭证成功、服务端轮换 `MUSIC_U`、网络异常、并发刷新和失败保留旧文件 -- 不访问真实账号。

**Acceptance Criteria:**

- Given 持久化 `MUSIC_U` 经账号接口明确判定失效且 `.env.MUSIC_U` 存在，when 执行刷新，then 使用环境凭证尝试刷新并只在二次账号校验和原子写盘成功后返回成功。
- Given `Set-Cookie` 返回新的 `MUSIC_U`，when 合并刷新响应，then 服务端返回值优先保存，候选值不能覆盖它。
- Given 账号检查发生网络异常，when 执行刷新，then 不切换到 `.env` 候选，旧 Cookie 文件内容保持不变。
- Given 多个调用同时刷新，when 刷新任务尚未结束，then 只产生一个上游刷新请求。
- Given 完成实现，when 执行 `npm run build` 和 `npm run lint`，then 两个命令均成功。

## Implementation Notes

- `CookieManager` 的两个刷新入口共享完整的读取、账号检查、候选选择和刷新任务，不复用已过时的账号检查结果；保留 `refreshed` 兼容返回字段。刷新进行中，`getCookie()` 等待任务结束再读取已保存会话。
- `neteaseAccount.ts` 与 `AccountManager.ts` 使用一致的账号分类：只有业务码 `301/401` 或 `code=200` 且 account/profile 均明确为 null 时判定失效。成功须具备有效账号 ID、资料 ID、昵称和会员类型；HTTP 错误、无效 JSON、缺字段及 `503/429` 等未知业务结果归为不可用，不触发环境兜底。
- 已确认失效后，环境候选直接进入刷新请求；完整响应 Cookie 通过二次账号校验和原子保存后才返回成功。缺失或不完整持久化会话返回 `NEEDS_SESSION_IMPORT`，不会仅凭单独 `MUSIC_U` 自动初始化登录。
- 独立 `Set-Cookie` 头逐项处理；合并头只在逗号后紧跟 Cookie 名称及等号时切分。服务端同名字段覆盖候选；有效 `Max-Age` 优先于 `Expires`，非正数或无有效 `Max-Age` 时的过期日期删除 Cookie，未来日期的空值不自动删除。
- 两个账号请求均传入 10 秒超时信号。刷新请求合并设备默认字段与完整会话字段，HTTP Cookie 和 EAPI 中的 `MUSIC_U/__csrf` 均以调用参数为准；不记录原始错误响应。
- 隔离测试在动态导入前切换到 `/tmp/opencode` 临时目录并设置合成环境，将编译后类的文件路径方法绑定到 fixture，默认阻止所有未计划的网络访问。测试保持真实账号请求方法，mock 传输层；另覆盖播放 IP、原子重命名失败及临时文件清理。

## Verification

- 最终主会话运行 `npm test`（含 `npm run build`）及 `npm run lint` 均通过；36 个测试通过，无失败、无跳过。
- 测试将相关源码依赖转译到隔离临时目录，不依赖已有 `dist`；全量构建另由 `npm test` 的前置步骤完成。
- 已验证 Cookie 边界和删除规则、账号分类和管理状态、延迟账号检查下的并发刷新、读取等待、超时信号和锁释放、真实请求 URL/Cookie/IP 与 EAPI token 往返、重命名失败后的精确旧文件字节及临时文件清理、缺失/不完整会话和播放 IP 转发。
- 未读取真实凭证文件或真实 `.env`，未访问真实账号或线上接口；测试恢复所有 mock 并清理临时目录。

## Review Triage Log

根项目无 VCS，审查材料是相关文件相对空文件的完整快照，不是可追溯到提交的变更差异。以下每条对应一个独立审查发现；重复发现也保留判定。

| 来源/编号      | 判定        | 证据与处理                                                                                                  |
| -------------- | ----------- | ----------------------------------------------------------------------------------------------------------- |
| Blind 1        | high        | 末尾 Expires 令后续 Cookie 丢失；修正边界识别及独立头处理，测试 3–5 通过。                                  |
| Blind 2        | medium      | 非空删除值及未来空值处理错误；修正 Max-Age 优先规则，测试 4–5 通过。                                        |
| Blind 3        | high        | 503/429 会误切换凭证；明确失效码与暂不可用分离，测试 14–19 通过。                                           |
| Blind 4        | high        | 缺失账号对象可被误判或抛错；统一结构分类，测试 9–13 通过。                                                  |
| Blind 5        | high        | 检查结果可能落后于已保存会话；整个流程合并并发，测试 21 通过。                                              |
| Blind 6        | high        | chdir 无法隔离已有 /mnt；测试固定 fixture 路径、导入前隔离环境，测试 1 通过。                               |
| Blind 7        | medium      | 请求无界会占住共享任务；两个请求增加超时，测试 22–24 通过。                                                 |
| Edge 1         | high        | 与 Blind 1 同源，已修复并覆盖末尾 Expires。                                                                 |
| Edge 2         | medium      | 与 Blind 2 同源，未来 Expires 空值不再误删。                                                                |
| Edge 3         | false       | 已选择目录写入失败时明确失败并保留旧会话；自动换目录会分裂存储，并非本次约定的故障恢复行为。                |
| Edge 4         | medium      | 播放读取已有完整 Cookie 不主动查账号，为既有行为；本次在启动/刷新入口恢复，播放自动触发检测记录为后续工作。 |
| Edge 5         | medium      | 播放私有解析函数遇畸形百分号会抛错，为既有行为，已记录后续工作。                                            |
| Edge 6         | medium      | 播放返回体缺少数组及条目校验，为既有行为，已记录后续工作。                                                  |
| Edge 7         | medium      | 与 Blind 7 同源，账号及刷新请求已有 10 秒超时。                                                             |
| Edge 8         | medium      | listen 早于初始化是既有问题，已记录就绪状态后续工作。                                                       |
| Edge 9         | high        | 与 Blind 4 同源，管理状态与刷新共用结构分类，测试 6–20 通过。                                               |
| Edge 10        | maybe-false | 播放确实只发送部分会话字段，但没有线上证据证明额外字段为必需；记录待验证，不宣称协议失效。                  |
| Verification 1 | medium      | 原测试替换账号方法导致请求契约未执行；现在测试真实方法和 mock 传输，测试 6–24 通过。                        |
| Verification 2 | medium      | 原来无播放 IP 断言；测试 36 覆盖 Cookie 初始化和最终传输的 IP。                                             |
| Verification 3 | medium      | 原来无管理状态契约覆盖；测试 6–20、26–28 覆盖有效、失效、不可用、不完整。                                   |
| Verification 4 | medium      | 原来无写盘失败证据；测试 25 注入 rename 失败，校验精确旧字节与临时文件清理。                                |
| Verification 5 | medium      | 原来无 getCookie 覆盖；测试 21 验证等待刷新，26–28 明确缺失/不完整会话需导入，不声称可自动登录。            |

## Acceptance Evidence

- 矩阵有效会话：测试 2；失效兜底、服务端轮换与并发：测试 21；网络/响应异常：测试 6–16、23–24；失败不写盘：测试 25、29–35。
- 所有本次可复现实现问题和验证缺口已修复；既有播放解析、主动恢复、启动就绪及未证实的字段需求记录在 `deferred-work.md`。
- 无 Git 仓库，因此没有创建提交；未启动或部署服务。真实持久化凭证是否失效仍未经线上验证。
