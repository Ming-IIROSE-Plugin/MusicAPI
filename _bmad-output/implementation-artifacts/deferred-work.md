# 后续工作

- source_spec: `spec-netease-session-fallback.md`
  summary: 播放路径对已有完整但失效会话增加按需账号检测与恢复策略。
  evidence: 既有 getCookie 仅对缺失字段触发刷新；当前恢复由启动或 refresh/login 触发，避免每次播放额外查询的策略尚未实现。
- source_spec: `spec-netease-session-fallback.md`
  summary: 统一播放 Cookie 百分号解码和播放上游响应结构校验。
  evidence: GetMusicPlayUrl 的既有 decodeURIComponent 可抛错，响应只校验 length 未验证数组及首条对象。
- source_spec: `spec-netease-session-fallback.md`
  summary: 明确服务初始化完成后的就绪状态。
  evidence: index.ts 既有 listen 回调才获取 IP 和初始化 Cookie；请求可能先于初始化完成到达。
- source_spec: `spec-netease-session-fallback.md`
  summary: 验证播放是否需要 MUSIC_U/__csrf 之外的会话字段（medium，未验证）。
  evidence: 播放仅取上述两字段，尚无脱敏线上对照证明丢弃额外 Cookie 会造成失败；需要控制变量实测才能确认。
