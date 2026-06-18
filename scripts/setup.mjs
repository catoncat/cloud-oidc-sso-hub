#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

const args = process.argv.slice(2);
const configPath = option(args, "--config") ?? "config/tenants.json";
const skipDeploy = has(args, "--skip-deploy") || has(args, "--no-deploy");
const skipDns = has(args, "--skip-dns") || has(args, "--no-dns");
const skipSmoke = has(args, "--skip-smoke") || has(args, "--no-smoke");
const forceSecrets = has(args, "--force-secrets");
const config = readConfig(configPath);
const tenants = (config.tenants ?? []).filter((tenant) => tenant.enabled !== false);

if (!tenants.length) {
  throw new Error(`No enabled tenants in ${configPath}. Run: cloud-oidc config add ...`);
}

for (const tenant of tenants) {
  runSetupForTenant(config, tenant);
}

function runSetupForTenant(config, tenant) {
  const domain = required(tenant.domain, "tenant.domain");
  const callback = required(tenant.callback || tenant.redirect_uri, `${domain}.callback`);
  const argv = [
    "scripts/setup-sso.mjs",
    "--domain", domain,
    "--zone", tenant.zone || domain,
    "--callback", callback,
    "--client-id", tenant.client_id || config.client_id || "openai-enterprise-sso",
    "--worker-name", config.worker_name || "cloud-oidc-sso-hub",
    "--kv-title", config.kv_title || `${config.worker_name || "cloud-oidc-sso-hub"}-auth`,
    "--output-dir", config.output_dir || ".generated/cloud-oidc-sso-hub",
    "--secrets-dir", config.secrets_dir || ".secrets-cloud-oidc-sso-hub",
    "--tenant-registry", config.tenant_registry || ".generated/cloud-oidc-sso-hub/tenants.json",
    "--yes"
  ];

  addArg(argv, "--setup-url", tenant.setup_url);
  addArg(argv, "--connection-id", tenant.connection_id);
  addArg(argv, "--app-login-url", tenant.app_login_url);
  addArg(argv, "--issuer", tenant.issuer);
  addArg(argv, "--shortcut-host", tenant.shortcut_host);
  addArg(argv, "--idp-name", tenant.idp_name);
  addArg(argv, "--account-id", config.account_id);
  addArg(argv, "--kv-id", config.kv_id);
  addArg(argv, "--pin", secretValue(config.pin, config.pin_env));
  addArg(argv, "--admin-token", secretValue(config.admin_token, config.admin_token_env));
  addArg(argv, "--invite-code", secretValue(config.invite_code, config.invite_code_env));
  if (skipDeploy) argv.push("--no-deploy");
  if (skipDns || tenant.configure_dns === false) argv.push("--no-dns");
  if (skipSmoke || tenant.smoke === false) argv.push("--no-smoke");
  if (forceSecrets) argv.push("--force-secrets");

  const result = spawnSync(process.execPath, argv, { stdio: "inherit", env: process.env });
  if (result.status !== 0) {
    throw new Error(`setup failed for ${domain} with exit code ${result.status}`);
  }
}

function readConfig(path) {
  if (!existsSync(path)) {
    throw new Error(`Config not found: ${path}. Run: cloud-oidc config init`);
  }
  return JSON.parse(readFileSync(path, "utf8"));
}

function secretValue(configured, envName) {
  if (configured) return configured;
  if (envName && process.env[envName]) return process.env[envName];
  return "";
}

function addArg(argv, name, value) {
  if (value !== undefined && value !== null && String(value).trim() !== "") {
    argv.push(name, String(value).trim());
  }
}

function required(value, label) {
  if (value === undefined || value === null || String(value).trim() === "") {
    throw new Error(`${label} is required`);
  }
  return String(value).trim();
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
