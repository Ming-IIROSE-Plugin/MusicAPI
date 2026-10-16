# MusicAPI

TypeScript + Node.js 网易云歌曲播放链接重定向服务。成功请求返回 HTTP 302，音频由网易云提供。

## 本地运行

```bash
npm ci
cp .env.example .env
npm run build
npm start
```

服务监听 `0.0.0.0:9000`。本项目已在 Node.js 20 环境验证；不包含运行凭证。

| 接口                                                                | 用途                 |
| ------------------------------------------------------------------- | -------------------- |
| `GET /`                                                             | 存活检查             |
| `GET /musicstreamlink?platform=netease&id=431259256&quality=higher` | 获取歌曲链接并重定向 |
| `GET /refresh/login`                                                | 检查会话并按策略刷新 |
| `GET /netease/account/status`                                       | 查询共享账号状态     |

`quality` 当前未接入上游音质选择，实际请求固定 `br=320000`。

## 会话配置

持久化格式为 `{ "cookie": "完整 Cookie 字符串", "date": 保存时间的毫秒时间戳 }`。当 `/mnt/account/netease` 目录存在时读取其中的 `cookie.json`，否则使用项目 `data/account/netease/cookie.json`。

`.env` 按当前工作目录查找 `.env`，已有进程环境变量优先。`MUSIC_U` 用于已确认失效、缺失或不完整持久化会话的刷新候选；候选只携带该 token，不会混入旧会话的 `__csrf` 或其他登录字段。单独的 `MUSIC_U` 只是刷新尝试，刷新响应还必须包含完整 Cookie、通过账号校验并成功原子保存，不能视为首次登录保证。`REFRESH_COOKIE_NETEASE=true` 启用启动检查和刷新，也兼容 `1/t/yes`。

启动会显示配置来源、Cookie 存储路径、会话选择原因和结果摘要。设置 `DEBUG_NETEASE=true` 可显示带时间、HTTP/业务码、耗时、错误分类和字段存在性的脱敏阶段日志；不会输出凭证、Cookie 原文、密文、响应头、上游原文或音频 URL。`NETEASE_COOKIE_FILE` 可指定 Cookie 文件路径，`PORT` 可覆盖默认端口 `9000`。端口仅接受 `0..65535` 的纯数字；`0` 由系统分配，日志显示实际端口。非法配置以固定提示回退至 `9000`，不打印原始值。

刷新成功后以服务端返回的 Cookie 为准，通过账号复核后原子保存。网络异常、响应不合法或写盘失败保留旧文件。真实 Cookie、环境变量和缓存不进入版本控制。

## 验证与文档

```bash
npm test
npm run lint
```

`npm test` 包含构建和隔离测试。测试使用合成凭证、禁止未计划的网络访问；当前测试临时目录使用 `/tmp/opencode`，执行前需确保该目录存在且可写。

- [项目分析与协议参考](AGENTS.md)
- [会话兜底实现与验证记录](_bmad-output/implementation-artifacts/spec-netease-session-fallback.md)
- [环境凭证初始化与 debug 修复](_bmad-output/implementation-artifacts/spec-env-bootstrap-debug.md)
- [后续工作](_bmad-output/implementation-artifacts/deferred-work.md)

项目包含 BMAD Core + BMM 的配置、技能和规划文档；本地用户配置及生成的工作流快照不上传。

第三方协议参考来自 [api-enhanced](https://github.com/NeteaseCloudMusicApiEnhanced/api-enhanced)，参考提交为 `2db6684453297ee86dec0492842f2320b08182d9`（包版本 `4.41.1`）。其独立工作目录不纳入本仓库，也不是根服务的运行依赖；如需研究，可另行克隆到 `api-enhanced/`。
