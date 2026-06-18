# cloud-oidc-sso-hub

Cloudflare Worker OIDC Provider for OpenAI Custom OIDC SSO.

本 fork 的最终路径是共享多租户 Worker：

- 一个 Worker：默认 `cloud-oidc-sso-hub`
- 一个 KV namespace：保存 auth code、access token、API 创建的同域用户
- 一套 secrets：`CLIENT_SECRET`、`GLOBAL_PIN`、`ADMIN_TOKEN`、`REGISTER_INVITE_CODE`、JWT key
- 一个 tenant registry：`TENANT_CONFIGS_JSON`

没有单租户 vars 兜底。缺少 `TENANT_CONFIGS_JSON` 或请求 host 没匹配 tenant 时，Worker 返回 `404 Tenant is not configured.`

## Endpoints

- `/.well-known/openid-configuration`
- `/jwks.json`
- `/authorize`
- `/login`
- `/token`
- `/userinfo`
- `/api/register`
- `/api/login`
- `/health`
- `/healthz`

`/authorize` + `/login` 是人工 PIN 登录路径。协议自动化走 `/api/register` 或 `/api/login`。

## Tenant Registry

`TENANT_CONFIGS_JSON` 是 JSON 字符串，key 是 issuer host：

```json
{
  "auth.example.com": {
    "issuer": "https://auth.example.com",
    "client_id": "openai-enterprise-sso",
    "allowed_email_domain": "example.com",
    "allowed_redirect_uri": "https://external.auth.openai.com/sso/oidc/YOUR_CALLBACK_ID/callback",
    "zone_name": "example.com",
    "shortcut_host": "go.example.com",
    "app_login_url": "https://chatgpt.com/auth/login?sso=true&connection=conn_YOUR_CONNECTION_ID",
    "idp_name": "Example SSO"
  }
}
```

Worker 会按请求 host 匹配：

- tenant key，例如 `auth.example.com`
- tenant `issuer` 的 hostname
- tenant `shortcut_host`

`shortcut_host` 命中时会 302 到 `app_login_url`。

## Setup Script

配置文件是主入口。真实配置写到 `config/tenants.json`，这个文件不会进入 Git。

```bash
npm run cloud-oidc -- config init
npm run cloud-oidc -- config add \
  --domain research.example.com \
  --zone example.com \
  --callback "https://external.auth.openai.com/sso/oidc/YOUR_CALLBACK_ID/callback" \
  --setup-url "https://setup.auth.openai.com/.../sso/conn_YOUR_CONNECTION_ID/custom-oidc"
```

部署或只生成文件：

```bash
npm run cloud-oidc -- setup
npm run cloud-oidc -- setup --skip-deploy
```

需要固定 secrets 时用环境变量，不要写进 tracked 文件：

```bash
export OIDC_PIN="..."
export OIDC_SSO_ADMIN_TOKEN="..."
export OIDC_SSO_INVITE_CODE="..."
```

底层单 tenant setup 仍可直接调用：

```bash
npm run setup:sso -- \
  --domain example.com \
  --callback "https://external.auth.openai.com/sso/oidc/YOUR_CALLBACK_ID/callback" \
  --setup-url "https://setup.auth.openai.com/.../sso/conn_YOUR_CONNECTION_ID/custom-oidc"
```

子域作为 OpenAI 已验证域名时：

```bash
npm run setup:sso -- \
  --domain research.example.com \
  --zone example.com \
  --callback "https://external.auth.openai.com/sso/oidc/YOUR_CALLBACK_ID/callback" \
  --connection-id "conn_YOUR_CONNECTION_ID"
```

脚本会：

- 创建或复用 KV namespace
- 生成或复用 `.secrets-cloud-oidc-sso-hub/`
- upsert `.generated/cloud-oidc-sso-hub/tenants.json`
- 生成 `.generated/cloud-oidc-sso-hub/wrangler.jsonc`
- 上传 secrets
- 部署同一个 Worker
- 创建 issuer host 和 shortcut host 的 proxied DNS
- smoke discovery 和 JWKS

只生成本地文件：

```bash
npm run setup:sso -- \
  --domain example.com \
  --callback "https://external.auth.openai.com/sso/oidc/YOUR_CALLBACK_ID/callback" \
  --connection-id "conn_YOUR_CONNECTION_ID" \
  --no-deploy \
  --yes
```

Cloudflare 自动化需要 `CLOUDFLARE_API_TOKEN`，或 `CLOUDFLARE_EMAIL` + `CLOUDFLARE_GLOBAL_API_KEY`。Wrangler deploy 可以使用已有 `wrangler login`，但 KV/DNS 自动化需要 Cloudflare API 凭据。

## OpenAI Admin Bootstrap

`cloud-oidc openai bootstrap` 是给本机 agent 使用的一条龙入口。它复用当前 macOS Google Chrome 登录态，不启动 headless，也不新建浏览器 profile。

```bash
OIDC_PIN="abc123" npm run cloud-oidc -- openai bootstrap \
  --domain pokeface.0day3.com \
  --zone 0day3.com \
  --cf-envchain cf-migrate-target
```

它会按顺序执行：

- 打开当前 Chrome 的 `admin.openai.com` 访问控制页面
- 添加并验证 OpenAI 域名
- 读取 OpenAI 给出的 DNS TXT，并写入 Cloudflare
- 打开或创建 ChatGPT Custom OIDC SSO
- 抽取 OpenAI callback/setup URL，写回 `config/tenants.json`
- 运行共享 Worker setup，部署 Worker、DNS、KV 和 secrets
- 回到 OpenAI Custom OIDC 页面填写 Client ID、Client Secret、Discovery Endpoint
- 用 Worker PIN 登录完成 OpenAI SSO 测试

常用跳过项：

```bash
# 只使用现有 callback/setup URL，跳过 OpenAI 域名创建
npm run cloud-oidc -- openai bootstrap --domain pokeface.0day3.com --zone 0day3.com --skip-domain

# 只准备 OpenAI config，不部署 Worker
npm run cloud-oidc -- openai bootstrap --domain pokeface.0day3.com --zone 0day3.com --skip-worker

# 只做到 Worker 部署，不填回 OpenAI Step 4
npm run cloud-oidc -- openai bootstrap --domain pokeface.0day3.com --zone 0day3.com --skip-openai-fill
```

调试当前浏览器页面：

```bash
npm run cloud-oidc -- openai snapshot
```

如果 OpenAI Admin UI 文案或结构变化，脚本会把当前页面快照写到 `.generated/cloud-oidc-sso-hub/openai-admin-*.json`，后续 agent 直接看这个文件补选择器即可。

## OpenAI Values

把 setup 输出填回 OpenAI Custom OIDC Step 4：

- `Client ID`: 默认 `openai-enterprise-sso`
- `Client Secret`: `.secrets-cloud-oidc-sso-hub/openai-client-secret.txt`
- `Discovery Endpoint`: `https://<issuer-host>/.well-known/openid-configuration`

macOS 复制 client secret：

```bash
pbcopy < .secrets-cloud-oidc-sso-hub/openai-client-secret.txt
```

## Management API

所有管理 API 请求必须带：

```http
Authorization: Bearer <ADMIN_TOKEN>
Content-Type: application/json
```

### `POST /api/register`

创建或确认同域用户存在。若 body 带 OIDC authorize 参数，会直接返回 OpenAI callback URL。

```json
{
  "account": "seed001",
  "invite_code": "JOIN-2026",
  "client_id": "openai-enterprise-sso",
  "redirect_uri": "https://external.auth.openai.com/sso/oidc/.../callback",
  "scope": "openid profile email",
  "state": "...",
  "nonce": "..."
}
```

响应：

```json
{
  "ok": true,
  "user": {
    "email": "seed001@example.com",
    "account": "seed001",
    "created": true
  },
  "redirect_uri": "https://external.auth.openai.com/sso/oidc/.../callback?code=...&state=..."
}
```

如果配置了 `REGISTER_INVITE_CODE`，body 里的 `invite_code` 必须匹配。

### `POST /api/login`

只登录已经通过 `/api/register` 创建过的账号。请求体同 `/api/register`，但不需要 `invite_code`。账号不存在时返回 `404 user_not_found`。

## Security Notes

- `CLIENT_SECRET`、`GLOBAL_PIN`、`ADMIN_TOKEN`、`REGISTER_INVITE_CODE`、JWT private key 只能通过 Wrangler secrets 注入。
- `TENANT_CONFIGS_JSON` 不放 secret，只放 issuer、callback、domain、shortcut 等配置。
- `allowed_redirect_uri` 只填 OpenAI 给出的 callback。
- `GLOBAL_PIN` 和 `ADMIN_TOKEN` 泄露后立即轮换并重新部署。
