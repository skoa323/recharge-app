# ChatGPT 代理充值 · 前端控制台

> 一份「网页前端 + Node 中间代理」的方案,用来对接 `chongzhi.pro` 的代理充值 API。
> **API Key 仅存放在服务端环境变量中,前端永远拿不到。**

## 架构

```
浏览器 (public/index.html)
        │   仅调用本地 /api/* 路径
        ▼
Node + Express (server/server.js)   ← UPSTREAM_API_KEY 在这里(环境变量)
        │   Bearer Key 由本层附加
        ▼
   chongzhi.pro 上游
```

## 功能

| 模块 | 接口 | 说明 |
|---|---|---|
| 校验激活码 | `POST /api/validate-code` | 纯本地校验前缀和长度,不打远端,确认 plus / pro / prolite |
| 校验 JSON | `POST /api/validate-json` | 校验 user_data 是否包含 `account.id` / `accessToken` 等关键字段 |
| 充值 | `POST /api/recharge` | 调用首次接口,失败且 `reuse_only=true` 时**自动切到复用接口** |
| 查询 | `POST /api/query` | 借助复用接口的幂等响应判断卡密当前状态(已成功 / 失败 / 未使用 / 不存在) |

历史记录(每次充值与查询的结果)保存在浏览器 `localStorage` 中,不会发送到任何服务器,清缓存即丢。

## 目录

```
recharge-app/
├── package.json
├── .env.example          ← 复制为 .env 填 KEY
├── server/
│   └── server.js         ← Node 中间代理
└── public/
    └── index.html        ← 前端单页
```

## 启动步骤

需要 **Node.js ≥ 18**(用了内置的 `fetch` / `AbortSignal.timeout`)。

```bash
# 1. 安装依赖
cd recharge-app
npm install

# 2. 配置 API Key(任选一种)
# ── 方式 A:导出环境变量
export UPSTREAM_API_KEY="ak_live_你的真实KEY"
export UPSTREAM_UA="my-agent-client/1.0"

# ── 方式 B:用 .env(需要额外装一个 dotenv 或者直接 source)
cp .env.example .env
# 编辑 .env 填入 KEY,然后:
set -a && source .env && set +a

# 3. 启动
npm start

# 4. 浏览器访问
# → http://localhost:3000
```

## 部署到生产

- **HTTPS**:务必上 HTTPS。可以用 Nginx / Caddy 反向代理到 `localhost:3000`
- **CORS**:`server.js` 默认 `cors()` 全开,生产环境改为白名单:
  ```js
  app.use(cors({ origin: ['https://your.domain'] }));
  ```
- **限流**:可加 `express-rate-limit`,避免 Key 被滥用消耗
- **日志**:建议把 `console.log` 改写到文件或日志服务,记录 `record_id` / `order_id` 用于对账
- **认证**:若不希望任何人都能用你的代理,在 `/api/*` 前加一层登录态(账号密码 / Token / OAuth)

## 安全说明

✅ API Key 永远不会出现在:
- 浏览器 DevTools → Network 面板的请求头里(请求只发到 `/api/*`)
- 浏览器 DevTools → Sources 面板的代码里
- 浏览器 localStorage / cookie
- 任何 HTML / JS 静态资源中

⚠️ 但是要注意:
- **任何能访问你的代理服务的人都能"借用" Key**。如果代理服务直接挂在公网且无认证,等同于裸奔。生产环境必须加访问控制。
- localStorage 中的历史记录如果包含 `accessToken` 等敏感字段,需评估泄漏风险。本前端默认仅存激活码、订单号、record_id、message 这些非敏感字段。

## 常见问题

**Q: 启动后访问页面右上角显示 "proxy unreachable"?**
A: Node 服务没启动成功,或者端口被占用。检查终端日志。

**Q: 充值时报 "Unauthorized: missing or invalid API key"?**
A: 环境变量 `UPSTREAM_API_KEY` 没生效。检查启动 Node 的那个 shell 是否真的 export 了。

**Q: 浏览器里 fetch 卡住超过 1 分钟?**
A: 文档里说明上游内部最多重试可能要 90 秒,前端默认不会断,等就行。Node 这边设置了 180 秒超时。

**Q: 我能不能跳过 Node 直接从浏览器调 `chongzhi.pro`?**
A: 不行,这就是写中间代理的原因。直调会:
1. CORS 报错(上游不会给你设 `Access-Control-Allow-Origin`)
2. Cloudflare 拦默认 UA(浏览器 UA 是不是会被拦看运气)
3. **Key 暴露给所有用户**(最致命)
