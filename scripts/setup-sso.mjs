#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { generateKeyPairSync, randomBytes, randomInt } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

const DEFAULT_CLIENT_ID = "openai-enterprise-sso";
const DNS_PLACEHOLDER_IP = "192.0.2.1";

const args = parseArgs(process.argv.slice(2));

if (args.help) {
  printHelp();
  process.exit(0);
}

const rl = createInterface({ input, output });

try {
  await main();
} finally {
  rl.close();
}

async function main() {
  const domain = normalizeDomain(
    await option("domain", "Email/domain to configure, for example example.com", args.domain, { required: true })
  );
  const zoneDomain = normalizeDomain(args.zone || args.zoneName || domain);
  const slug = slugify(domain);
  const setupUrl = await option("setupUrl", "OpenAI setup page URL, optional", args.setupUrl || "", { required: false });
  const callback = await option(
    "callback",
    "OpenAI login redirect URI from Step 2",
    args.callback || args.redirectUri || "",
    { required: true }
  );
  const connectionId =
    args.connectionId ||
    parseConnectionId(setupUrl) ||
    parseConnectionId(args.appLoginUrl || "") ||
    (await option("connectionId", "OpenAI connection id, optional, for go.<domain>", "", { required: false }));
  const appLoginUrl =
    args.appLoginUrl ||
    (connectionId ? `https://chatgpt.com/auth/login?sso=true&connection=${connectionId}` : "");
  const clientId = await option("clientId", "OIDC Client ID", args.clientId || DEFAULT_CLIENT_ID, { required: true });
  const accountIdFromEnv = process.env.CLOUDFLARE_ACCOUNT_ID || "";
  let accountId = args.accountId || accountIdFromEnv;
  const workerName = args.workerName || "cloud-oidc-sso-hub";
  const kvTitle = args.kvTitle || `${workerName}-auth`;
  const idpName = args.idpName || `${titleCase(slug.replace(/-/g, " "))} SSO`;
  const issuer = args.issuer || defaultIssuer(domain, zoneDomain);
  const resolvedShortcutHost =
    appLoginUrl && args.shortcutHost !== false ? args.shortcutHost || defaultShortcutHost(domain, zoneDomain) : "";
  const deploy = args.deploy !== false;
  const manageDns = args.dns !== false && deploy;
  const smoke = args.smoke !== false && deploy;
  const api = cloudflareApi();

  let zone = null;
  if ((manageDns || !accountId) && api) {
    zone = await findZone(api, zoneDomain);
    if (zone?.account?.id && !accountId) {
      accountId = zone.account.id;
    }
  }

  let kvId = args.kvId || "";
  if (deploy && !kvId) {
    if (!api || !accountId) {
      throw new Error(
        "Missing KV namespace id. Provide --kv-id, or set Cloudflare API credentials plus --account-id/CLOUDFLARE_ACCOUNT_ID."
      );
    }
    kvId = await createOrGetKvNamespace(api, accountId, kvTitle);
  }
  if (!kvId) {
    kvId = "YOUR_KV_NAMESPACE_ID";
  }

  const outputRoot = args.outputDir || join(".generated", "cloud-oidc-sso-hub");
  const secretsDir = args.secretsDir || ".secrets-cloud-oidc-sso-hub";
  const tenantRegistryPath = args.tenantRegistry || join(outputRoot, "tenants.json");
  mkdirSync(outputRoot, { recursive: true });
  mkdirSync(secretsDir, { recursive: true });

  const secretPaths = ensureSecrets(secretsDir, {
    pin: args.pin || "",
    adminToken: args.adminToken || "",
    inviteCode: args.inviteCode || "",
    force: Boolean(args.forceSecrets || args.force)
  });

  const configPath = join(outputRoot, "wrangler.jsonc");
  const tenantConfigs = upsertTenantConfig(tenantRegistryPath, hostnameFromUrl(issuer), {
    issuer,
    client_id: clientId,
    allowed_email_domain: domain,
    allowed_redirect_uri: callback,
    zone_name: zoneDomain,
    app_login_url: appLoginUrl,
    shortcut_host: resolvedShortcutHost,
    idp_name: idpName
  });
  writeConfig(configPath, {
    accountId,
    workerName,
    issuer,
    zoneDomain,
    clientId,
    domain,
    callback,
    appLoginUrl,
    shortcutHost: resolvedShortcutHost,
    idpName,
    kvId,
    tenantConfigs
  });

  if (deploy) {
    uploadSecrets(configPath, secretPaths, { accountId });
    runWrangler(["deploy", "--config", configPath], null, { accountId });
  }

  if (manageDns) {
    if (!api) {
      throw new Error("DNS automation requires CLOUDFLARE_API_TOKEN or CLOUDFLARE_EMAIL + CLOUDFLARE_GLOBAL_API_KEY.");
    }
    zone ||= await findZone(api, zoneDomain);
    if (!zone) {
      throw new Error(`Cloudflare zone not found: ${zoneDomain}`);
    }
    await upsertDns(api, zone.id, hostnameFromUrl(issuer));
    if (resolvedShortcutHost) {
      await upsertDns(api, zone.id, resolvedShortcutHost);
    }
  }

  if (smoke) {
    await smokeDiscovery(`${issuer}/.well-known/openid-configuration`, issuer);
    await smokeJwks(`${issuer}/jwks.json`);
  }

  printSummary({
    domain,
    zoneDomain,
    workerName,
    accountId,
    kvId,
    issuer,
    clientId,
    callback,
    appLoginUrl,
    shortcutHost: resolvedShortcutHost,
    configPath,
    secretsDir,
    secretPaths,
    tenantRegistryPath
  });
}

async function option(key, label, current, { required }) {
  if (current !== undefined && current !== null && current !== true && String(current).trim() !== "") {
    return String(current).trim();
  }
  if (args.yes) {
    if (required) {
      throw new Error(`Missing required option --${kebab(key)}.`);
    }
    return "";
  }
  while (true) {
    const answer = (await rl.question(`${label}${current ? ` (${current})` : ""}: `)).trim();
    const value = answer || String(current || "").trim();
    if (value || !required) {
      return value;
    }
  }
}

function ensureSecrets(secretsDir, { pin, adminToken, inviteCode, force }) {
  const clientSecretPath = join(secretsDir, "openai-client-secret.txt");
  const pinPath = join(secretsDir, "global-pin.txt");
  const adminTokenPath = join(secretsDir, "admin-token.txt");
  const inviteCodePath = join(secretsDir, "register-invite-code.txt");
  const privateKeyPath = join(secretsDir, "jwt-private-key.pem");
  const publicJwkPath = join(secretsDir, "jwt-public-jwk.json");

  if (force || !existsSync(clientSecretPath)) {
    writeFileSync(clientSecretPath, `${randomBytes(32).toString("base64url")}\n`, { mode: 0o600 });
  }

  if (pin) {
    writeFileSync(pinPath, `${pin.trim()}\n`, { mode: 0o600 });
  } else if (!existsSync(pinPath)) {
    writeFileSync(pinPath, `${String(randomInt(0, 1_000_000)).padStart(6, "0")}\n`, { mode: 0o600 });
  }

  if (adminToken) {
    writeFileSync(adminTokenPath, `${adminToken.trim()}\n`, { mode: 0o600 });
  } else if (force || !existsSync(adminTokenPath)) {
    writeFileSync(adminTokenPath, `${randomBytes(32).toString("base64url")}\n`, { mode: 0o600 });
  }

  if (inviteCode) {
    writeFileSync(inviteCodePath, `${inviteCode.trim()}\n`, { mode: 0o600 });
  } else if (force || !existsSync(inviteCodePath)) {
    writeFileSync(inviteCodePath, `${randomBytes(18).toString("base64url")}\n`, { mode: 0o600 });
  }

  if (force || !existsSync(privateKeyPath) || !existsSync(publicJwkPath)) {
    const { privateKey, publicKey } = generateKeyPairSync("rsa", {
      modulusLength: 2048,
      publicExponent: 0x10001
    });
    const publicJwk = publicKey.export({ format: "jwk" });
    publicJwk.alg = "RS256";
    publicJwk.use = "sig";
    publicJwk.kid = randomBytes(12).toString("base64url");
    writeFileSync(privateKeyPath, privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600 });
    writeFileSync(publicJwkPath, `${JSON.stringify(publicJwk)}\n`, { mode: 0o600 });
  }

  return {
    CLIENT_SECRET: clientSecretPath,
    GLOBAL_PIN: pinPath,
    ADMIN_TOKEN: adminTokenPath,
    REGISTER_INVITE_CODE: inviteCodePath,
    JWT_PRIVATE_KEY_PEM: privateKeyPath,
    JWT_PUBLIC_JWK_JSON: publicJwkPath
  };
}

function writeConfig(configPath, values) {
  mkdirSync(dirname(configPath), { recursive: true });
  const tenantConfigs = values.tenantConfigs;
  const vars = {
    TENANT_CONFIGS_JSON: JSON.stringify(tenantConfigs)
  };

  const routes = [];
  const seen = new Set();
  for (const tenant of Object.values(tenantConfigs)) {
    for (const host of [hostnameFromUrl(tenant.issuer || ""), tenant.shortcut_host || ""]) {
      if (!host || seen.has(host)) {
        continue;
      }
      seen.add(host);
      routes.push({ pattern: `${host}/*`, zone_name: tenant.zone_name || values.zoneDomain });
    }
  }

  const config = {
    $schema: "../../node_modules/wrangler/config-schema.json",
    name: values.workerName,
    main: "../../src/index.ts",
    compatibility_date: new Date().toISOString().slice(0, 10),
    compatibility_flags: ["nodejs_compat"],
    observability: { enabled: true, head_sampling_rate: 1 },
    vars,
    kv_namespaces: [{ binding: "AUTH_KV", id: values.kvId }],
    routes
  };
  if (values.accountId) {
    config.account_id = values.accountId;
  }
  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
}

function upsertTenantConfig(registryPath, host, tenant) {
  mkdirSync(dirname(registryPath), { recursive: true });
  const tenants = readJsonObject(registryPath);
  tenants[host] = Object.fromEntries(
    Object.entries(tenant).filter(([, value]) => value !== undefined && value !== "")
  );
  writeFileSync(registryPath, `${JSON.stringify(tenants, null, 2)}\n`, { mode: 0o600 });
  return tenants;
}

function readJsonObject(path) {
  if (!existsSync(path)) {
    return {};
  }
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function uploadSecrets(configPath, secretPaths, { accountId }) {
  for (const [name, path] of Object.entries(secretPaths)) {
    runWrangler(["secret", "put", name, "--config", configPath], readFileSync(path), { accountId });
  }
}

function runWrangler(wranglerArgs, inputBuffer, { accountId }) {
  const env = { ...process.env };
  if (process.env.CLOUDFLARE_GLOBAL_API_KEY && !env.CLOUDFLARE_API_KEY) {
    env.CLOUDFLARE_API_KEY = process.env.CLOUDFLARE_GLOBAL_API_KEY;
  }
  if (accountId && !env.CLOUDFLARE_ACCOUNT_ID) {
    env.CLOUDFLARE_ACCOUNT_ID = accountId;
  }
  const result = spawnSync("npx", ["wrangler", ...wranglerArgs], {
    input: inputBuffer || undefined,
    stdio: [inputBuffer ? "pipe" : "inherit", "inherit", "inherit"],
    env
  });
  if (result.status !== 0) {
    throw new Error(`wrangler ${wranglerArgs.join(" ")} failed with exit code ${result.status}.`);
  }
}

function cloudflareApi() {
  if (process.env.CLOUDFLARE_API_TOKEN) {
    return {
      headers: {
        Authorization: `Bearer ${process.env.CLOUDFLARE_API_TOKEN}`,
        "Content-Type": "application/json"
      }
    };
  }
  if (process.env.CLOUDFLARE_EMAIL && (process.env.CLOUDFLARE_GLOBAL_API_KEY || process.env.CLOUDFLARE_API_KEY)) {
    return {
      headers: {
        "X-Auth-Email": process.env.CLOUDFLARE_EMAIL,
        "X-Auth-Key": process.env.CLOUDFLARE_GLOBAL_API_KEY || process.env.CLOUDFLARE_API_KEY,
        "Content-Type": "application/json"
      }
    };
  }
  return null;
}

async function cfRequest(api, path, { method = "GET", body } = {}) {
  const response = await fetch(`https://api.cloudflare.com/client/v4${path}`, {
    method,
    headers: api.headers,
    body: body ? JSON.stringify(body) : undefined
  });
  const text = await response.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`Cloudflare API returned non-JSON response: ${text.slice(0, 160)}`);
  }
  if (!response.ok || data.success === false) {
    throw new Error(`Cloudflare API error: ${JSON.stringify(data.errors || data)}`);
  }
  return data;
}

async function findZone(api, domain) {
  const data = await cfRequest(api, `/zones?name=${encodeURIComponent(domain)}`);
  return data.result?.[0] || null;
}

async function createOrGetKvNamespace(api, accountId, title) {
  const list = await cfRequest(api, `/accounts/${accountId}/storage/kv/namespaces?per_page=100`);
  const existing = list.result?.find((namespace) => namespace.title === title);
  if (existing) {
    return existing.id;
  }
  const created = await cfRequest(api, `/accounts/${accountId}/storage/kv/namespaces`, {
    method: "POST",
    body: { title }
  });
  return created.result.id;
}

async function upsertDns(api, zoneId, name) {
  const listed = await cfRequest(api, `/zones/${zoneId}/dns_records?name=${encodeURIComponent(name)}`);
  const records = listed.result || [];
  const conflicting = records.find((record) => record.type === "CNAME");
  if (conflicting) {
    throw new Error(`DNS record ${name} already exists as CNAME; update it manually or remove it first.`);
  }
  const payload = { type: "A", name, content: DNS_PLACEHOLDER_IP, ttl: 1, proxied: true };
  const existing = records.find((record) => record.type === "A");
  if (existing) {
    await cfRequest(api, `/zones/${zoneId}/dns_records/${existing.id}`, { method: "PUT", body: payload });
    return;
  }
  await cfRequest(api, `/zones/${zoneId}/dns_records`, { method: "POST", body: payload });
}

async function smokeDiscovery(url, expectedIssuer) {
  const data = await fetchJsonWithRetry(url);
  if (data.issuer !== expectedIssuer) {
    throw new Error(`Discovery smoke test failed: expected issuer ${expectedIssuer}, got ${data.issuer}`);
  }
}

async function smokeJwks(url) {
  const data = await fetchJsonWithRetry(url);
  if (!Array.isArray(data.keys) || data.keys.length === 0) {
    throw new Error("JWKS smoke test failed: no keys returned.");
  }
}

async function fetchJsonWithRetry(url) {
  let lastError;
  for (let attempt = 1; attempt <= 6; attempt += 1) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(10_000) });
      if (!response.ok) {
        throw new Error(`${response.status} ${response.statusText}`);
      }
      return await response.json();
    } catch (error) {
      lastError = error;
      await sleep(attempt * 1000);
    }
  }
  throw new Error(`Smoke test failed for ${url}: ${lastError}`);
}

function printSummary(summary) {
  console.log("\nSSO Worker is ready.\n");
  console.log(`Worker: ${summary.workerName}`);
  console.log("Mode: multi-tenant");
  if (summary.accountId) console.log(`Cloudflare account: ${summary.accountId}`);
  console.log(`Cloudflare zone: ${summary.zoneDomain}`);
  console.log(`KV namespace: ${summary.kvId}`);
  console.log(`Issuer: ${summary.issuer}`);
  console.log(`Discovery Endpoint: ${summary.issuer}/.well-known/openid-configuration`);
  console.log(`Client ID: ${summary.clientId}`);
  console.log(`Client Secret file: ${summary.secretPaths.CLIENT_SECRET}`);
  console.log(`PIN file: ${summary.secretPaths.GLOBAL_PIN}`);
  console.log(`Admin token file: ${summary.secretPaths.ADMIN_TOKEN}`);
  console.log(`Register invite code file: ${summary.secretPaths.REGISTER_INVITE_CODE}`);
  console.log(`OpenAI callback: ${summary.callback}`);
  if (summary.appLoginUrl) console.log(`Application login URL: ${summary.appLoginUrl}`);
  if (summary.shortcutHost) console.log(`Shortcut URL: https://${summary.shortcutHost}`);
  console.log(`Wrangler config: ${summary.configPath}`);
  console.log(`Tenant registry: ${summary.tenantRegistryPath}`);
  console.log("\nOpenAI Step 4:");
  console.log(`- Client ID: ${summary.clientId}`);
  console.log(`- Client Secret: copy from ${summary.secretPaths.CLIENT_SECRET}`);
  console.log(`- Discovery Endpoint: ${summary.issuer}/.well-known/openid-configuration`);
  console.log("\nOn macOS, copy the client secret with:");
  console.log(`pbcopy < ${summary.secretPaths.CLIENT_SECRET}`);
  console.log("\nFor protocol automation, export these without printing values:");
  console.log(`export OIDC_SSO_URL=${summary.issuer}`);
  console.log(`export OIDC_SSO_ADMIN_TOKEN="$(cat ${summary.secretPaths.ADMIN_TOKEN})"`);
  console.log(`export OIDC_SSO_INVITE_CODE="$(cat ${summary.secretPaths.REGISTER_INVITE_CODE})"`);
}

function normalizeDomain(domain) {
  const value = String(domain).trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "");
  if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(value)) {
    throw new Error(`Invalid domain: ${domain}`);
  }
  return value;
}

function hostnameFromUrl(url) {
  try {
    return new URL(url).hostname;
  } catch {
    throw new Error(`Invalid URL: ${url}`);
  }
}

function defaultIssuer(domain, zoneDomain) {
  return domain === zoneDomain ? `https://auth.${domain}` : `https://${domain}`;
}

function defaultShortcutHost(domain, zoneDomain) {
  if (domain === zoneDomain) {
    return `go.${domain}`;
  }
  const subdomain = domain.endsWith(`.${zoneDomain}`)
    ? domain.slice(0, -(zoneDomain.length + 1))
    : domain.replace(`.${zoneDomain}`, "");
  return `go-${subdomain.replace(/[^a-z0-9]+/g, "-")}.${zoneDomain}`;
}

function parseConnectionId(value) {
  const match = String(value || "").match(/conn_[A-Za-z0-9]+/);
  return match?.[0] || "";
}

function parseArgs(argv) {
  const parsed = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "-h" || arg === "--help") {
      parsed.help = true;
      continue;
    }
    if (!arg.startsWith("--")) {
      continue;
    }
    if (arg.startsWith("--no-")) {
      parsed[toCamel(arg.slice(5))] = false;
      continue;
    }
    const [rawKey, inlineValue] = arg.slice(2).split("=", 2);
    const key = toCamel(rawKey);
    if (inlineValue !== undefined) {
      parsed[key] = inlineValue;
      continue;
    }
    const next = argv[i + 1];
    if (next && !next.startsWith("--")) {
      parsed[key] = next;
      i += 1;
    } else {
      parsed[key] = true;
    }
  }
  return parsed;
}

function toCamel(value) {
  return value.replace(/-([a-z])/g, (_, char) => char.toUpperCase());
}

function kebab(value) {
  return value.replace(/[A-Z]/g, (char) => `-${char.toLowerCase()}`);
}

function slugify(value) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

function titleCase(value) {
  return value.replace(/\b[a-z]/g, (char) => char.toUpperCase());
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function printHelp() {
  console.log(`Usage:
  npm run setup:sso -- --domain example.com \\
    --callback https://external.auth.openai.com/sso/oidc/.../callback \\
    --setup-url 'https://setup.auth.openai.com/.../sso/conn_.../custom-oidc'

Required:
  --domain              Email domain and Cloudflare zone, for example example.com
  --callback            OpenAI Login redirect URI from Step 2

Useful:
  --zone                Cloudflare zone name if --domain is a verified subdomain.
  --setup-url           OpenAI setup page URL. The script extracts conn_... from it.
  --connection-id       OpenAI connection id if not using --setup-url
  --account-id          Cloudflare account id. Defaults to CLOUDFLARE_ACCOUNT_ID or inferred from zone.
  --client-id           OIDC client id. Defaults to ${DEFAULT_CLIENT_ID}
  --pin                 Shared PIN to store. If omitted, a random PIN is generated.
  --admin-token         Admin bearer token for /api/login and /api/register. Random if omitted.
  --invite-code         Registration invite code for /api/register. Random if omitted.
  --worker-name         Defaults to cloud-oidc-sso-hub.
  --tenant-registry     Tenant registry JSON path. Defaults to .generated/cloud-oidc-sso-hub/tenants.json.
  --kv-id               Existing KV namespace id. If omitted, script creates/reuses one.
  --no-deploy           Generate files only.
  --no-dns              Do not create auth/go DNS records.
  --no-smoke            Skip discovery/JWKS smoke tests.
  --force-secrets       Regenerate Client Secret and JWT keys.
  --yes                 Non-interactive; all required fields must be provided.

Cloudflare auth:
  Full automation needs CLOUDFLARE_API_TOKEN, or CLOUDFLARE_EMAIL + CLOUDFLARE_GLOBAL_API_KEY.
  Wrangler deploy can also use an existing wrangler login, but KV/DNS automation needs API credentials.
`);
}
