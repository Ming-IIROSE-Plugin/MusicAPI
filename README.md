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

`.env` 的 `MUSIC_U` 用于已确认失效会话的刷新候选。缺失或不完整的持久化会话需要导入完整 Cookie；不会仅凭单个 `MUSIC_U` 自动完成首次登录。`REFRESH_COOKIE_NETEASE=true` 启用启动刷新，也兼容 `1/t/yes`。

刷新成功后以服务端返回的 Cookie 为准，通过账号复核后原子保存。网络异常、响应不合法或写盘失败保留旧文件。真实 Cookie、环境变量和缓存不进入版本控制。

## 验证与文档

```bash
npm test
npm run lint
```

`npm test` 包含构建和隔离测试。测试使用合成凭证、禁止未计划的网络访问；当前测试临时目录使用 `/tmp/opencode`，执行前需确保该目录存在且可写。

- [项目分析与协议参考](AGENTS.md)
- [会话兜底实现与验证记录](_bmad-output/implementation-artifacts/spec-netease-session-fallback.md)
- [后续工作](_bmad-output/implementation-artifacts/deferred-work.md)

项目包含 BMAD Core + BMM 的配置、技能和规划文档；本地用户配置及生成的工作流快照不上传。

第三方协议参考来自 [api-enhanced](https://github.com/NeteaseCloudMusicApiEnhanced/api-enhanced)，参考提交为 `2db6684453297ee86dec0492842f2320b08182d9`（包版本 `4.41.1`）。其独立工作目录不纳入本仓库，也不是根服务的运行依赖；如需研究，可另行克隆到 `api-enhanced/`。
