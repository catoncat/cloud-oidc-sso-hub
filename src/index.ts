interface WorkerEnv {
  AUTH_KV: KVNamespace;
  CLIENT_SECRET: string;
  GLOBAL_PIN: string;
  ADMIN_TOKEN?: string;
  REGISTER_INVITE_CODE?: string;
  TENANT_CONFIGS_JSON: string;
  JWT_PRIVATE_KEY_PEM: string;
  JWT_PUBLIC_JWK_JSON: string;
}

type RuntimeEnv = WorkerEnv & {
  ISSUER: string;
  CLIENT_ID: string;
  ALLOWED_EMAIL_DOMAIN: string;
  ALLOWED_REDIRECT_URI: string;
  APP_LOGIN_URL?: string;
  SHORTCUT_HOST?: string;
  IDP_NAME?: string;
  LOGO_DATA_URI?: string;
};

type CodeRecord = {
  clientId: string;
  redirectUri: string;
  scope: string;
  nonce?: string;
  email: string;
  sub: string;
  name: string;
  givenName: string;
  familyName: string;
  authTime: number;
};

type UserInfo = {
  sub: string;
  email: string;
  email_verified: true;
  name: string;
  given_name: string;
  family_name: string;
};

type UserRecord = {
  email: string;
  sub: string;
  name: string;
  givenName: string;
  familyName: string;
  createdAt: number;
};

type ApiPayload = {
  account?: unknown;
  email?: unknown;
  invite_code?: unknown;
  response_type?: unknown;
  client_id?: unknown;
  redirect_uri?: unknown;
  scope?: unknown;
  state?: unknown;
  nonce?: unknown;
  login_hint?: unknown;
};

type TenantConfig = {
  issuer: string;
  client_id: string;
  allowed_email_domain: string;
  allowed_redirect_uri: string;
  app_login_url?: string;
  shortcut_host?: string;
  zone_name?: string;
  idp_name?: string;
  logo_data_uri?: string;
};

const CODE_TTL_SECONDS = 300;
const TOKEN_TTL_SECONDS = 3600;
const GIVEN_NAMES = [
  "Avery",
  "Blake",
  "Casey",
  "Drew",
  "Emery",
  "Finley",
  "Harper",
  "Jordan",
  "Morgan",
  "Quinn",
  "Riley",
  "Taylor"
];
const FAMILY_NAMES = [
  "Chen",
  "Davis",
  "Foster",
  "Gray",
  "Hayes",
  "Lin",
  "Morgan",
  "Parker",
  "Reed",
  "Stone",
  "Walker",
  "Young"
];

export default {
  async fetch(request: Request, env: WorkerEnv): Promise<Response> {
    try {
      const url = new URL(request.url);
      const config = runtimeConfig(url, env);
      if (!config) {
        return text("Tenant is not configured.", 404);
      }
      const shortcutHost = config.SHORTCUT_HOST?.trim();

      if (shortcutHost && url.hostname === shortcutHost) {
        if (!config.APP_LOGIN_URL) {
          return text("APP_LOGIN_URL is not configured.", 500);
        }

        return Response.redirect(config.APP_LOGIN_URL, 302);
      }

      if (request.method === "GET" && url.pathname === "/.well-known/openid-configuration") {
        return json(discovery(config));
      }

      if (request.method === "GET" && url.pathname === "/jwks.json") {
        return json({ keys: [JSON.parse(config.JWT_PUBLIC_JWK_JSON)] });
      }

      if (request.method === "GET" && url.pathname === "/authorize") {
        return handleAuthorize(url, config);
      }

      if (request.method === "POST" && url.pathname === "/login") {
        return handleLogin(request, config);
      }

      if (request.method === "POST" && url.pathname === "/api/login") {
        return handleApiLogin(request, config);
      }

      if (request.method === "POST" && url.pathname === "/api/register") {
        return handleApiRegister(request, config);
      }

      if (request.method === "POST" && url.pathname === "/token") {
        return handleToken(request, config);
      }

      if (request.method === "GET" && url.pathname === "/userinfo") {
        return handleUserinfo(request, config);
      }

      if (request.method === "GET" && url.pathname === "/health") {
        return json({ ok: true });
      }

      if (request.method === "GET" && url.pathname === "/healthz") {
        return json({ ok: true });
      }

      if (request.method === "GET" && url.pathname === "/") {
        return Response.redirect(`${config.ISSUER}/.well-known/openid-configuration`, 302);
      }

      return text("Not found", 404);
    } catch (error) {
      console.error(JSON.stringify({ level: "error", message: String(error) }));
      return text("Internal server error", 500);
    }
  }
};

function discovery(env: RuntimeEnv) {
  return {
    issuer: env.ISSUER,
    authorization_endpoint: `${env.ISSUER}/authorize`,
    token_endpoint: `${env.ISSUER}/token`,
    userinfo_endpoint: `${env.ISSUER}/userinfo`,
    jwks_uri: `${env.ISSUER}/jwks.json`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code"],
    subject_types_supported: ["public"],
    id_token_signing_alg_values_supported: ["RS256"],
    scopes_supported: ["openid", "email", "profile"],
    claims_supported: ["sub", "email", "email_verified", "name", "given_name", "family_name"],
    token_endpoint_auth_methods_supported: ["client_secret_basic", "client_secret_post"]
  };
}

function runtimeConfig(url: URL, env: WorkerEnv): RuntimeEnv | null {
  const tenants = parseTenantConfigs(env.TENANT_CONFIGS_JSON);
  if (!tenants) {
    return null;
  }

  const host = url.hostname.toLowerCase();
  const direct = tenants[host];
  const selected = direct || Object.values(tenants).find((tenant) => {
    const shortcutHost = String(tenant.shortcut_host || "").trim().toLowerCase();
    if (shortcutHost && shortcutHost === host) {
      return true;
    }
    const issuer = String(tenant.issuer || "").trim();
    return issuer ? hostnameFromUrl(issuer) === host : false;
  });

  if (!selected) {
    return null;
  }
  if (!selected.issuer || !selected.client_id || !selected.allowed_email_domain || !selected.allowed_redirect_uri) {
    return null;
  }

  return {
    ...env,
    ISSUER: String(selected.issuer),
    CLIENT_ID: String(selected.client_id),
    ALLOWED_EMAIL_DOMAIN: String(selected.allowed_email_domain),
    ALLOWED_REDIRECT_URI: String(selected.allowed_redirect_uri),
    APP_LOGIN_URL: selected.app_login_url ? String(selected.app_login_url) : undefined,
    SHORTCUT_HOST: selected.shortcut_host ? String(selected.shortcut_host) : undefined,
    IDP_NAME: selected.idp_name ? String(selected.idp_name) : undefined,
    LOGO_DATA_URI: selected.logo_data_uri ? String(selected.logo_data_uri) : undefined
  };
}

function parseTenantConfigs(raw: string): Record<string, TenantConfig> | null {
  if (!raw.trim()) {
    return null;
  }

  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return null;
    }
    const tenants: Record<string, TenantConfig> = {};
    for (const [host, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        continue;
      }
      tenants[host.toLowerCase()] = value as TenantConfig;
    }
    return tenants;
  } catch {
    return null;
  }
}

function hostnameFromUrl(value: string): string {
  try {
    return new URL(value).hostname.toLowerCase();
  } catch {
    return "";
  }
}

function handleAuthorize(url: URL, env: RuntimeEnv): Response {
  const params = authorizeParams(url);
  const validation = validateAuthorizeParams(params, env);
  if (validation) {
    return redirectError(params.redirect_uri, params.state, validation, env);
  }

  return html(renderLoginPage(params, env));
}

async function handleLogin(request: Request, env: RuntimeEnv): Promise<Response> {
  const form = await request.formData();
  const params = {
    response_type: String(form.get("response_type") ?? ""),
    client_id: String(form.get("client_id") ?? ""),
    redirect_uri: String(form.get("redirect_uri") ?? ""),
    scope: String(form.get("scope") ?? ""),
    state: String(form.get("state") ?? ""),
    nonce: String(form.get("nonce") ?? ""),
    login_hint: String(form.get("login_hint") ?? "")
  };

  const validation = validateAuthorizeParams(params, env);
  if (validation) {
    return html(renderLoginPage(params, env, "Invalid OIDC request."), 400);
  }

  const login = String(form.get("login") ?? "");
  const loginEmail = emailFromLoginValue(login, env);
  const hintEmail = emailFromLoginValue(params.login_hint, env);
  const pin = String(form.get("pin") ?? "");
  const email = loginEmail || hintEmail;

  if (!isAllowedEmail(email, env)) {
    return html(renderLoginPage(params, env, `Use a valid ${env.ALLOWED_EMAIL_DOMAIN} email.`, login), 403);
  }

  if (!(await timingSafeEqual(pin, env.GLOBAL_PIN))) {
    return html(renderLoginPage(params, env, "Invalid PIN.", login), 403);
  }

  const redirectUri = await createAuthorizationRedirect(params, email, env);
  return Response.redirect(redirectUri, 302);
}

async function handleApiLogin(request: Request, env: RuntimeEnv): Promise<Response> {
  const authError = await requireAdmin(request, env);
  if (authError) {
    return authError;
  }

  const payload = await readApiPayload(request);
  const email = emailFromLoginValue(String(payload.email ?? payload.account ?? ""), env);
  if (!isAllowedEmail(email, env)) {
    return json({ ok: false, error: "invalid_account" }, 400);
  }

  const user = await getUser(email, env);
  if (!user) {
    return json({ ok: false, error: "user_not_found" }, 404);
  }

  return json(await apiProvisionResponse(payload, user, false, env));
}

async function handleApiRegister(request: Request, env: RuntimeEnv): Promise<Response> {
  const authError = await requireAdmin(request, env);
  if (authError) {
    return authError;
  }

  const payload = await readApiPayload(request);
  const inviteCode = String(payload.invite_code ?? "");
  if (env.REGISTER_INVITE_CODE && !(await timingSafeEqual(inviteCode, env.REGISTER_INVITE_CODE))) {
    return json({ ok: false, error: "invalid_invite_code" }, 403);
  }

  const email = emailFromLoginValue(String(payload.email ?? payload.account ?? ""), env);
  if (!isAllowedEmail(email, env)) {
    return json({ ok: false, error: "invalid_account" }, 400);
  }

  const existing = await getUser(email, env);
  if (existing) {
    return json(await apiProvisionResponse(payload, existing, false, env));
  }

  const user = await createUser(email, env);
  return json(await apiProvisionResponse(payload, user, true, env));
}

async function apiProvisionResponse(
  payload: ApiPayload,
  user: UserRecord,
  created: boolean,
  env: RuntimeEnv
): Promise<Record<string, unknown>> {
  const response: Record<string, unknown> = {
    ok: true,
    user: {
      email: user.email,
      account: user.email.slice(0, -(`@${env.ALLOWED_EMAIL_DOMAIN}`).length),
      created
    }
  };

  const params = apiAuthorizeParams(payload, user.email);
  if (hasAuthorizePayload(payload)) {
    const validation = validateAuthorizeParams(params, env);
    if (validation) {
      return { ok: false, error: validation };
    }
    response.redirect_uri = await createAuthorizationRedirect(params, user.email, env);
  }

  return response;
}

function hasAuthorizePayload(payload: ApiPayload): boolean {
  return payload.client_id !== undefined || payload.redirect_uri !== undefined;
}

async function createAuthorizationRedirect(
  params: {
    response_type: string;
    client_id: string;
    redirect_uri: string;
    scope: string;
    state: string;
    nonce: string;
  },
  email: string,
  env: RuntimeEnv
): Promise<string> {
  const code = randomUrlSafe(32);
  const prefix = email.slice(0, -(`@${env.ALLOWED_EMAIL_DOMAIN}`).length);
  const nameParts = generatedNameParts(prefix);
  const record: CodeRecord = {
    clientId: params.client_id,
    redirectUri: params.redirect_uri,
    scope: params.scope,
    nonce: params.nonce || undefined,
    email,
    sub: email,
    name: `${nameParts.givenName} ${nameParts.familyName}`,
    givenName: nameParts.givenName,
    familyName: nameParts.familyName,
    authTime: unixNow()
  };

  await env.AUTH_KV.put(`code:${code}`, JSON.stringify(record), { expirationTtl: CODE_TTL_SECONDS });

  const redirect = new URL(params.redirect_uri);
  redirect.searchParams.set("code", code);
  if (params.state) {
    redirect.searchParams.set("state", params.state);
  }

  return redirect.toString();
}

async function handleToken(request: Request, env: RuntimeEnv): Promise<Response> {
  const form = await request.formData();
  const auth = parseClientAuth(request, form);

  if (auth.clientId !== env.CLIENT_ID || !(await timingSafeEqual(auth.clientSecret, env.CLIENT_SECRET))) {
    return oauthError("invalid_client", "Invalid client credentials.", 401);
  }

  if (String(form.get("grant_type") ?? "") !== "authorization_code") {
    return oauthError("unsupported_grant_type", "Only authorization_code is supported.", 400);
  }

  const code = String(form.get("code") ?? "");
  const redirectUri = String(form.get("redirect_uri") ?? "");
  const raw = await env.AUTH_KV.get(`code:${code}`);

  if (!raw) {
    return oauthError("invalid_grant", "Invalid or expired authorization code.", 400);
  }

  const record = JSON.parse(raw) as CodeRecord;
  await env.AUTH_KV.delete(`code:${code}`);

  if (record.clientId !== auth.clientId || record.redirectUri !== redirectUri) {
    return oauthError("invalid_grant", "Authorization code does not match this request.", 400);
  }

  const now = unixNow();
  const userinfo: UserInfo = {
    sub: record.sub,
    email: record.email,
    email_verified: true,
    name: record.name,
    given_name: record.givenName,
    family_name: record.familyName
  };
  const accessToken = randomUrlSafe(32);
  const idToken = await signJwt(
    {
      iss: env.ISSUER,
      sub: record.sub,
      aud: env.CLIENT_ID,
      exp: now + TOKEN_TTL_SECONDS,
      iat: now,
      auth_time: record.authTime,
      nonce: record.nonce,
      email: record.email,
      email_verified: true,
      name: record.name,
      given_name: record.givenName,
      family_name: record.familyName
    },
    env
  );

  await env.AUTH_KV.put(`access:${accessToken}`, JSON.stringify(userinfo), {
    expirationTtl: TOKEN_TTL_SECONDS
  });

  return json({
    access_token: accessToken,
    token_type: "Bearer",
    expires_in: TOKEN_TTL_SECONDS,
    id_token: idToken
  });
}

async function handleUserinfo(request: Request, env: RuntimeEnv): Promise<Response> {
  const header = request.headers.get("authorization") ?? "";
  const match = /^Bearer\s+(.+)$/i.exec(header);
  if (!match) {
    return oauthError("invalid_token", "Missing bearer token.", 401);
  }

  const raw = await env.AUTH_KV.get(`access:${match[1]}`);
  if (!raw) {
    return oauthError("invalid_token", "Invalid or expired bearer token.", 401);
  }

  return json(JSON.parse(raw));
}

function authorizeParams(url: URL) {
  return {
    response_type: url.searchParams.get("response_type") ?? "",
    client_id: url.searchParams.get("client_id") ?? "",
    redirect_uri: url.searchParams.get("redirect_uri") ?? "",
    scope: url.searchParams.get("scope") ?? "",
    state: url.searchParams.get("state") ?? "",
    nonce: url.searchParams.get("nonce") ?? "",
    login_hint: url.searchParams.get("login_hint") ?? url.searchParams.get("email") ?? url.searchParams.get("username") ?? ""
  };
}

function validateAuthorizeParams(
  params: {
    response_type: string;
    client_id: string;
    redirect_uri: string;
    scope: string;
  },
  env: RuntimeEnv
): string | null {
  if (params.response_type !== "code") {
    return "unsupported_response_type";
  }

  if (params.client_id !== env.CLIENT_ID) {
    return "unauthorized_client";
  }

  if (!params.scope.split(/\s+/).includes("openid")) {
    return "invalid_scope";
  }

  if (!isAllowedRedirectUri(params.redirect_uri, env)) {
    return "invalid_request";
  }

  return null;
}

function isAllowedRedirectUri(redirectUri: string, env: RuntimeEnv): boolean {
  return redirectUri === env.ALLOWED_REDIRECT_URI;
}

async function requireAdmin(request: Request, env: RuntimeEnv): Promise<Response | null> {
  if (!env.ADMIN_TOKEN) {
    return json({ ok: false, error: "admin_api_not_configured" }, 503);
  }

  const header = request.headers.get("authorization") ?? "";
  const match = /^Bearer\s+(.+)$/i.exec(header);
  const token = match?.[1] ?? "";
  if (!(await timingSafeEqual(token, env.ADMIN_TOKEN))) {
    return json({ ok: false, error: "unauthorized" }, 401);
  }

  return null;
}

async function readApiPayload(request: Request): Promise<ApiPayload> {
  try {
    const body = await request.json();
    return body && typeof body === "object" ? body as ApiPayload : {};
  } catch {
    return {};
  }
}

function apiAuthorizeParams(payload: ApiPayload, email: string) {
  return {
    response_type: String(payload.response_type ?? "code"),
    client_id: String(payload.client_id ?? ""),
    redirect_uri: String(payload.redirect_uri ?? ""),
    scope: String(payload.scope ?? "openid profile email"),
    state: String(payload.state ?? ""),
    nonce: String(payload.nonce ?? ""),
    login_hint: String(payload.login_hint ?? email)
  };
}

async function getUser(email: string, env: RuntimeEnv): Promise<UserRecord | null> {
  const raw = await env.AUTH_KV.get(userKey(email));
  if (!raw) {
    return null;
  }

  try {
    return JSON.parse(raw) as UserRecord;
  } catch {
    return null;
  }
}

async function createUser(email: string, env: RuntimeEnv): Promise<UserRecord> {
  const prefix = email.slice(0, -(`@${env.ALLOWED_EMAIL_DOMAIN}`).length);
  const nameParts = generatedNameParts(prefix);
  const record: UserRecord = {
    email,
    sub: email,
    name: `${nameParts.givenName} ${nameParts.familyName}`,
    givenName: nameParts.givenName,
    familyName: nameParts.familyName,
    createdAt: unixNow()
  };
  await env.AUTH_KV.put(userKey(email), JSON.stringify(record));
  return record;
}

function userKey(email: string): string {
  return `user:${email}`;
}

function isAllowedEmail(email: string, env: RuntimeEnv): boolean {
  const domain = `@${env.ALLOWED_EMAIL_DOMAIN}`;
  if (!email.endsWith(domain)) {
    return false;
  }

  const prefix = email.slice(0, -domain.length);
  return /^[a-z0-9][a-z0-9._-]{0,62}$/.test(prefix);
}

function emailFromLoginValue(value: string, env: RuntimeEnv): string {
  const login = normalizeEmail(value);
  if (!login) {
    return "";
  }

  return login.includes("@") ? login : `${login}@${env.ALLOWED_EMAIL_DOMAIN}`;
}

function redirectError(redirectUri: string, state: string, error: string, env: RuntimeEnv): Response {
  if (!isAllowedRedirectUri(redirectUri, env)) {
    return text(error, 400);
  }

  const url = new URL(redirectUri);
  url.searchParams.set("error", error);
  if (state) {
    url.searchParams.set("state", state);
  }

  return Response.redirect(url.toString(), 302);
}

function parseClientAuth(request: Request, form: FormData): { clientId: string; clientSecret: string } {
  const header = request.headers.get("authorization") ?? "";
  const match = /^Basic\s+(.+)$/i.exec(header);
  if (match) {
    const decoded = atob(match[1]);
    const separator = decoded.indexOf(":");
    return {
      clientId: decoded.slice(0, separator),
      clientSecret: decoded.slice(separator + 1)
    };
  }

  return {
    clientId: String(form.get("client_id") ?? ""),
    clientSecret: String(form.get("client_secret") ?? "")
  };
}

async function signJwt(payload: Record<string, unknown>, env: RuntimeEnv): Promise<string> {
  const publicJwk = JSON.parse(env.JWT_PUBLIC_JWK_JSON) as JsonWebKey & { kid?: string };
  const header = { alg: "RS256", typ: "JWT", kid: publicJwk.kid };
  const encodedHeader = base64UrlEncodeJson(header);
  const encodedPayload = base64UrlEncodeJson(stripUndefined(payload));
  const signingInput = `${encodedHeader}.${encodedPayload}`;
  const key = await importPrivateKey(env.JWT_PRIVATE_KEY_PEM);
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    key,
    new TextEncoder().encode(signingInput)
  );

  return `${signingInput}.${base64UrlEncode(new Uint8Array(signature))}`;
}

async function importPrivateKey(pem: string): Promise<CryptoKey> {
  const body = pem
    .replace("-----BEGIN PRIVATE KEY-----", "")
    .replace("-----END PRIVATE KEY-----", "")
    .replace(/\s+/g, "");
  const der = base64ToBytes(body);
  return crypto.subtle.importKey(
    "pkcs8",
    der,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"]
  );
}

async function timingSafeEqual(a: string, b: string): Promise<boolean> {
  const left = new TextEncoder().encode(a);
  const right = new TextEncoder().encode(b);
  const max = Math.max(left.length, right.length);
  const paddedLeft = new Uint8Array(max);
  const paddedRight = new Uint8Array(max);
  paddedLeft.set(left);
  paddedRight.set(right);
  const leftHash = await crypto.subtle.digest("SHA-256", paddedLeft);
  const rightHash = await crypto.subtle.digest("SHA-256", paddedRight);
  return left.length === right.length && base64UrlEncode(new Uint8Array(leftHash)) === base64UrlEncode(new Uint8Array(rightHash));
}

function renderLoginPage(
  params: {
    response_type: string;
    client_id: string;
    redirect_uri: string;
    scope: string;
    state: string;
    nonce: string;
    login_hint: string;
  },
  env: RuntimeEnv,
  error = "",
  prefillLogin = ""
): string {
  const hintedEmail = isAllowedEmail(emailFromLoginValue(params.login_hint, env), env)
    ? emailFromLoginValue(params.login_hint, env)
    : "";
  const showEmailField = !hintedEmail;
  const normalizedPrefill = normalizeEmail(prefillLogin);
  const title = escapeHtml(env.IDP_NAME || "Cloudflare OIDC SSO");

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${title}</title>
  <style>
    :root {
      color-scheme: light;
      --ink: #111;
      --paper: #fffef9;
      --muted: #76716a;
      --bad: #b3261e;
      font-family: "Bradley Hand", "Comic Sans MS", "Chalkboard SE", cursive;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      min-height: 100vh;
      display: grid;
      place-items: center;
      background:
        radial-gradient(circle at 50% 36%, rgb(0 0 0 / 4%) 0 1px, transparent 1px 100%),
        var(--paper);
      background-size: 18px 18px;
      color: var(--ink);
    }
    main {
      width: min(88vw, 270px);
      display: grid;
      justify-items: center;
      gap: 14px;
      transform: rotate(-0.4deg);
    }
    .cat-logo {
      width: 188px;
      height: 188px;
      display: block;
      object-fit: contain;
      mix-blend-mode: multiply;
      filter: contrast(1.08);
      transform: rotate(-0.6deg);
    }
    svg.cat-logo {
      color: var(--ink);
      fill: none;
      stroke: currentColor;
      stroke-width: 2.3;
      stroke-linecap: round;
      stroke-linejoin: round;
    }
    .hint {
      min-height: 20px;
      margin: -6px 0 0;
      color: var(--muted);
      font-size: 15px;
      letter-spacing: 0.01em;
      text-align: center;
    }
    form {
      width: 100%;
      display: grid;
      gap: 13px;
    }
    label {
      position: absolute;
      width: 1px;
      height: 1px;
      overflow: hidden;
      clip: rect(0 0 0 0);
      white-space: nowrap;
    }
    .line-field {
      width: 100%;
      height: 42px;
      display: flex;
      align-items: center;
      border-bottom: 2px solid var(--ink);
      transform: rotate(0.3deg);
    }
    input {
      width: 100%;
      border: 0;
      outline: 0;
      background: transparent;
      color: var(--ink);
      font: 22px/1 "Bradley Hand", "Comic Sans MS", "Chalkboard SE", cursive;
    }
    input::placeholder { color: #aaa39b; }
    input:focus { background: linear-gradient(transparent 70%, rgb(0 0 0 / 6%) 70%); }
    #pin { letter-spacing: 0.16em; }
    .eye {
      width: 38px;
      height: 38px;
      margin: 0 -6px 0 6px;
      border: 0;
      background: transparent;
      color: var(--ink);
      cursor: pointer;
      transform: rotate(-6deg);
    }
    .eye svg {
      width: 26px;
      height: 26px;
      fill: none;
      stroke: currentColor;
      stroke-width: 2.2;
      stroke-linecap: round;
      stroke-linejoin: round;
    }
    .eye .slash { opacity: 1; }
    .eye.open .slash { opacity: 0; }
    .go {
      justify-self: center;
      width: 96px;
      height: 38px;
      border: 2px solid var(--ink);
      border-radius: 999px 60px 999px 70px;
      background: transparent;
      color: var(--ink);
      font: 20px/1 "Bradley Hand", "Comic Sans MS", "Chalkboard SE", cursive;
      cursor: pointer;
      transform: rotate(1.2deg);
    }
    .go:active { transform: rotate(1.2deg) translateY(1px); }
    .error {
      width: 100%;
      margin: 0;
      color: var(--bad);
      font-size: 15px;
      text-align: center;
    }
  </style>
</head>
<body>
  <main>
    ${renderLogo(env)}
    <p class="hint">${hintedEmail ? escapeHtml(hintedEmail) : `@${escapeHtml(env.ALLOWED_EMAIL_DOMAIN)}`}</p>
    ${error ? `<div class="error">${escapeHtml(error)}</div>` : ""}
    <form method="post" action="/login" autocomplete="on">
      ${hidden("response_type", params.response_type)}
      ${hidden("client_id", params.client_id)}
      ${hidden("redirect_uri", params.redirect_uri)}
      ${hidden("scope", params.scope)}
      ${hidden("state", params.state)}
      ${hidden("nonce", params.nonce)}
      ${hidden("login_hint", params.login_hint)}
      ${showEmailField ? `
      <div class="line-field">
        <label for="login">Prefix</label>
        <input id="login" name="login" type="text" inputmode="text" autocomplete="username" placeholder="prefix" value="${escapeHtml(normalizedPrefill)}" required autofocus>
      </div>` : ""}
      <div class="line-field">
      <label for="pin">PIN</label>
        <input id="pin" name="pin" type="password" inputmode="numeric" autocomplete="one-time-code" placeholder="pin" required ${showEmailField ? "" : "autofocus"}>
        <button class="eye" type="button" aria-label="Show PIN" data-eye>
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M2.5 12 C6 6.5 18 6.5 21.5 12 C18 17.5 6 17.5 2.5 12 Z" />
            <circle cx="12" cy="12" r="3.2" />
            <path class="slash" d="M5 20 L20 4" />
          </svg>
        </button>
      </div>
      <button class="go" type="submit">go</button>
    </form>
  </main>
  <script>
    const eye = document.querySelector("[data-eye]");
    const pin = document.querySelector("#pin");
    eye?.addEventListener("click", () => {
      const open = pin.type === "password";
      pin.type = open ? "text" : "password";
      eye.classList.toggle("open", open);
      eye.setAttribute("aria-label", open ? "Hide PIN" : "Show PIN");
      pin.focus();
    });
  </script>
</body>
</html>`;
}

function renderLogo(env: RuntimeEnv): string {
  const logo = env.LOGO_DATA_URI?.trim();
  if (logo) {
    return `<img class="cat-logo" src="${escapeHtml(logo)}" alt="logo">`;
  }

  return `<svg class="cat-logo" viewBox="0 0 200 200" role="img" aria-label="cat logo">
      <path d="M47 62 L47 25 L69 51" />
      <path d="M69 51 C83 45 102 45 118 51" />
      <path d="M118 51 L146 18 L153 65" />
      <path d="M153 65 C164 96 149 126 124 136" />
      <path d="M124 136 C139 155 137 175 126 190" />
      <path d="M52 80 C39 104 44 128 65 140" />
      <path d="M65 140 C51 157 48 177 57 194" />
      <path d="M68 88 C76 80 88 82 91 92 C87 105 73 105 68 88 Z" />
      <path d="M123 88 C132 81 142 84 145 94 C138 106 126 104 123 88 Z" />
      <path d="M77 93 C79 88 86 88 87 94" />
      <path d="M133 94 C135 89 141 90 142 96" />
      <path d="M34 115 L76 107" />
      <path d="M30 133 L75 119" />
      <path d="M161 106 L194 91" />
      <path d="M157 119 L194 125" />
    </svg>`;
}

function hidden(name: string, value: string): string {
  return `<input type="hidden" name="${name}" value="${escapeHtml(value)}">`;
}

function generatedNameParts(prefix: string): { givenName: string; familyName: string } {
  const hash = hashString(prefix);
  return {
    givenName: GIVEN_NAMES[hash % GIVEN_NAMES.length],
    familyName: FAMILY_NAMES[Math.floor(hash / GIVEN_NAMES.length) % FAMILY_NAMES.length]
  };
}

function hashString(input: string): number {
  let hash = 2166136261;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

function randomUrlSafe(bytes: number): string {
  const data = new Uint8Array(bytes);
  crypto.getRandomValues(data);
  return base64UrlEncode(data);
}

function unixNow(): number {
  return Math.floor(Date.now() / 1000);
}

function stripUndefined(input: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined));
}

function base64UrlEncodeJson(input: unknown): string {
  return base64UrlEncode(new TextEncoder().encode(JSON.stringify(input)));
}

function base64UrlEncode(input: Uint8Array): string {
  let binary = "";
  for (const byte of input) {
    binary += String.fromCharCode(byte);
  }

  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function base64ToBytes(input: string): ArrayBuffer {
  const binary = atob(input);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer;
}

function escapeHtml(input: string): string {
  return input.replace(/[&<>"']/g, (char) => {
    const entities: Record<string, string> = {
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;"
    };
    return entities[char];
  });
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store"
    }
  });
}

function text(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: { "content-type": "text/plain; charset=utf-8" }
  });
}

function html(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store"
    }
  });
}

function oauthError(error: string, description: string, status: number): Response {
  return json({ error, error_description: description }, status);
}
