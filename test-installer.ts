/**
 * Unit tests for the managed om-core installer and the resolution/policy logic around it.
 * Node-only — no `vscode` module, no live runtime — unlike test-harness.ts, which is an
 * integration suite that connects to a running engine.
 *
 * Usage:  npm run test:installer
 */

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { spawnSync } from "child_process";
import { installOmCore, managedCoreDir, OM_CORE_PINNED_COMMIT } from "./src/omCoreInstaller";
import { describeOmCorePath, looksLikeOmCore } from "./src/engineStatus";
import { installBlockedReason } from "./src/runtimePolicy";

let failures = 0;

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(`assertion failed: ${msg}`);
}

async function test(name: string, fn: () => void | Promise<void>): Promise<void> {
  try { await fn(); console.log(`  ✓ ${name}`); }
  catch (e: any) { failures++; console.log(`  ✗ ${name}: ${e?.message || e}`); }
}

function git(args: string[], cwd: string): void {
  const r = spawnSync("git", args, { cwd, stdio: "pipe" });
  if (r.status !== 0) throw new Error(`git ${args[0]}: ${r.stderr?.toString()}`);
}

/** A minimal om-core-shaped repo in a tmp dir; returns { remote, pin }. */
function makeFixtureRepo(root: string, tag = ""): { remote: string; pin: string } {
  const remote = path.join(root, "remote-om-core");
  fs.mkdirSync(path.join(remote, "lib_runtime"), { recursive: true });
  fs.mkdirSync(path.join(remote, "lib_openm"), { recursive: true });
  // Empty dirs are invisible to git: the checkout only has them if they contain files.
  fs.writeFileSync(path.join(remote, "lib_runtime", "x.py"), "# fixture\n");
  fs.writeFileSync(path.join(remote, "lib_openm", "x.py"), "# fixture\n");
  fs.writeFileSync(path.join(remote, "main.py"), "# fixture " + tag + "\n");
  git(["init", "--quiet"], remote);
  git(["add", "-A"], remote);
  git(["-c", "user.name=t", "-c", "user.email=t@t", "commit", "--quiet", "-m", "fixture " + tag], remote);
  const pin = spawnSync("git", ["rev-parse", "HEAD"], { cwd: remote }).stdout.toString().trim();
  return { remote, pin };
}

async function main(): Promise<void> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "om-tools-installer-test-"));
  const hasGit = spawnSync("git", ["--version"], { stdio: "ignore" }).status === 0;
  try {
    console.log("\n=== policy ===");
    await test("installBlockedReason blocks Restricted Mode", () => {
      assert(installBlockedReason(false) !== null, "untrusted workspace must block install");
      assert(installBlockedReason(true) === null, "trusted workspace must not block install");
    });

    console.log("\n=== resolution order ===");
    const omcoreDir = path.join(root, "a-checkout");
    fs.mkdirSync(path.join(omcoreDir, "lib_runtime"), { recursive: true });
    fs.mkdirSync(path.join(omcoreDir, "lib_openm"), { recursive: true });
    fs.writeFileSync(path.join(omcoreDir, "main.py"), "");
    const managedDir = path.join(root, "managed", "om-core");
    fs.mkdirSync(path.join(managedDir, "lib_runtime"), { recursive: true });
    fs.mkdirSync(path.join(managedDir, "lib_openm"), { recursive: true });
    fs.writeFileSync(path.join(managedDir, "main.py"), "");
    const wsDir = path.join(root, "ws");
    fs.mkdirSync(path.join(wsDir, "lib_runtime"), { recursive: true });
    fs.mkdirSync(path.join(wsDir, "lib_openm"), { recursive: true });
    fs.writeFileSync(path.join(wsDir, "main.py"), "");

    const base = { setting: "", settingScope: null, env: "", managed: "", workspaceFolders: [] as string[], approvedFolders: [] as string[] };
    await test("managed tier: setting > env > managed > workspace > none", () => {
      assert(describeOmCorePath({ ...base }).source === "none", "nothing set");
      assert(describeOmCorePath({ ...base, workspaceFolders: [wsDir] }).source === "workspace", "workspace picked up");
      assert(describeOmCorePath({ ...base, managed: managedDir, workspaceFolders: [wsDir] }).source === "managed", "managed beats workspace");
      assert(describeOmCorePath({ ...base, env: omcoreDir, managed: managedDir }).source === "env", "env beats managed");
      assert(describeOmCorePath({ ...base, setting: omcoreDir, env: omcoreDir, managed: managedDir }).source === "setting", "setting beats everything");
    });
    await test("managed tier: a stale managed path is reported, not used", () => {
      const gone = path.join(root, "deleted-managed");
      const info = describeOmCorePath({ ...base, managed: gone });
      assert(info.source === "none", "stale managed path must not resolve");
      assert(info.ignored.some((i) => i.value === gone), "stale managed path must be listed under ignored");
    });
    await test("managedCoreDir nests under globalStorage", () => {
      const d = managedCoreDir(path.join(root, "gs"));
      assert(path.dirname(d) === path.join(root, "gs"), "managed dir is a direct child of globalStorage");
    });

    console.log("\n=== installer (local fixture repo) ===");
    if (!hasGit) {
      console.log("  - skipped: git not on PATH");
    } else {
      const { remote, pin } = makeFixtureRepo(root);
      const dest = path.join(root, "store", "om-core");
      await test("installOmCore clones the pinned commit and verifies it", async () => {
        let out = "";
        await installOmCore(dest, { repo: remote, pin, skipUvSync: true, onOutput: (s) => { out += s; } });
        assert(looksLikeOmCore(dest), "installed dir must look like om-core");
        const head = spawnSync("git", ["rev-parse", "HEAD"], { cwd: dest }).stdout.toString().trim();
        assert(head === pin, `HEAD ${head} must equal pin ${pin}`);
        assert(fs.readdirSync(path.dirname(dest)).every((n) => !n.includes(".tmp-")), "no tmp dirs left behind");
      });
      await test("installOmCore rejects a wrong pin", async () => {
        const bad = path.join(root, "bad", "om-core");
        let threw = false;
        try { await installOmCore(bad, { repo: remote, pin: "0".repeat(40), skipUvSync: true }); }
        catch { threw = true; }
        assert(threw, "unknown commit must fail the fetch/verify");
        assert(!fs.existsSync(bad), "failed install must not leave a checkout");
      });
      await test("installOmCore cleans stale tmp dirs and reinstalls over an existing copy", async () => {
        // A leftover tmp dir from a crashed install and an existing install are both swept up.
        fs.mkdirSync(`${dest}.tmp-deadbeef`, { recursive: true });
        fs.writeFileSync(path.join(dest, "stale-marker"), "x");
        await installOmCore(dest, { repo: remote, pin, skipUvSync: true });
        assert(looksLikeOmCore(dest), "reinstall produces a valid checkout");
        assert(!fs.existsSync(path.join(dest, "stale-marker")), "old install replaced, not merged");
        assert(fs.readdirSync(path.dirname(dest)).every((n) => !n.includes(".tmp-")), "stale tmp dirs cleaned");
      });
      await test("pin constant is a full 40-char hash (never a ref)", () => {
        assert(/^[0-9a-f]{40}$/.test(OM_CORE_PINNED_COMMIT), "OM_CORE_PINNED_COMMIT must be a full commit hash");
      });
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
  console.log(failures ? `\n${failures} FAILED` : "\nALL PASSED");
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error("Fatal:", e); process.exit(1); });
