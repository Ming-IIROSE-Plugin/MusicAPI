# MusicAPI：项目分析与网易云协议参考

> 更新：2026-10-16。依据本地源码分析；未使用真实账号、未访问网易云接口，协议线上可用性仍需实测。
> 第三方参考：`api-enhanced`，包版本 `4.41.1`，本地提交 `2db6684`（2026-10-05），449 个 `module/*.js` 文件。分析时其 Git 工作区干净。
> 本文件为项目根目录的 `AGENTS.md`，用于代理自动加载项目上下文；`api-enhanced/AGENTS.md` 另提供第三方参考目录内的局部说明。

## 1. 项目边界与开发约定

- 根项目是 TypeScript + ESM + Node 原生 HTTP 的**网易云播放链接重定向服务**，目前仅实现 `netease` 平台。
- `api-enhanced/` 是独立的第三方参考仓库，使用 CommonJS + Express；根项目没有导入它。参考协议、参数和模块拆分方式，不把它的全部路由、依赖和全局状态直接搬入根项目。
- 根目录已初始化 Git，远端为私有仓库 `jingming295/MusicAPI`，默认分支 `main`；`api-enhanced/` 自带独立 `.git` 且不纳入根仓库。执行版本控制命令前确认所在目录。
- 用户授权（2026-10-16）：本项目修改完成并通过相关检查后，默认提交并 push，无需逐次确认。推送前检查变更范围及凭证排除；此授权不包含强制推送、发布或部署。
- 修改业务实现以 `src/` 为准，`dist/` 是已有编译产物，不能据其存在推断与当前源码同步。源码相对导入采用 `.js` 后缀，匹配 `NodeNext`。
- `data/`、`.env`、Cookie 文件属于运行数据；不要将真实凭证、个人资料或带鉴权参数的音频 URL 写入文档、日志和提交。
- 直接复用第三方代码时保留 `api-enhanced/LICENSE` 要求的 MIT 版权与许可声明。

主要入口：

| 位置                                         | 作用                                                   |
| -------------------------------------------- | ------------------------------------------------------ |
| `src/index.ts`                               | 加载环境变量、注册路由、设置 CORS、监听 `0.0.0.0:9000` |
| `src/routes/router.ts`                       | `METHOD:path` 精确匹配；移除路径末尾一个 `/`           |
| `src/routes/music.ts`                        | 参数读取 → 文件缓存 → 获取播放地址 → HTTP 302          |
| `src/service/musicService.ts`                | 平台分发，目前只有 `netease`                           |
| `src/sendRequest/netease/GetMusicPlayUrl.ts` | 构造旧版播放请求、取回 URL                             |
| `src/sendRequest/netease/NeteaseCrypto.ts`   | EAPI、WEAPI 加密；另有私有 LinuxAPI/解密方法           |
| `src/sendRequest/index.ts`                   | 基于原生 `fetch` 的 GET/POST 包装                      |
| `src/accountManage/netease/`                 | Cookie 落盘、刷新、账号状态                            |
| `src/service/cacheService.ts`                | 音频地址文件缓存和 HEAD 有效性检查                     |

`@meting/core`、`keyv`、`keyv-file` 虽在依赖表中，但上述业务链路没有使用。腾讯、酷狗等 `.d.ts` 的存在也不代表平台已经接入。

## 2. 已实现的对外接口

| 方法和路径                    | 参数 / 行为                                              | 实际返回                                                      |
| ----------------------------- | -------------------------------------------------------- | ------------------------------------------------------------- |
| `GET /`                       | 存活提示；入口未限制此路径的 HTTP 方法                   | 200 文本 `Music Redirect Server Running`                      |
| `GET /musicstreamlink`        | `platform`、`id`、`quality` 必填；`vip=1` 为可选缓存提示 | 成功 302，`Location` 为上游音频地址                           |
| `GET /refresh/login`          | 根据本地保存时间判断是否刷新 Cookie，阈值 24 小时        | 200 JSON，包含 `refreshed`、`message`，可能有 `nextRefreshIn` |
| `GET /netease/account/status` | 查询服务端共享账号                                       | 200 JSON：`account`、`lastRefreshTime`、`status`              |

补充行为：

- 缺少 `platform` 或 `id` 返回 400；缺少 `quality` 在路由内部 `try` 之前抛错，由入口转换为 500；不支持的平台在缓存未命中时抛错并返回 500。
- `quality` 传到 `GetMusicPlayUrl.getUrl()` 的 `_level`，但**没有参与上游请求**；实际固定 `br: 320000`。传 `lossless`、`jymaster` 目前不会请求对应音质，只会生成不同缓存文件。
- `vip=1` **仅改变缓存时长和 HEAD 校验策略**，不选择账号、不校验会员资格，也不传给网易云。账号权益由服务端 Cookie 和上游决定。
- 服务提供地址重定向，没有音频代理、转码、Range 转发功能；CORS 头只作用于本服务响应。
- 入口只对 `https://iirose.com` 或字符串以 `.iirose.com` 结尾的 Origin 返回允许跨域头；所有 OPTIONS 返回 204。CORS 不是接口鉴权，刷新和账号状态路由目前没有鉴权检查。

## 3. 参考项目最值得复用的结构

```text
外部路由 /song/url/v1
  → module/song_url_v1.js：业务参数 + 默认协议
  → util/option.js：请求选项
  → util/request.js：Cookie/指纹 + URL 转换 + 加密 + 网络 + 响应解码
  → util/crypto.js：纯协议算法
```

- 模块基本形式是 `(query, request) => request('/api/…', data, options)`。注入 `request` 很适合离线检查参数，无需账号或真实网络。
- `server.js:getModulesDefinitions()` 将文件名 `_` 转 `/`，例如 `song_url_v1.js` → `/song/url/v1`；`daily_signin`、`fm_trash`、`personal_fm` 保留下划线特例。HTTP 层使用 `app.all`，上游请求层则统一 POST（直接使用 axios 的注册类模块等有例外）。
- `main.js` 导出模块函数，HTTP 与库调用共享业务模块；两种入口的 Cookie/IP 注入行为并不完全一致。
- `createOption(query, defaultCrypto)` 中 `query.crypto` 优先；空协议再由 `APP_CONF.encrypt` 决定，当前默认 EAPI。
- `util/request.js` 统一返回 `{ status, body, cookie }`。HTTP 状态与上游 `body.code` 不是同一个概念：部分业务码（如二维码的 800–803）被映射为 HTTP 200，调用方仍须解析业务码。
- 请求层处理 `MUSIC_U`（登录）和 `MUSIC_A`（游客）、设备字段、`NMTID`、响应加密及显式代理。根项目应优先借鉴这些职责划分。

注意：`util/request.js` 不是所有网络访问的唯一入口。`register_xeapikey.js`、`register_neapikey.js` 等直接调用 axios。源码虽注释“重用 agents”，实际每次请求都调用工厂创建 agent，不能直接视为跨请求复用连接的范例。

## 4. 协议与域名映射

依据：`api-enhanced/util/config.json`、`util/request.js`、`util/crypto.js`。

| 协议       | 当前参考实现的默认目标                     | 请求特点                                                      |
| ---------- | ------------------------------------------ | ------------------------------------------------------------- |
| `api`      | `https://interface.music.163.com/api/…`    | 表单明文参数，Cookie 携带客户端字段                           |
| `weapi`    | `https://music.163.com/weapi/…`            | 双层 AES-CBC + RSA，表单字段 `params`、`encSecKey`            |
| `eapi`     | `https://interfacepc.music.163.com/eapi/…` | MD5 摘要拼接 + AES-128-ECB，表单字段 `params`                 |
| `linuxapi` | `https://music.163.com/api/linux/forward`  | 将目标 URL、POST 方法、参数包入对象后 AES-ECB，字段 `eparams` |
| `xeapi`    | `https://interface3.music.163.com/xeapi/…` | 动态密钥、公钥交换、`C/S/R` 三字段，响应需解密                |
| `neapi`    | `https://interface3.music.163.com/neapi/…` | Zstd + ChaCha20-Poly1305，Base64 容器直接作为请求体           |

本项目 EAPI 使用 `interface.music.163.com`，与参考项目默认的 `interfacepc.music.163.com` 不同。源码差异不等于现有域名失效；需要有控制的线上对照才能选择。

### EAPI：当前项目的核心

逻辑 URI 必须保持 `/api/…`；加密时不要使用网络 URL 的 `/eapi/…` 路径或完整域名。

```text
text   = JSON.stringify(payload)
digest = MD5("nobody" + uri + "use" + text + "md5forencrypt")，小写 hex
plain  = uri + "-36cd479b6b5-" + text + "-36cd479b6b5-" + digest
params = AES-128-ECB(plain, 协议固定 key, PKCS#7).HEX_UPPERCASE
POST /eapi/…，application/x-www-form-urlencoded，body 为 params=…
```

协议常量见两项目的加密源文件，不在此重复复制。根项目用 Node `crypto`，参考项目的 EAPI 用 CryptoJS，但上述封装一致。

- EAPI 的 `payload.header` 与 HTTP Cookie 均携带设备/账号字段：`osver`、`deviceId`、`os`、`appver`、`versioncode`、`buildver`、`resolution`、`__csrf`、`channel`、`requestId`、`MUSIC_U` 或 `MUSIC_A`。
- 当前根项目使用 PC 字段搭配 iPhone User-Agent；参考项目 EAPI 默认也有这种组合，不能仅凭字段混用断言请求必然失败。
- `e_r` 控制**响应**是否加密，不关闭请求加密。根项目固定 `false`，所以直接 `response.json()`；将其设为 `true` 必须同时增加响应解密。
- 参考实现 EAPI/WEAPI 的加密响应走 `eapiResDecrypt()`；`x-aeapi` 场景还需处理 gzip。

### WEAPI：当前账号查询使用

JSON 先用预置 key/IV 做 AES-128-CBC，所得 Base64 字符串再用随机 16 字符密钥做 AES-CBC，输出 Base64 `params`。随机密钥倒序后做无填充 RSA，输出 hex `encSecKey`。`csrf_token` 从 Cookie 的 `__csrf` 注入。

根项目账号查询走 `/weapi/w/nuser/account/get`，对应参考项目 `login_status.js`；不要与 `user_account.js` 的 `/api/nuser/account/get` 混为一条路径。

### XEAPI：新版音质接口的首要参考

关键文件：`module/register_xeapikey.js`、`util/xeapiKey.js`、`util/crypto.js:xeapi`、`util/request.js`。

1. 向 `/api/bsr/sk/get` 请求公钥状态，带设备、版本、时间戳、nonce 和签名；返回签名也会校验，解密后须有 `sk`。
2. 公钥状态保存在 `os.tmpdir()/xeapi_public_key`；请求层懒加载并缓存。仅调用 `main.song_url_v1()` 不等于自动完成全部初始化。
3. 参数先转表单，放入 JSON 信封；删除原 `e_r` 并在信封 `queryString` 里添加 `e_r=true`。
4. `C`：静态 AES-ECB → 随机 XOR/旋转变换 → 动态 AES-ECB，输出 Base64URL。
5. `S`：临时 X25519 密钥交换，经 HMAC-SHA256 派生 AES key，用 AES-GCM 封装动态密钥、OS 和 `sk`，输出 Base64。
6. `R`：加密公钥版本与可选会话 ID；服务端 `x-encr-ssid`、`x-encr-sskey` 会被缓存用于后续请求。
7. HTTP 层补齐 `x-deviceid`、`x-os`、`x-appver`、可选 `x-music-u` 等；响应 AES-ECB 解密后按魔数判断 gzip，最后解析 JSON。

因此，迁移新版播放接口应移植其完整调用链，不能只替换 URI 后继续假定响应为明文 JSON。

### NEAPI：值得保存的新增逆向线索

关键文件：`module/register_neapikey.js`、`util/neapiConfig.js`、`util/neapiKey.js`、`util/zstd.js`、`util/crypto.js`。

- 配置通过 GET `/api/gorilla/algorithm/record?version=…&behavior=open|update` 获取，包含 `file`、`circleTime`。
- 配置解包：Base64 → 前 64 字节 RSA 公钥解包取得 RC4 key → 读取小端载荷长度 → RC4 → Zstd → ECFG 容器。
- ECFG 中包含版本和混淆 Lua 字节码；实现解析常量、指令和 upvalue，从方向标记 `251`/`503` 找出请求/响应各自的 32 字节密钥偏移，而不是固定一个永久 key。
- 请求表单文本先 Zstd 压缩，再 ChaCha20-Poly1305 加密；封装 `CSJM` 魔数、版本、12 字节 nonce、16 字节关联数据和密文长度，整体 Base64 后直接发送，**不是 `params=…`**。
- 密钥配置存于 `os.tmpdir()/neapi_key`。`X-ER` 携带版本；过 `circleTime` 后后台刷新；`X-USER-STATUS` 为 `777`/`999` 时合并并发刷新并至多重试一次。
- `zstd.js` 检测原生 Zstd，缺失时用 `fzstd` 解压和 raw-block 帧编码兜底。接入时须按真实 Node 版本验证依赖，不能只看注释。
- 当前 `song_url_v1.js` 默认是 **XEAPI**，不是 NEAPI；先按所需模块选择协议，不因存在更新协议就全局切换。

## 5. 优先参考的业务模块

以下“默认协议”基于当前 `APP_CONF.encrypt=true`，可被 `query.crypto` 覆盖。

| 能力 / 模块               | 上游逻辑 URI                        | 核心参数 / 默认协议                                                            |
| ------------------------- | ----------------------------------- | ------------------------------------------------------------------------------ |
| `song_url.js`             | `/api/song/enhance/player/url`      | `ids=JSON.stringify(字符串ID数组)`、`br` 默认 999000；EAPI；按输入 ID 重排结果 |
| `song_url_v1.js`          | `/api/song/enhance/player/url/v1`   | `ids`、`level`、`encodeType=flac`；XEAPI                                       |
| `song_download_url_v1.js` | `/api/song/enhance/download/url/v1` | 单个 `id`、`level`、`immerseType`；EAPI；下载与播放接口分开                    |
| `search.js`               | `/api/search/get`                   | `s`、`type`、`limit`、`offset`；EAPI；`type=2000` 另走声音搜索                 |
| `cloudsearch.js`          | `/api/cloudsearch/pc`               | 搜索参数加 `total=true`；EAPI                                                  |
| `song_detail.js`          | `/api/v3/song/detail`               | `c` 是 `[{"id":…}]` 的 JSON 字符串；WEAPI                                      |
| `lyric.js`                | `/api/song/lyric`                   | `id`、各版本参数和 `_nmclfl`；EAPI                                             |
| `lyric_new.js`            | `/api/song/lyric/v1`                | 加 `yv/ytv/yrv` 等逐字歌词参数；EAPI                                           |
| `playlist_detail.js`      | `/api/v6/playlist/detail`           | `id`、`n`、`s`；EAPI                                                           |
| `login_refresh.js`        | `/api/login/token/refresh`          | 空业务对象，登录态由请求层注入；EAPI                                           |
| `login_status.js`         | `/api/w/nuser/account/get`          | WEAPI；返回体额外包一层 `data`                                                 |

音质参考：

- 参考文档列出 `standard`、`higher`、`exhigh`、`lossless`、`hires`、`jyeffect`、`dolby`、`vivid`、`jymaster`、`sky`。这是参考项目的声明，不代表当前账号/歌曲全部可用。
- `vivid` 在模块中改为 `encodeType=mp3`，并设置 Android Cookie 与 `appver=9.5.61`。
- `sky` 添加 `immerseType`，默认 `c51`，参考文档还列出 `c512/ste2/aac2/ste/aac`。
- `level` 是请求音质，最终应查看响应 `level/br/type`；`code=200` 或 URL 非空并不保证完整歌曲或目标音质，还需检查歌曲级 `code`、`freeTrialInfo` 等。
- 参考文档示例有 `expi` 字段，可作为有效期设计线索；应通过实际响应确认单位与语义后设置缓存，不能把示例 1200 当作所有歌曲的固定期限。
- `unblock=true` 分支调用外部 `unblockmusic-utils` 匹配其他来源，且明确表示音质设置不生效。它不是网易云本身授予的高音质能力。

二维码登录可参考 `login_qr_key` → `login_qr_create` → `login_qr_check`：先取 `/api/login/qrcode/unikey`，本地生成登录 URL，再轮询 `/api/login/qrcode/client/login`。参考文档定义业务码 800 过期、801 等扫码、802 等确认、803 成功并返回 Cookie；当前根项目尚无扫码登录实现。

## 6. 当前项目已确认的问题与修复优先级

以下是分析发现，不表示本次已修改业务代码。

| 优先级 | 源码事实与影响                                                                                                                | 建议方向                                                                                   |
| ------ | ----------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| 高     | `GetMusicPlayUrl.ts` 忽略 `_level`，固定 `br=320000`                                                                          | 接入 `level` 对应的新版链路，返回实际音质元数据                                            |
| 高     | 缓存路径直接拼接未经校验的 `platform/id/quality`，缓存查询发生在平台校验之前；`..` 可使路径越出歌曲缓存目录                   | 在缓存访问前校验平台、数字 ID 和音质枚举，验证路径位于缓存根内                             |
| 高     | `CookieManager.refreshCookie()` 把 `headers.get('set-cookie')` 的合并字符串直接保存；读取时正则兼容逗号但不是完整 Cookie 解析 | 按独立 Set-Cookie 解析 name/value，与旧 Cookie 合并，正确处理 Expires 中的逗号、删除及更新 |
| 高     | HTTP 与业务成功但没有 Set-Cookie 时仍返回 `true`；落盘失败被 `setCookie()` 吞掉，外层仍可能报告成功                           | 将上游成功、Cookie 更新、持久化成功分别表达，避免假刷新成功                                |
| 中     | `getCookie()` 只在文件不存在时刷新，文件过期/损坏时不会自动刷新；24 小时判断只在 `/refresh/login` 调用链中，没有定时任务      | 统一读取、失效判断与刷新策略，明确按需还是定时                                             |
| 中     | 首次播放调用 `getCookie()` 未传 `ip`，其内部刷新默认 `127.0.0.1`；多个刷新入口共享布尔锁，`refreshCookie()` 自身不阻止重入    | 传入一致上下文；使用共享 Promise 合并并发刷新                                              |
| 中     | 先 `listen` 再获取公网 IP/刷新 Cookie，末尾 `CookieManager.getCookie()` 未 await                                              | 把依赖初始化和就绪状态表达清楚，处理启动失败                                               |
| 中     | `REFRESH_COOKIE_NETEASE` 按字符串 truthy 判断，配置为 `false` 也会刷新                                                        | 显式解析布尔值                                                                             |
| 中     | 仅凭 `/mnt` 存在就选择 `/mnt/account/netease/cookie.json` 与 `/mnt/cache/song/…`                                              | 配置明确的数据根目录，检查权限与是否真有持久卷                                             |
| 中     | 缓存 TTL 固定普通 45 分钟、VIP 20 分钟；key 不含账号或 `vip`，调用者可改变读取策略                                            | 按上游有效期和账号上下文设计 key/TTL；区分请求音质与实际音质                               |
| 中     | 缓存写入为非原子异步写，缺少同曲并发请求合并；普通缓存超过 30 分钟后每次读取可能发 HEAD                                       | 原子替换、请求合并，记录校验时间；正确释放 HEAD 响应资源                                   |
| 中     | `SendRequest` 支持 AbortSignal，但业务调用未提供超时；公网 IP 查询也无超时                                                    | 统一超时、错误分类和有限重试策略                                                           |
| 中     | 播放层只保留 URL，丢弃歌曲级状态、试听、音质和期限；账号查询不先判断 `response.ok`                                            | 定义可校验的响应类型，区分 HTTP、业务、权益和解析错误                                      |
| 中     | `/refresh/login` 与 `/netease/account/status` 直接操作/暴露共享账号信息，无鉴权                                               | 明确接口的访问边界，管理接口增加鉴权                                                       |

路径问题的离线复现：`path.join('/mnt','cache','song','../../outside','1_exhigh.json')` 得到 `/mnt/outside/1_exhigh.json`。这是路径计算验证，没有读取、写入或删除对应文件；实际请求能否走到特定写入/删除分支取决于后续条件。

## 7. 参考代码也有缺陷，不能照单全收

- **首次初始化顺序**：`generateConfig()` 先注册匿名账号，再获取 XEAPI 公钥；但 `register_anonimous.js` 默认已经使用 XEAPI。无公钥缓存时第一次匿名注册会失败，错误被捕获后才获取公钥，当前流程没有再试匿名注册。
- **匿名 token 快照**：`util/request.js` 在模块加载时把 `anonymous_token` 读入常量。随后更新文件不等于更新内存 token，需要显式重载或改成可更新状态。
- **环境 Cookie 回退可能失效**：`createOption` 使用 `query.cookie || NETEASE_COOKIE`，但 `main.js` 和 HTTP 入口通常传入空对象 `{}`；其为 truthy，因此不能假设未传 Cookie 一定使用环境变量。
- **布尔选项丢失**：`createOption` 使用 `query.e_r || undefined`，显式布尔 `false` 会丢失；当前默认响应不加密时不明显，但切换默认配置后会影响行为。
- **二维码错误分支异常**：`login_qr_check.js` 的 `catch` 引用在 `try` 内声明的 `result`，上游失败时会再抛 `ReferenceError`。离线已复现。
- **所谓通用解锁需核实**：`server.js` 在直接 `app.all('/song/url/v1', …)` 的处理器中用 `req.baseUrl === '/song/url/v1'` 判断；应在真实路由环境验证是否能触发，不能只凭注释认定功能生效。
- **Cookie 工具并不完备**：`util/index.js:cookieToJson()` 用 `split('=')` 且只接受长度 2，会丢弃值中含 `=` 的 Cookie；不应作为通用解析器直接复用。
- **测试范围有限**：`main.test.js` 只检查三个导出函数是否存在，不验证协议正确性；`test/music_url.test.js` 使用真实上游，主要检查 URL 非空，不验证音质、试听或有效期。
- 该目录的 `AGENTS.md` 未列出 NEAPI，关于 XEAPI 公钥加载时机等描述也与当前源码有差异。冲突时以对应实现和验证结果为依据。

## 8. 本次验证与后续工作顺序

本次已完成的离线检查（没有安装依赖、启动服务或访问真实账号）：

1. 使用虚拟 `request` 执行参考播放模块，验证旧版默认 `br=999000`、返回 ID 排序、新版默认 XEAPI、`vivid` 的 MP3/Android 参数、`sky` 的默认 `c51`。
2. 使用现有 `dist/NeteaseCrypto` 和合成数据做 EAPI 加密/解密检查，核对解出的 URI、JSON 和 MD5 拼接结构与两项目源码一致。该检查仅证明这条封装行为，不证明整个构建或线上互通。
3. 用纯值计算复现缓存路径越界、`e_r=false` 丢失，用虚拟失败请求复现二维码 `catch` 中的 `ReferenceError`。

建议后续顺序：

1. 先解决参数/缓存路径校验、Cookie 解析与刷新结果真实性。
2. 提取统一的网易云请求上下文：账号、设备、IP、协议、超时、错误解码。
3. 完成 XEAPI 初始化与响应解码后接入 `song_url_v1`，用实际账号可用的音质验证返回 `level/br/type/freeTrialInfo`。
4. 保留结构化播放结果，再设计基于上游期限的缓存；需要时逐步补搜索、歌曲详情和歌词。
5. 只有目标接口确实需要时再实现 NEAPI；记录脱敏请求形状、响应结构、测试日期和参考提交，避免把一次成功当作长期协议保证。

## 9. 构建与环境事实

- 根项目脚本：`npm run dev` → `tsx watch src/index.ts`；`npm run build` → `tsc`；`npm start` → `node dist/index.js`；`npm run lint` → `eslint . --ext .ts`。当前没有 test 脚本。
- **`tsx` 没有在根 `package.json` 中声明**，不能假定干净安装后开发命令可用。根目录同时有 `package-lock.json` 和 `yarn.lock`，不要未经确认删除其中之一。
- `tsconfig.json` 设置 `rootDir=src`、`outDir=dist`，但未设置 `include/exclude`；默认文件发现可能纳入 `api-enhanced/module_example/test.ts` 等目录外 TypeScript，需用实际类型检查确认后收窄范围。
- 根 ESLint 配置没有排除参考仓库和 `dist`；项目级检查前需确认扫描范围，避免混入第三方检查结果。
- 本次工具实际报告 Node **v20.19.2**；两个项目目录均没有 `node_modules`。因此未运行完整构建、lint 或上游集成测试，不能宣称它们通过。
- 本机 `/mnt` 存在，因此按当前代码运行会选择 `/mnt` 数据目录，而不是项目中的 `data/`。
- 参考项目开发约定使用 pnpm，详细命令见其 `AGENTS.md`；不要把该约定直接当作根项目的包管理器约定。
