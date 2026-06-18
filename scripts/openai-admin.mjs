#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
process.chdir(repoRoot);

const DEFAULT_CONFIG = "config/tenants.json";
const DEFAULT_CLIENT_ID = "openai-enterprise-sso";
const OPENAI_IDENTITY_DOMAINS_URL = "https://admin.openai.com/identity?tab=domains";
const OPENAI_IDENTITY_SSO_URL = "https://admin.openai.com/identity?tab=sso";

const args = parseArgs(process.argv.slice(2));
const command = args._[0] || "bootstrap";

try {
  await main();
} catch (error) {
  console.error(`[error] ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}

async function main() {
  if (args.help || command === "help") {
    printHelp();
    return;
  }

  if (command === "snapshot") {
    console.log(JSON.stringify(await pageSnapshot(), null, 2));
    return;
  }

  if (command !== "bootstrap") {
    throw new Error(`Unknown openai command: ${command}`);
  }

  const configPath = args.config || DEFAULT_CONFIG;
  const config = readConfig(configPath);
  const domain = normalizeDomain(requiredArg("domain", args.domain || firstTenant(config)?.domain));
  const zone = normalizeDomain(args.zone || firstTenant(config, domain)?.zone || parentZone(domain));
  const clientId = args.clientId || config.client_id || DEFAULT_CLIENT_ID;
  const tenant = firstTenant(config, domain) || {};
  const skipDomain = Boolean(args.skipDomain);
  const skipWorker = Boolean(args.skipWorker);
  const skipOpenaiFill = Boolean(args.skipOpenaiFill);
  const keychainDir = args.keychainDir || `${process.env.HOME}/Library/Keychains/envchain-scopes`;
  const cloudflareEnv = await cloudflareEnvForArgs(args);
  const pin = skipOpenaiFill ? "" : pinValue(args, config);

  await ensureChrome();

  if (!skipDomain) {
    await ensureOpenAiDomain({ domain, zone, cloudflareEnv });
  }

  const connection = tenant.callback && tenant.setup_url
    ? {
        setupUrl: tenant.setup_url,
        callback: tenant.callback,
        connectionId: tenant.connection_id || parseConnectionId(tenant.setup_url)
      }
    : await ensureCustomOidcConnection();

  if (!connection.callback) {
    await writeDebugSnapshot("missing-callback");
    throw new Error("Could not extract OpenAI OIDC callback URL from the current setup page.");
  }

  upsertTenantConfig(configPath, {
    domain,
    zone,
    callback: connection.callback,
    setup_url: connection.setupUrl,
    connection_id: connection.connectionId,
    client_id: clientId
  });

  if (!skipWorker) {
    runWorkerSetup({ configPath, envchain: args.cfEnvchain || args.envchain || "", keychainDir });
  }

  if (!skipOpenaiFill) {
    await fillOpenAiCustomOidc({
      setupUrl: connection.setupUrl,
      issuer: defaultIssuer(domain, zone),
      clientId,
      clientSecretPath: join(config.secrets_dir || ".secrets-cloud-oidc-sso-hub", "openai-client-secret.txt"),
      pin,
      testAccount: args.testAccount || `ssosmoke${dateStamp()}`
    });
  }

  console.log("\nOpenAI SSO bootstrap prepared.\n");
  console.log(`Domain: ${domain}`);
  console.log(`Zone: ${zone}`);
  console.log(`Config: ${configPath}`);
  console.log(`Callback: ${connection.callback}`);
  console.log(`Setup URL: ${connection.setupUrl}`);
  console.log(`Issuer: ${defaultIssuer(domain, zone)}`);
  console.log("Client secret: stored locally; not printed.");
}

async function ensureOpenAiDomain({ domain, zone, cloudflareEnv }) {
  console.log(`[openai] checking domain ${domain}`);
  await navigate(OPENAI_IDENTITY_DOMAINS_URL);
  await waitForReady();
  await waitForText(["添加域名", "Add domain", domain], 30_000).catch(() => null);

  const existing = await pageQuery(`return document.body.innerText.includes(${JSON.stringify(domain)});`);
  if (existing) {
    console.log(`[openai] domain already visible: ${domain}`);
    return;
  }

  await clickText(["添加域名", "Add domain"]);
  await waitForSelector("input[name='hostname'], input[placeholder*='company'], input");
  await fillField(["hostname", "yourcompany.com", "domain"], domain);
  await clickText(["添加", "Add"]);
  await waitForReady();

  const record = await waitForDnsRecord(domain, 45_000);
  if (!record) {
    await writeDebugSnapshot("domain-dns-record-not-found");
    throw new Error(`OpenAI domain was submitted, but DNS TXT instructions could not be extracted for ${domain}.`);
  }

  console.log(`[cloudflare] upserting OpenAI TXT verification for ${record.name}`);
  await upsertTxtRecord({ zone, record, cloudflareEnv });

  await clickText(["验证", "Verify"]).catch(async () => {
    await writeDebugSnapshot("verify-button-not-found");
    throw new Error(`DNS TXT was added, but the OpenAI Verify button was not found for ${domain}.`);
  });
  await waitForText(["已验证", "Verified", domain], 90_000);
  console.log(`[openai] domain verification path completed: ${domain}`);
}

async function ensureCustomOidcConnection() {
  console.log("[openai] opening SSO configuration");
  await navigate(OPENAI_IDENTITY_SSO_URL);
  await waitForReady();
  await sleep(1500);

  for (let attempt = 0; attempt < 10; attempt += 1) {
    const current = await extractConnection();
    if (current.callback) {
      return current;
    }

    const url = await currentUrl();
    if (url.includes("setup.auth.openai.com")) {
      await advanceOidcWizard();
      continue;
    }

    const clicked = await clickText([
      "管理单点登录",
      "Manage single sign-on",
      "ChatGPT SSO 设置",
      "ChatGPT SSO",
      "默认：关闭",
      "Default: Off",
      "关闭",
      "Off",
      "设置",
      "Set up",
      "Configure"
    ]).catch(() => false);
    if (!clicked) {
      await writeDebugSnapshot("sso-entry-not-found");
      throw new Error("Could not find the OpenAI Admin SSO setup entry.");
    }
    await sleep(2500);
  }

  await writeDebugSnapshot("custom-oidc-not-reached");
  throw new Error("Could not reach the Custom OIDC setup page.");
}

async function advanceOidcWizard() {
  const extracted = await extractConnection();
  if (extracted.callback) {
    return;
  }

  const clicked = await clickText([
    "Custom OIDC",
    "OIDC",
    "自定义 OIDC",
    "OpenID Connect",
    "ChatGPT",
    "继续",
    "Continue",
    "下一步",
    "Next",
    "创建",
    "Create",
    "开始",
    "Get started"
  ]).catch(() => false);
  if (!clicked) {
    await sleep(1500);
  } else {
    await waitForReady();
    await sleep(1500);
  }
}

async function fillOpenAiCustomOidc({ setupUrl, issuer, clientId, clientSecretPath, pin, testAccount }) {
  if (!setupUrl) {
    throw new Error("Missing setup URL for OpenAI Custom OIDC fill step.");
  }
  if (!existsSync(clientSecretPath)) {
    throw new Error(`Client secret file not found: ${clientSecretPath}. Run worker setup first.`);
  }

  const clientSecret = readFileSync(clientSecretPath, "utf8").trim();
  const discovery = `${issuer}/.well-known/openid-configuration`;
  console.log("[openai] filling Custom OIDC values in current Chrome session");

  await navigate(setupUrl);
  await waitForReady();
  await sleep(1500);

  for (let attempt = 0; attempt < 8; attempt += 1) {
    const state = await pageQuery(`
      const body = document.body.innerText;
      return {
        url: location.href,
        hasClientId: /Client ID|Client identifier/i.test(body),
        hasDiscovery: /Discovery|Issuer|Well-known|OpenID/i.test(body),
        hasCompleted: /Connection activated|Test successful|Single Sign-On Test succeeded/i.test(body)
      };
    `);
    if (state.hasCompleted) {
      console.log("[openai] connection already appears completed");
      return;
    }
    if (state.hasClientId || state.hasDiscovery) {
      break;
    }
    await clickText(["Custom OIDC", "OIDC", "继续", "Continue", "下一步", "Next"]).catch(() => null);
    await sleep(1500);
  }

  await fillField(["Client ID", "Client identifier", "client_id", "clientId"], clientId);
  await fillField(["Client secret", "Client Secret", "client_secret", "clientSecret"], clientSecret);
  await fillField(["Discovery", "Discovery Endpoint", "Well-known", "Issuer URL", "Issuer"], discovery);

  await clickText(["保存", "Save", "继续", "Continue", "下一步", "Next"]);
  await waitForReady();
  await sleep(2500);

  for (let attempt = 0; attempt < 10; attempt += 1) {
    const bodyState = await pageQuery(`
      const body = document.body.innerText;
      return {
        done: /Single Sign-On Test succeeded|Connection activated|Test successful/i.test(body),
        needsTest: /Test sign-in|Test SSO|测试|Test/i.test(body),
        needsContinue: /Continue|Next|Confirm|Activate|完成|继续|下一步|确认|启用/i.test(body),
        url: location.href
      };
    `);
    if (bodyState.done) {
      console.log("[openai] SSO test/activation already succeeded");
      return;
    }
    if (bodyState.url.includes(issuer.replace(/^https?:\/\//, "")) || bodyState.url.startsWith(issuer)) {
      await completeWorkerLogin({ testAccount, pin });
      await sleep(2500);
      continue;
    }
    if (bodyState.needsTest) {
      await clickText(["Test sign-in", "Test SSO", "测试登录", "测试"]);
      await sleep(2500);
      continue;
    }
    if (bodyState.needsContinue) {
      await clickText(["Continue", "Next", "Confirm", "Activate", "完成", "继续", "下一步", "确认", "启用"]).catch(() => null);
      await sleep(1800);
      continue;
    }
    await sleep(1500);
  }

  await writeDebugSnapshot("openai-fill-not-completed");
  throw new Error("Custom OIDC values were submitted, but test/activation did not reach a success state.");
}

async function completeWorkerLogin({ testAccount, pin }) {
  const host = await pageQuery(`return location.hostname;`);
  console.log(`[openai] completing Worker login on ${host}`);
  await fillField(["Prefix", "Email", "login", "account", "prefix"], testAccount);
  await fillField(["PIN", "pin"], pin);
  await clickText(["go", "Go", "继续", "Continue", "登录", "Login", "Sign in"]);
}

async function extractConnection() {
  return pageQuery(`
    const text = collectText();
    const values = collectValues();
    const haystack = [location.href, text, ...values].join("\\n");
    const callback = (haystack.match(/https:\\/\\/external\\.auth\\.openai\\.com\\/sso\\/oidc\\/[A-Za-z0-9_-]+\\/callback/) || [])[0] || "";
    const setupUrl = location.href.includes("setup.auth.openai.com") ? location.href : "";
    const connectionId = (haystack.match(/conn_[A-Za-z0-9]+/) || [])[0] || "";
    return { setupUrl, callback, connectionId };

    function collectText() {
      return document.body ? document.body.innerText || "" : "";
    }

    function collectValues() {
      return Array.from(document.querySelectorAll("input, textarea, code, pre"))
        .map((el) => el.value || el.innerText || el.textContent || "")
        .filter(Boolean);
    }
  `);
}

async function waitForDnsRecord(domain, timeoutMs) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const record = await pageQuery(`
      const domain = ${JSON.stringify(domain)};
      const values = Array.from(document.querySelectorAll("input, textarea, code, pre, td, div, span"))
        .map((el) => (el.value || el.innerText || el.textContent || "").trim())
        .filter(Boolean);
      const text = values.join("\\n");
      const token = values.find((value) => /openai[-_a-z0-9]*domain[-_a-z0-9]*verification|domain-verification|openai-verification/i.test(value));
      const quoted = text.match(/(?:TXT|Value|值|内容)[\\s\\S]{0,400}?([A-Za-z0-9_.=-]*openai[A-Za-z0-9_.=-]*(?:verification|verify)[A-Za-z0-9_.=-]*)/i);
      const content = token || (quoted && quoted[1]) || "";
      const nameValue = values.find((value) => value === domain || value.endsWith("." + domain) || /^@$/u.test(value));
      if (!content) return null;
      return { type: "TXT", name: nameValue && nameValue !== "@" ? nameValue : domain, content };
    `);
    if (record?.content) {
      return record;
    }
    await sleep(1500);
  }
  return null;
}

async function upsertTxtRecord({ zone, record, cloudflareEnv }) {
  const api = cloudflareApi(cloudflareEnv);
  if (!api) {
    throw new Error("Cloudflare credentials are required to create OpenAI domain verification TXT records.");
  }
  const zoneData = await cfRequest(api, `/zones?name=${encodeURIComponent(zone)}`);
  const zoneId = zoneData.result?.[0]?.id;
  if (!zoneId) {
    throw new Error(`Cloudflare zone not found: ${zone}`);
  }

  const listed = await cfRequest(api, `/zones/${zoneId}/dns_records?type=TXT&name=${encodeURIComponent(record.name)}`);
  const existing = (listed.result || []).find((item) => item.content === record.content);
  if (existing) {
    return;
  }

  const payload = { type: "TXT", name: record.name, content: record.content, ttl: 1 };
  await cfRequest(api, `/zones/${zoneId}/dns_records`, { method: "POST", body: payload });
}

function upsertTenantConfig(configPath, tenantPatch) {
  const config = readConfig(configPath);
  const tenants = Array.isArray(config.tenants) ? config.tenants : [];
  const existing = tenants.find((tenant) => normalizeDomain(tenant.domain) === tenantPatch.domain);
  const next = cleanObject({
    ...existing,
    ...tenantPatch,
    enabled: true,
    configure_dns: true,
    smoke: true
  });
  if (existing) {
    Object.assign(existing, next);
  } else {
    tenants.push(next);
  }
  config.tenants = tenants;
  mkdirSync(dirname(configPath), { recursive: true });
  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  console.log(`[config] saved tenant ${tenantPatch.domain}`);
}

function runWorkerSetup({ configPath, envchain, keychainDir }) {
  console.log("[worker] running Cloudflare setup");
  if (envchain) {
    const keychainArgs = keychainDir ? ["--keychain-dir", keychainDir] : [];
    const shell = [
      'export CLOUDFLARE_API_KEY="${CLOUDFLARE_GLOBAL_API_KEY:-$CLOUDFLARE_API_KEY}"',
      `${quote(process.execPath)} scripts/cli.mjs setup --config ${quote(configPath)}`
    ].join("; ");
    run("envchain", [...keychainArgs, envchain, "sh", "-lc", shell]);
    return;
  }
  run(process.execPath, ["scripts/cli.mjs", "setup", "--config", configPath]);
}

async function navigate(url) {
  const script = `on run argv
set targetUrl to item 1 of argv
set targetHost to item 2 of argv
tell application "Google Chrome"
  activate
  if (count of windows) is 0 then make new window
  set foundTab to false
  repeat with w from 1 to count of windows
    repeat with t from 1 to count of tabs of window w
      set tabUrl to URL of tab t of window w
      if tabUrl contains targetHost then
        set index of window w to 1
        set active tab index of window w to t
        set foundTab to true
        exit repeat
      end if
    end repeat
    if foundTab then exit repeat
  end repeat
  if not foundTab then
    tell front window to make new tab at end with properties {URL:targetUrl}
    set active tab index of front window to count of tabs of front window
  else
    set URL of active tab of front window to targetUrl
  end if
end tell
end run`;
  runOsa(script, [url, new URL(url).hostname]);
  await sleep(800);
}

async function ensureChrome() {
  const script = `tell application "Google Chrome"
activate
if (count of windows) is 0 then make new window
return URL of active tab of front window
end tell`;
  runOsa(script, []);
}

async function waitForReady(timeoutMs = 45_000) {
  await waitFor(() => pageQuery(`return document.readyState === "complete" || document.readyState === "interactive";`), timeoutMs);
}

async function waitForSelector(selector, timeoutMs = 30_000) {
  await waitFor(() => pageQuery(`return Boolean(document.querySelector(${JSON.stringify(selector)}));`), timeoutMs);
}

async function waitForText(texts, timeoutMs = 30_000) {
  const wanted = Array.isArray(texts) ? texts : [texts];
  await waitFor(() => pageQuery(`
    const text = document.body ? document.body.innerText : "";
    return ${JSON.stringify(wanted)}.some((item) => text.includes(item));
  `), timeoutMs);
}

async function waitFor(check, timeoutMs) {
  const started = Date.now();
  let lastError;
  while (Date.now() - started < timeoutMs) {
    try {
      if (await check()) {
        return true;
      }
    } catch (error) {
      lastError = error;
    }
    await sleep(500);
  }
  throw lastError || new Error(`Timed out after ${timeoutMs}ms.`);
}

async function currentUrl() {
  return pageQuery(`return location.href;`);
}

async function clickText(texts) {
  const clicked = await pageQuery(`
    const wanted = ${JSON.stringify(Array.isArray(texts) ? texts : [texts])};
    const elements = Array.from(document.querySelectorAll("button, a, [role='button'], [role='tab'], input[type='submit']"));
    const target = bestTextElement(elements, wanted);
    if (!target) return false;
    target.scrollIntoView({ block: "center", inline: "center" });
    target.click();
    return true;

    function bestTextElement(elements, wanted) {
      const visible = elements.filter(isVisible);
      for (const text of wanted) {
        const exact = visible.find((el) => norm(labelOf(el)) === norm(text));
        if (exact) return exact;
      }
      for (const text of wanted) {
        const contains = visible.find((el) => norm(labelOf(el)).includes(norm(text)));
        if (contains) return contains;
      }
      return null;
    }
    function labelOf(el) {
      return el.innerText || el.value || el.getAttribute("aria-label") || el.getAttribute("title") || "";
    }
    function norm(value) {
      return String(value || "").replace(/\\s+/g, " ").trim().toLowerCase();
    }
    function isVisible(el) {
      const style = getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      return style.visibility !== "hidden" && style.display !== "none" && rect.width > 0 && rect.height > 0;
    }
  `);
  if (!clicked) {
    throw new Error(`Could not click any of: ${texts.join(", ")}`);
  }
  await sleep(500);
  return true;
}

async function fillField(matchers, value) {
  const filled = await pageQuery(`
    const wanted = ${JSON.stringify(Array.isArray(matchers) ? matchers : [matchers])};
    const value = ${JSON.stringify(value)};
    const fields = Array.from(document.querySelectorAll("input, textarea"));
    const target = bestField(fields, wanted);
    if (!target) return false;
    target.scrollIntoView({ block: "center", inline: "center" });
    setNativeValue(target, value);
    target.dispatchEvent(new Event("input", { bubbles: true }));
    target.dispatchEvent(new Event("change", { bubbles: true }));
    return true;

    function bestField(fields, wanted) {
      const visible = fields.filter(isVisible).filter((el) => !["hidden", "checkbox", "radio"].includes(String(el.type || "").toLowerCase()));
      for (const text of wanted) {
        const exact = visible.find((el) => norm(fieldLabel(el)) === norm(text));
        if (exact) return exact;
      }
      for (const text of wanted) {
        const contains = visible.find((el) => norm(fieldLabel(el)).includes(norm(text)));
        if (contains) return contains;
      }
      return visible.find((el) => !el.value) || visible[0] || null;
    }
    function fieldLabel(el) {
      const id = el.id ? document.querySelector("label[for='" + CSS.escape(el.id) + "']") : null;
      const label = el.closest("label");
      const group = el.closest("div, section, fieldset");
      return [
        el.name,
        el.id,
        el.placeholder,
        el.getAttribute("aria-label"),
        id && id.innerText,
        label && label.innerText,
        group && group.innerText
      ].filter(Boolean).join(" ");
    }
    function setNativeValue(el, next) {
      const proto = el.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
      if (setter) setter.call(el, next);
      else el.value = next;
    }
    function norm(value) {
      return String(value || "").replace(/\\s+/g, " ").trim().toLowerCase();
    }
    function isVisible(el) {
      const style = getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      return style.visibility !== "hidden" && style.display !== "none" && rect.width > 0 && rect.height > 0;
    }
  `);
  if (!filled) {
    await writeDebugSnapshot(`field-not-found-${slugify(matchers[0] || "field")}`);
    throw new Error(`Could not fill field matching: ${matchers.join(", ")}`);
  }
  await sleep(300);
}

async function pageQuery(body) {
  const output = chromeEval(
    `JSON.stringify((() => { try { return (() => { ${body} })(); } catch (error) { return { __error: String(error && (error.stack || error.message) || error) }; } })())`
  );
  const parsed = JSON.parse(output || "null");
  if (parsed && typeof parsed === "object" && parsed.__error) {
    throw new Error(parsed.__error);
  }
  return parsed;
}

function chromeEval(js) {
  const script = `on run argv
set js to item 1 of argv
tell application "Google Chrome"
  tell active tab of front window to return execute javascript js
end tell
end run`;
  return runOsa(script, [js]).trim();
}

function runOsa(script, argv) {
  const result = spawnSync("osascript", ["-", ...argv], {
    input: script,
    encoding: "utf8",
    maxBuffer: 1024 * 1024 * 8
  });
  if (result.status !== 0) {
    throw new Error((result.stderr || result.stdout || "osascript failed").trim());
  }
  return result.stdout || "";
}

async function pageSnapshot() {
  return pageQuery(`
    const fields = Array.from(document.querySelectorAll("input, textarea, button, a, [role='button'], [role='tab']"))
      .slice(0, 200)
      .map((el, index) => ({
        index,
        tag: el.tagName,
        role: el.getAttribute("role") || "",
        type: el.getAttribute("type") || "",
        name: el.getAttribute("name") || "",
        placeholder: el.getAttribute("placeholder") || "",
        aria: el.getAttribute("aria-label") || "",
        text: (el.tagName === "INPUT" || el.tagName === "TEXTAREA" ? "[value-redacted]" : (el.innerText || ""))
          .replace(/\\s+/g, " ").trim().slice(0, 180)
      }));
    return {
      url: location.href,
      title: document.title,
      body: (document.body?.innerText || "").replace(/\\s+/g, " ").trim().slice(0, 5000),
      fields
    };
  `);
}

async function writeDebugSnapshot(label) {
  const outputDir = ".generated/cloud-oidc-sso-hub";
  mkdirSync(outputDir, { recursive: true });
  const file = join(outputDir, `openai-admin-${label}-${Date.now()}.json`);
  writeFileSync(file, `${JSON.stringify(await pageSnapshot(), null, 2)}\n`, { mode: 0o600 });
  console.error(`[debug] wrote page snapshot: ${file}`);
}

async function cloudflareEnvForArgs(parsedArgs) {
  const namespace = parsedArgs.cfEnvchain || parsedArgs.envchain || "";
  if (!namespace) {
    return process.env;
  }
  const keychainDir = parsedArgs.keychainDir || `${process.env.HOME}/Library/Keychains/envchain-scopes`;
  const code = [
    "const keys=['CLOUDFLARE_EMAIL','CLOUDFLARE_GLOBAL_API_KEY','CLOUDFLARE_API_KEY','CLOUDFLARE_API_TOKEN','CLOUDFLARE_ACCOUNT_ID'];",
    "const out={}; for (const key of keys) out[key]=process.env[key]||'';",
    "console.log(JSON.stringify(out));"
  ].join("");
  const result = spawnSync("envchain", ["--keychain-dir", keychainDir, namespace, process.execPath, "-e", code], {
    encoding: "utf8",
    maxBuffer: 1024 * 1024
  });
  if (result.status !== 0) {
    throw new Error(`envchain ${namespace} failed: ${(result.stderr || result.stdout).trim()}`);
  }
  return { ...process.env, ...JSON.parse(result.stdout) };
}

function cloudflareApi(env) {
  if (env.CLOUDFLARE_API_TOKEN) {
    return {
      headers: {
        Authorization: `Bearer ${env.CLOUDFLARE_API_TOKEN}`,
        "Content-Type": "application/json"
      }
    };
  }
  const key = env.CLOUDFLARE_GLOBAL_API_KEY || env.CLOUDFLARE_API_KEY;
  if (env.CLOUDFLARE_EMAIL && key) {
    return {
      headers: {
        "X-Auth-Email": env.CLOUDFLARE_EMAIL,
        "X-Auth-Key": key,
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
    throw new Error(`Cloudflare returned non-JSON response: ${text.slice(0, 160)}`);
  }
  if (!response.ok || data.success === false) {
    throw new Error(`Cloudflare API error: ${JSON.stringify(data.errors || data)}`);
  }
  return data;
}

function readConfig(path) {
  if (!existsSync(path)) {
    return {
      client_id: DEFAULT_CLIENT_ID,
      secrets_dir: ".secrets-cloud-oidc-sso-hub",
      tenants: []
    };
  }
  return JSON.parse(readFileSync(path, "utf8"));
}

function firstTenant(config, domain = "") {
  const tenants = Array.isArray(config.tenants) ? config.tenants : [];
  if (!domain) {
    return tenants[0] || null;
  }
  return tenants.find((tenant) => normalizeDomain(tenant.domain) === normalizeDomain(domain)) || null;
}

function pinValue(parsedArgs, config) {
  if (parsedArgs.pin) {
    return parsedArgs.pin;
  }
  const envName = parsedArgs.pinEnv || config.pin_env || "OIDC_PIN";
  const value = process.env[envName];
  if (!value) {
    throw new Error(`Missing PIN. Set ${envName}, or pass --pin-env/--pin.`);
  }
  return value;
}

function defaultIssuer(domain, zone) {
  return domain === zone ? `https://auth.${domain}` : `https://${domain}`;
}

function parentZone(domain) {
  const parts = domain.split(".");
  if (parts.length < 2) {
    return domain;
  }
  return parts.slice(-2).join(".");
}

function parseConnectionId(value) {
  return String(value || "").match(/conn_[A-Za-z0-9]+/)?.[0] || "";
}

function cleanObject(input) {
  return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== "" && value !== undefined && value !== null));
}

function requiredArg(name, value) {
  if (!value) {
    throw new Error(`--${name} is required`);
  }
  return value;
}

function normalizeDomain(domain) {
  const value = String(domain || "").trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/u, "");
  if (!/^[a-z0-9.-]+\.[a-z]{2,}$/u.test(value)) {
    throw new Error(`Invalid domain: ${domain}`);
  }
  return value;
}

function slugify(value) {
  return String(value).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

function dateStamp() {
  const now = new Date();
  const pad = (value) => String(value).padStart(2, "0");
  return `${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}${pad(now.getUTCSeconds())}`;
}

function parseArgs(argv) {
  const parsed = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "-h" || arg === "--help") {
      parsed.help = true;
      continue;
    }
    if (!arg.startsWith("--")) {
      parsed._.push(arg);
      continue;
    }
    if (arg.startsWith("--skip-")) {
      parsed[toCamel(arg.slice(2))] = true;
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

function run(cmd, argv) {
  const result = spawnSync(cmd, argv, { stdio: "inherit", env: process.env });
  if (result.status !== 0) {
    throw new Error(`${cmd} ${argv.join(" ")} failed with exit code ${result.status}`);
  }
}

function quote(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function printHelp() {
  console.log(`Usage:
  cloud-oidc openai bootstrap --domain pokeface.0day3.com --zone 0day3.com --cf-envchain cf-migrate-target
  cloud-oidc openai snapshot

Bootstrap flow:
  1. Reuse the current Google Chrome session logged into admin.openai.com.
  2. Add and verify the OpenAI domain, using Cloudflare DNS for TXT verification.
  3. Open/create ChatGPT Custom OIDC SSO and extract callback/setup URL.
  4. Save config/tenants.json and run the shared Worker setup.
  5. Fill OpenAI Custom OIDC values and run the browser SSO test.

Required:
  --domain              Verified email domain/subdomain for OpenAI users.
  --zone                Cloudflare zone, for example 0day3.com.

Useful:
  --config              Defaults to config/tenants.json.
  --cf-envchain         Load Cloudflare credentials from envchain, e.g. cf-migrate-target.
  --keychain-dir        Defaults to ~/Library/Keychains/envchain-scopes when --cf-envchain is used.
  --pin-env             Defaults to config pin_env or OIDC_PIN.
  --pin                 Direct PIN value. Avoid this in shell history.
  --test-account        Prefix/email used for the final OpenAI SSO test.
  --skip-domain         Do not add/verify domain in OpenAI Admin.
  --skip-worker         Do not run Cloudflare Worker setup.
  --skip-openai-fill    Stop after config + Worker setup.
`);
}
