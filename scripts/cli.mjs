#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
process.chdir(repoRoot);

const args = process.argv.slice(2);
const command = args[0] ?? "help";

try {
  await main();
} catch (error) {
  console.error(`[error] ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}

async function main() {
  switch (command) {
    case "help":
    case "--help":
    case "-h":
      return help();
    case "config":
      return configCommand(args.slice(1));
    case "setup":
      return runNode("scripts/setup.mjs", args.slice(1));
    case "deploy":
      return run("npx", ["wrangler", "deploy", "--config", generatedWranglerPath(args.slice(1))]);
    case "token-path":
      return console.log(resolve(repoRoot, ".secrets-cloud-oidc-sso-hub/admin-token.txt"));
    default:
      throw new Error(`Unknown command: ${command}. Run: cloud-oidc help`);
  }
}

function help() {
  console.log(`cloud-oidc multi-tenant OIDC Worker CLI

Config:
  cloud-oidc config init
  cloud-oidc config show
  cloud-oidc config add --domain research.example.com --zone example.com --callback CALLBACK --setup-url SETUP_URL
  cloud-oidc config remove --domain research.example.com
  cloud-oidc config set --worker-name cloud-oidc-sso-hub --kv-id KV_ID --account-id ACCOUNT_ID

Deploy:
  cloud-oidc setup
  cloud-oidc setup --skip-deploy
  cloud-oidc setup --skip-dns
  cloud-oidc setup --skip-smoke

Secrets:
  export OIDC_PIN='...'
  export OIDC_SSO_ADMIN_TOKEN='...'
  export OIDC_SSO_INVITE_CODE='...'
`);
}

function configCommand(rest) {
  const sub = rest[0] ?? "show";
  if (sub === "init") return initConfig(rest.slice(1));
  if (sub === "show" || sub === "list") return printJson(readConfig(configPath(rest.slice(1))));
  if (sub === "add") return addTenant(rest.slice(1));
  if (sub === "remove" || sub === "rm") return removeTenant(rest.slice(1));
  if (sub === "set") return setConfig(rest.slice(1));
  throw new Error(`Unknown config command: ${sub}`);
}

function initConfig(rest) {
  const path = configPath(rest);
  if (existsSync(path) && !has(rest, "--force")) {
    console.log(`[ok] config exists: ${path}`);
    return;
  }
  writeConfig(path, defaultConfig());
  console.log(`[ok] config initialized: ${path}`);
}

function addTenant(rest) {
  const path = configPath(rest);
  const config = readConfig(path);
  const domain = normalizeDomain(requiredOption(rest, "--domain"));
  const zone = normalizeDomain(option(rest, "--zone") ?? domain);
  const callback = requiredOption(rest, "--callback");
  const setupUrl = option(rest, "--setup-url") ?? "";
  const connectionId = option(rest, "--connection-id") ?? "";
  const appLoginUrl = option(rest, "--app-login-url") ?? "";
  const issuer = option(rest, "--issuer") ?? "";
  const shortcutHost = option(rest, "--shortcut-host") ?? "";
  const idpName = option(rest, "--idp-name") ?? "";
  const clientId = option(rest, "--client-id") ?? "";
  const next = {
    domain,
    zone,
    callback,
    setup_url: setupUrl,
    connection_id: connectionId,
    app_login_url: appLoginUrl,
    issuer,
    shortcut_host: shortcutHost,
    idp_name: idpName,
    client_id: clientId,
    enabled: !has(rest, "--disabled"),
    configure_dns: !has(rest, "--no-dns"),
    smoke: !has(rest, "--no-smoke")
  };
  const tenants = Array.isArray(config.tenants) ? config.tenants : [];
  const existing = tenants.find((tenant) => normalizeDomain(tenant.domain) === domain);
  const cleaned = cleanObject(next);
  if (existing) Object.assign(existing, cleaned);
  else tenants.push(cleaned);
  config.tenants = tenants;
  writeConfig(path, config);
  console.log(`[ok] tenant saved: ${domain}`);
}

function removeTenant(rest) {
  const path = configPath(rest);
  const config = readConfig(path);
  const domain = normalizeDomain(requiredOption(rest, "--domain"));
  config.tenants = (config.tenants ?? []).filter((tenant) => normalizeDomain(tenant.domain) !== domain);
  writeConfig(path, config);
  console.log(`[ok] tenant removed: ${domain}`);
}

function setConfig(rest) {
  const path = configPath(rest);
  const config = readConfig(path);
  const mapping = {
    "--worker-name": "worker_name",
    "--kv-title": "kv_title",
    "--kv-id": "kv_id",
    "--account-id": "account_id",
    "--output-dir": "output_dir",
    "--secrets-dir": "secrets_dir",
    "--tenant-registry": "tenant_registry",
    "--client-id": "client_id",
    "--pin-env": "pin_env",
    "--admin-token-env": "admin_token_env",
    "--invite-code-env": "invite_code_env"
  };
  for (const [flag, key] of Object.entries(mapping)) {
    const value = option(rest, flag);
    if (value !== null) config[key] = value;
  }
  writeConfig(path, config);
  console.log("[ok] config updated");
}

function defaultConfig() {
  return {
    worker_name: "cloud-oidc-sso-hub",
    kv_title: "cloud-oidc-sso-hub-auth",
    kv_id: "",
    account_id: "",
    output_dir: ".generated/cloud-oidc-sso-hub",
    secrets_dir: ".secrets-cloud-oidc-sso-hub",
    tenant_registry: ".generated/cloud-oidc-sso-hub/tenants.json",
    client_id: "openai-enterprise-sso",
    pin_env: "OIDC_PIN",
    admin_token_env: "OIDC_SSO_ADMIN_TOKEN",
    invite_code_env: "OIDC_SSO_INVITE_CODE",
    tenants: []
  };
}

function readConfig(path) {
  if (!existsSync(path)) {
    return defaultConfig();
  }
  return { ...defaultConfig(), ...JSON.parse(readFileSync(path, "utf8")) };
}

function writeConfig(path, config) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
}

function configPath(rest) {
  return option(rest, "--config") ?? "config/tenants.json";
}

function generatedWranglerPath(rest) {
  const config = readConfig(configPath(rest));
  return `${config.output_dir || ".generated/cloud-oidc-sso-hub"}/wrangler.jsonc`;
}

function normalizeDomain(domain) {
  const value = String(domain || "").trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/u, "");
  if (!/^[a-z0-9.-]+\.[a-z]{2,}$/u.test(value)) {
    throw new Error(`Invalid domain: ${domain}`);
  }
  return value;
}

function cleanObject(input) {
  return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== "" && value !== undefined));
}

function requiredOption(rest, name) {
  const value = option(rest, name);
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function option(rest, name) {
  const index = rest.indexOf(name);
  if (index < 0) return null;
  const value = rest[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a value`);
  return value;
}

function has(rest, name) {
  return rest.includes(name);
}

function runNode(script, rest) {
  return run(process.execPath, [script, ...rest]);
}

function run(cmd, argv) {
  const result = spawnSync(cmd, argv, { stdio: "inherit", env: process.env });
  if (result.status !== 0) {
    throw new Error(`${cmd} ${argv.join(" ")} failed with exit code ${result.status}`);
  }
}

function printJson(value) {
  console.log(JSON.stringify(value, null, 2));
}
