#!/usr/bin/env node
/**
 * Guard against committing sensitive or machine-specific data.
 *
 * Usage:
 *   node scripts/check-sensitive.js --staged   # files staged for commit (pre-commit hook)
 *   node scripts/check-sensitive.js --all      # every tracked file (manual run / CI)
 *
 * Checks:
 *   1. Forbidden paths (docs/, build output, env files, local configs, keys).
 *   2. File contents: tokens and private keys, local user paths, internal project names,
 *      private IP addresses, personal e-mail addresses.
 *
 * False positive? Put `check-sensitive: allow` in a comment on that line.
 * Exit code: 0 = clean, 1 = findings, 2 = script error.
 */
"use strict";

const { execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const SELF = path.relative(process.cwd(), __filename).split(path.sep).join("/");
const ALLOW_MARK = "check-sensitive: allow";
const MAX_BYTES = 2 * 1024 * 1024;

/** Paths that must never be committed. */
const FORBIDDEN_PATHS = [
  { re: /^docs\//, why: "docs/ is kept out of the repository" },
  { re: /^(dist|out)\//, why: "build output" },
  { re: /(^|\/)node_modules\//, why: "dependencies" },
  { re: /(^|\/)\.env(\..+)?$/, why: "environment file" },
  { re: /\.local\.json$/, why: "local config" },
  { re: /\.vsix$/, why: "packaged extension" },
  { re: /\.(pem|key|p12|pfx|jks|keystore)$/i, why: "key / certificate file" },
  { re: /(^|\/)id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$/, why: "SSH key" },
  { re: /(^|\/)\.npmrc$/, why: "may contain an npm auth token" },
];

/** Content rules. `skip` = paths the rule does not apply to. */
const CONTENT_RULES = [
  { name: "private key", re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { name: "GitHub token", re: /\b(ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{30,}|\bgithub_pat_[A-Za-z0-9_]{30,}/ },
  { name: "AWS access key", re: /\b(AKIA|ASIA)[0-9A-Z]{16}\b/ },
  { name: "OpenAI/Anthropic key", re: /\bsk-(ant-)?[A-Za-z0-9_-]{20,}/ },
  { name: "Slack token", re: /\bxox[abprs]-[A-Za-z0-9-]{10,}/ },
  { name: "Google API key", re: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { name: "npm token", re: /\bnpm_[A-Za-z0-9]{36}\b/ },
  { name: "JWT", re: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/ },
  {
    name: "hard-coded secret",
    re: /\b(api[_-]?key|secret|token|passw(or)?d|pwd|auth)\w*["']?\s*[:=]\s*["'][^"'\s$]{8,}["']/i,
  },
  { name: "URL with credentials", re: /\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@"']+:[^\s/@"']+@/i },
  { name: "local home path", re: /\/home\/[A-Za-z0-9._-]+\/|\/Users\/[A-Za-z0-9._-]+\/|\b[A-Za-z]:[\\/]+Users[\\/]+[^\\/\s"'`]+/ },
  { name: "internal project name", re: /lotrix/i },
  {
    name: "private IP address",
    re: /\b(10\.\d{1,3}|192\.168|172\.(1[6-9]|2\d|3[01]))\.\d{1,3}\.\d{1,3}\b/,
    skip: [/^package-lock\.json$/],
  },
  {
    name: "personal e-mail",
    re: /[A-Za-z0-9._%+-]+@(?!(users\.noreply\.github\.com|example\.(com|org)|noreply\.)\b)[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/,
    skip: [/^LICENSE$/, /^package-lock\.json$/],
  },
];

function git(args, opts = {}) {
  return execFileSync("git", args, { maxBuffer: 64 * 1024 * 1024, ...opts });
}

function listFiles(mode) {
  const out =
    mode === "staged"
      ? git(["diff", "--cached", "--name-only", "--diff-filter=ACMR", "-z"])
      : git(["ls-files", "-z"]);
  return out.toString("utf8").split("\0").filter(Boolean);
}

function readFile(mode, file) {
  // Staged mode reads the index, so it checks exactly what will be committed,
  // not the working-tree version. --all mode reads the working tree.
  return mode === "staged" ? git(["show", ":" + file]) : fs.readFileSync(file);
}

function main() {
  const mode = process.argv.includes("--all") ? "all" : process.argv.includes("--staged") ? "staged" : null;
  if (!mode) {
    console.error("Usage: node scripts/check-sensitive.js --staged | --all");
    process.exit(2);
  }

  const files = listFiles(mode);
  const findings = [];

  for (const file of files) {
    for (const rule of FORBIDDEN_PATHS) {
      if (rule.re.test(file)) findings.push(`${file}: forbidden path (${rule.why})`);
    }
    if (file === SELF) continue; // the rules themselves would match

    let buf;
    try {
      buf = readFile(mode, file);
    } catch {
      continue; // deleted in working tree, submodule, etc.
    }
    if (buf.length > MAX_BYTES || buf.includes(0)) continue; // binary or huge

    const lines = buf.toString("utf8").split(/\r?\n/);
    lines.forEach((line, i) => {
      if (line.includes(ALLOW_MARK)) return;
      for (const rule of CONTENT_RULES) {
        if (rule.skip && rule.skip.some((re) => re.test(file))) continue;
        const m = line.match(rule.re);
        if (m) {
          const shown = m[0].length > 60 ? m[0].slice(0, 57) + "..." : m[0];
          findings.push(`${file}:${i + 1}: ${rule.name}: ${shown}`);
        }
      }
    });
  }

  if (findings.length) {
    console.error(`\ncheck-sensitive: ${findings.length} problem(s) found\n`);
    for (const f of findings) console.error("  " + f);
    console.error(
      `\nRemove the data (or unstage the file). For a false positive, add "${ALLOW_MARK}"` +
        " in a comment on that line.\n"
    );
    process.exit(1);
  }
  console.log(`check-sensitive: ${files.length} file(s) checked, no problems.`);
}

try {
  main();
} catch (e) {
  console.error("check-sensitive: " + (e && e.message ? e.message : e));
  process.exit(2);
}
