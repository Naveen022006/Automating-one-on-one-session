import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

// A secrets file placed in the checkout (prod.env, .env.production, a private key) must reach neither git nor an image:
// the Dockerfile's build stage runs `COPY . .`. These checks read the ignore files themselves.

const read = (name: string) => readFileSync(join(process.cwd(), name), "utf8").split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));

test(".gitignore ignores env files and key material but keeps the documented template tracked", () => {
  const lines = read(".gitignore");
  for (const pattern of [".env", ".env*", "*.env", "*.pem", "*.key"]) assert.ok(lines.includes(pattern), `.gitignore must contain ${pattern}`);
  assert.ok(lines.indexOf("!.env.example") > lines.indexOf(".env*"), "the !.env.example exception must come after .env*");
});

test(".dockerignore keeps env files and key material out of the build context at any depth, except the template", () => {
  const lines = read(".dockerignore");
  for (const pattern of ["**/.env", "**/.env*", "**/*.env", "**/*.pem", "**/*.key"]) assert.ok(lines.includes(pattern), `.dockerignore must contain ${pattern}`);
  assert.ok(lines.indexOf("!.env.example") > lines.indexOf("**/.env*"), "the !.env.example exception must come after the env patterns");
});

test("the deployment guide never tells anyone to keep an env file inside the repository", () => {
  const doc = readFileSync(join(process.cwd(), "doc", "08-deployment.md"), "utf8");
  for (const m of doc.matchAll(/--env-file\s+(\S+)/g)) {
    assert.match(m[1], /^(~\/|\/)/, `--env-file ${m[1]} must be a path outside the repository`);
  }
  assert.ok(!/--env-file\s+prod\.env/.test(doc));
});
