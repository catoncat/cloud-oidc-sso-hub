import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { generateKeyPairSync, randomBytes, randomInt } from "node:crypto";
import { join } from "node:path";

const outputDir = ".secrets";
mkdirSync(outputDir, { recursive: true });

const clientSecretPath = join(outputDir, "openai-client-secret.txt");
const pinPath = join(outputDir, "global-pin.txt");
const privateKeyPath = join(outputDir, "jwt-private-key.pem");
const publicJwkPath = join(outputDir, "jwt-public-jwk.json");

const { privateKey, publicKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicExponent: 0x10001
});

const publicJwk = publicKey.export({ format: "jwk" });
publicJwk.alg = "RS256";
publicJwk.use = "sig";
publicJwk.kid = randomBytes(12).toString("base64url");

writeFileSync(privateKeyPath, privateKey.export({ type: "pkcs8", format: "pem" }));
writeFileSync(publicJwkPath, `${JSON.stringify(publicJwk)}\n`);

if (!existsSync(clientSecretPath)) {
  writeFileSync(clientSecretPath, `${randomBytes(32).toString("base64url")}\n`);
}

if (!existsSync(pinPath)) {
  writeFileSync(pinPath, `${String(randomInt(0, 1_000_000)).padStart(6, "0")}\n`);
}

console.log(`Wrote secrets to ${outputDir}/`);
console.log("Upload them with wrangler secret put before deploying.");
