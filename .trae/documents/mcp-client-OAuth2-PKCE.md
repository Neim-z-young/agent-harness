# mcp-client：OAuth2 PKCE 授权码 + token 加密持久化

## Context

用户主攻剩余方向之一「OAuth2 PKCE / MCP OAuth 授权」。当前 `packages/plugins/mcp-client` 对接 HTTP/SSE transport 时仅支持静态 Bearer Token(`McpAuthConfig.bearerToken`/`authorizationHeader`),无法对接 OAuth2 保护的 MCP Server。本计划为 mcp-client 增加 OAuth2 授权码 + PKCE 能力,并把 token 加密持久化。

**已确定形态(用户决策)**:
- 授权码:**打印授权 URL + 浏览器授权后把回调 URL 里的 `code` 粘贴回 REPL**(不做本地回调服务器)。
- 端点:**well-known 自动发现**(`GET {baseUrl}/.well-known/oauth-authorization-server`,RFC 8414/MCP OAuth 元数据);显式配置端点时可跳过 discovery。公共客户端用 PKCE S256,无 client_secret。
- token:**加密持久化到 dataDir**(`dataDir/oauth-tokens.json`),重启不丢;access 过期用 refresh_token 自动刷新。

**约束**:保持插件化——OAuth 全部沉淀在 mcp-client 内,mcp-server-registry 与 `.harness/plugins` 装配仅透传配置,不耦合 core/cli。

## 关键复用(已验证)

- `@harness/workspace` 导出 `SecretCipher`(AES-256-GCM,主密钥 `env HARNESS_CONFIG_KEY` > `dataDir/.config-key`)、`resolveWorkspace`、`defaultUserDir`、`dataFiles`([workspace/src/storage.ts](file:///Users/oyoungy/Documents/project/XiaoZhi-new/packages/workspace/src/storage.ts#L126))。token 加密封装用 `new SecretCipher(resolveWorkspace({ dataDir }))`。
- mcp-client transport 鉴权注入点:模块私有 `buildAuthHeaders(auth?)`([index.ts](file:///Users/oyoungy/Documents/project/XiaoZhi-new/packages/plugins/mcp-client/src/index.ts#L162))被 `HttpTransport.send`/`SseTransport.connectSse|send` 同步调用。

## 模块划分(mcp-client 内新增 2 源文件 + 测试)

```
packages/plugins/mcp-client/src/
  index.ts        改:类型 + transport 集成 + factory + plugin options
  oauth.ts        新:PKCE/discovery/exchange/refresh/OAuthFlow(ensureAccessToken 编排)
  token-store.ts  新:OAuthTokenStore 加密持久化
  oauth.test.ts   新:单测
  token-store.test.ts 新:加解密 roundtrip 单测
```

**`oauth.ts`**(纯逻辑 + 交互注入,关键导出):
- `discoverOAuthMetadata(baseUrl, fetchImpl)` → `McpOauthServerMetadata`(authorization_endpoint/token_endpoint/scopes_supported/…)。有显式端点时跳过 discovery。
- `generatePkce()` → `{ verifier, challenge }`;`createPkceChallenge(verifier)` = base64url(SHA256)。
- `exchangeAuthorizationCode({tokenEndpoint, clientId, code, codeVerifier, redirectUri, fetchImpl})` → `McpToken`。
- `refreshOAuthToken({tokenEndpoint, clientId, refreshToken, fetchImpl})` → `McpToken`。
- `buildAuthorizationUrl(meta, oauth, challenge)`。
- `class OAuthFlow{ constructor({serverKey, baseUrl, oauth, store, fetchImpl, readCode, log}) }`:
  - `ensureAccessToken({refresh?})` → 明文 access_token;命中缓存/磁盘直接返回;否则 refresh;再否则交互授权;**pending 并发去重**。
  - `reauthorize()`(清缓存 + 重新交互);`readonly token`。
  - 交互:打印授权 URL → `readCode()`(注入,缺省读 stdin 一行)→ 解析出 `code`(`redirect_uri` 固定 `http://localhost` 仅作 token 请求参数)→ exchange → merged `{...token, obtained_at: Date.now()}` → 落盘。

**`token-store.ts`**:
- `class OAuthTokenStore{ constructor(dataDir) }`;`load(serverKey)`/`save(serverKey, token)`/`clear(serverKey)`/`hasStored`。
- 每 server 一项 `{ enc?: string }`,值 = `cipher.encrypt(JSON.stringify(token))`(含 access/refresh/expires 全字段);文件 `dataDir/oauth-tokens.json`。`serverKey` = base64url(sha256(baseUrl))。解密失败(密钥不一致)抛错,由 OAuthFlow 捕获回落重授权。

## 类型扩展

```ts
interface McpOauthConfig {
  discoveryUrl?: string      // 缺省 = McpServerConfig.url
  clientId?: string          // 公共客户端可省略
  tokenEndpoint?: string     // 设置则跳过 discovery
  authorizationEndpoint?: string
  scopes?: string[]
}
interface McpToken { access_token; refresh_token?; token_type?; expires_in?; scope?; obtained_at? }
interface McpAuthConfig {   // 向后兼容扩展
  bearerToken?; authorizationHeader?; headers?; oauth?: McpOauthConfig
}
```

## transport / factory 集成(改 `index.ts`)

- `buildAuthHeaders` 改为 **async** 并接收可选 `oauthResolver?: ({refresh?}) => Promise<string>`(oauth 存在时优先取 resolver 的 token)。
- `HttpTransport`/`SseTransport` 增私有 `oauthResolver`(构造透传),`send`/`connectSse` 改 `await buildAuthHeaders(this.auth, this.oauthResolver)`。
- **401/403 只对 HttpTransport 重试一次**(强制 refresh 后重发,再失败抛错);SseTransport 不做发送级重试(靠 `connectSse` 时 ensureToken 一次)。
- `defaultTransportFactory(config, ctx?)`:新增 `TransportFactoryContext { dataDir?; fetchImpl?; readCode?; log? }`。transport 为 http/sse 且 `config.auth?.oauth` 时,构造 `new OAuthFlow({ serverKey, baseUrl, oauth, store: new OAuthTokenStore(ctx.dataDir ?? defaultUserDir()), ... }).ensureAccessToken` 注入;非 OAuth 路径行为等价现状。
- `createMcpClientPlugin(options)` 增 `dataDir?`,内部透传 factory。

## mcp-server-registry 透传

[mcp-server-registry/src/index.ts](file:///Users/oyoungy/Documents/project/XiaoZhi-new/packages/plugins/mcp-server-registry/src/index.ts#L120):`defaultTransportFactory(item.config)` 改为带上下文;`createMcpServerRegistryPlugin` 增 `dataDir?` 选项;`McpServerRegistration` 增可选 `dataDir?`(进程内插件可填),装配层把已解析的 workspace dataDir 传入。cli 主逻辑仅透传。

## 实施顺序(每步可测)

1. **依赖**:mcp-client `package.json` 加 `@harness/workspace`;验证根 `tsconfig.json` paths;`bun install`。先建 `OAuthTokenStore` + `token-store.test.ts`。
2. **oauth.ts 纯函数**:PKCE/discovery/exchange/refresh/buildAuthorizationUrl(全部 `fetchImpl` 可注入,无交互)+ `oauth.test.ts`。
3. **类型 + `OAuthFlow`** 交互编排(`readCode`/`log` 注入,pending 去重)+ 测试。
4. **transport 集成**:`buildAuthHeaders` 异步 + 两 transport 接收 resolver + Http 401 重试;补 `index.test.ts`。
5. **factory**:`TransportFactoryContext` + `defaultTransportFactory(config, ctx)` 装配 OAuthFlow;`createMcpClientPlugin` 透传 `dataDir`。
6. **registry 透传** 上下文。
7. **文档**:代码注释 + development-log「续 77」。

每步收尾:`cd packages/plugins/mcp-client && bun test && bun run typecheck`。依赖方向:`workspace → token-store → oauth 纯函数 → OAuthFlow → transport → factory → registry`。

## 验证

- `packages/plugins/mcp-client`:discovery(含 404 回退)、PKCE challenge 定长 43 无 padding、授权码换 token(POST form body 断言)、refresh 覆盖、ensureToken 缓存命中不发网络、过期交互 + `readCode`、401 重试一次、并发去重、加解密 roundtrip、现有 bearerToken 回归。
- 用本地 `node:http` 小 server 承担 `/oauth/.well-known/...` 与 token endpoint(或注入 `fetchImpl` 内存路由)。
- `bun test`(全量,确认无回归)+ `bun run typecheck`;mcp-client 与 mcp-server-registry 用例全绿。
- 提交 `feat(mcp-client): OAuth2 PKCE 授权码 + token 加密持久化`,更新 development-log。