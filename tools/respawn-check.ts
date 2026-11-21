import { EmbeddedBackend } from "../src/backend";
// Respawn smoke for EmbeddedBackend: kill the worker mid-session and verify
// queries revive with a fresh_runtime marker, mutations error (never replayed),
// and events keep flowing on the respawned engine.
// Run: npm run test:respawn   (needs a built ts_runtime — OM_TS_RUNTIME_DIR override)
const DIST = `${process.env.OM_TS_RUNTIME_DIR || "../ts_runtime"}/dist`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
    const b = new EmbeddedBackend({ workerPath: `${DIST}/engineWorker.cjs`, wasmPath: `${DIST}/om_engine.wasm` });
    let exits = 0, respawns = 0, events: string[] = [];
    b.onWorkerExit = () => { exits++; };
    b.onRespawn = () => { respawns++; };
    b.onAnyEvent = (e) => events.push(e.topic);
    await b.connect();
    await b.openSession("repl");
    await b.send("create_dimension", { name: "D", dim_type: "set" });

    const kill = async () => { const w: any = (b as any).worker; w.terminate(); await sleep(300); };

    // Scenario A: query triggers respawn → fresh_runtime marker on the reply.
    await kill();
    const q = await b.query("workspace_summary", {});
    console.log("A: marker:", q.fresh_runtime, "| empty:", JSON.stringify(q.dimension_ids));

    // Scenario B: mutation triggers respawn → error, never replayed.
    await b.send("create_dimension", { name: "F", dim_type: "set" });
    await kill();
    const m = await b.send("create_dimension", { name: "E", dim_type: "set" });
    console.log("B: mutation after death:", m.ok ? "FAIL(ok)" : `ok — ${m.error}`);

    // Events still flow on the second respawn.
    const before = events.length;
    const q2 = await b.query("workspace_summary", {});
    await b.send("create_dimension", { name: "G", dim_type: "set" });
    const newEvts = events.slice(before);
    const conn = b.isConnected;
    console.log("events:", newEvts.join(", ") || "NONE", "| respawns:", respawns, "| exits:", exits, "| conn:", conn);
    await b.dispose();
    const pass = q.fresh_runtime === true && q2.fresh_runtime === undefined && !m.ok && newEvts.length > 0 && conn && respawns === 2;
    console.log("RESULT:", pass ? "PASS" : "FAIL");
    process.exit(pass ? 0 : 1);
}
main().catch((e) => { console.error("FATAL:", e); process.exit(1); });
