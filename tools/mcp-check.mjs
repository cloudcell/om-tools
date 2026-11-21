// tools/mcp-check.mjs — headless end-to-end check of the OM Core MCP server.
//
// Boots a real om-core runtime on a throwaway unix socket, connects an
// EngineClient (the same class the extension uses), mounts startOmMcpServer,
// and drives it with the MCP SDK client over Streamable HTTP — the same path
// a real client (Copilot agent mode, `claude mcp add --transport http`) takes.
//
// Requires: om-core checkout (env OM_CORE_PATH, default ../om-core) with
// deps installed (`uv sync` once), and `npm install` in this repo.
// Run: node tools/mcp-check.mjs   (or: npm run test:mcp)

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { existsSync, mkdirSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const OM_CORE = process.env.OM_CORE_PATH ?? join(root, '..', 'om-core');
const WORK = join(tmpdir(), `om-mcp-check-${process.pid}`);
const SOCK = join(WORK, 'om.sock');
const MCP_PORT = 0; // ephemeral

let pass = 0, fail = 0;
const check = (name, cond, extra = '') => {
    if (cond) { pass++; console.log(`ok   ${name} ${extra}`); }
    else { fail++; console.log(`FAIL ${name} ${extra}`); }
};

// ── load repo modules (TS sources are bundled to dist by esbuild) ─────────
import { buildSync } from 'esbuild';
const bundle = (entry) => {
    const out = join(WORK, `${entry.replace(/\W+/g, '_')}.cjs`);
    buildSync({ entryPoints: [join(root, entry)], bundle: true, platform: 'node', format: 'cjs', outfile: out });
    return out;
};

mkdirSync(WORK, { recursive: true });
const { EngineClient } = await import(bundle('src/engineClient.ts'));
const { startOmMcpServer } = await import(bundle('src/mcpServer.ts'));
const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
const { StreamableHTTPClientTransport } = await import('@modelcontextprotocol/sdk/client/streamableHttp.js');

// ── 1. spawn a runtime on a throwaway socket ──────────────────────────────
if (!existsSync(join(OM_CORE, 'main.py'))) {
    console.log(`FATAL: om-core checkout not found at ${OM_CORE} (set OM_CORE_PATH)`);
    process.exit(1);
}
// Prefer the venv interpreter directly (a lone child we can kill); fall back
// to `uv run` only when there is no .venv. uv's wrapper orphans the python
// child on SIGTERM, which then holds the socket.
const venvPy = join(OM_CORE, '.venv', 'bin', 'python');
const [cmd, args] = existsSync(venvPy)
    ? [venvPy, ['-O', 'main.py', '--runtime']]
    : ['uv', ['run', 'python', '-O', 'main.py', '--runtime']];
const runtime = spawn(cmd, args,
    { cwd: OM_CORE, stdio: ['ignore', 'ignore', 'pipe'], env: { ...process.env, OPENM_TRANSPORT_SOCKET: SOCK } });
runtime.stderr.on('data', (d) => process.stderr.write(`[runtime] ${d}`));
const cleanup = () => {
    try { runtime.kill('SIGKILL'); } catch {}
    try { rmSync(WORK, { recursive: true, force: true }); } catch {}
};
process.on('exit', cleanup);

async function waitForSocket(timeoutMs = 60000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (existsSync(SOCK)) {
            const c = new EngineClient({ kind: 'unix', path: SOCK });
            try { await c.connect(); if (await c.ping(2000)) return c; } catch {}
            c.close();
        }
        await new Promise(r => setTimeout(r, 500));
    }
    throw new Error('runtime did not come up on ' + SOCK);
}

try {
    // ── 2. connect the shared session (what the extension's client is) ──────
    const client = await waitForSocket();
    const sessionId = await client.openSession('repl');
    console.log(`session: ${sessionId.slice(0, 8)}`);

    const mcp = await startOmMcpServer({
        getClient: () => client,
        resolveFileDir: () => WORK,
        port: MCP_PORT,
        log: (m) => console.log(`[mcp-server] ${m}`),
    });
    console.log(`mcp url: ${mcp.url}`);

    const transport = new StreamableHTTPClientTransport(new URL(mcp.url));
    const mc = new Client({ name: 'mcp-check', version: '0.0.0' });
    await mc.connect(transport);
    const call = async (name, args) => {
        const r = await mc.callTool({ name, arguments: args });
        const text = r.content?.[0]?.text ?? '';
        return { isError: !!r.isError, data: (() => { try { return JSON.parse(text); } catch { return text; } })() };
    };

    // tools/list
    const tools = await mc.listTools();
    const names = tools.tools.map(t => t.name).sort();
    check('tools/list exposes om_query + om_command', names.join(',') === 'om_command,om_query', names.join(','));

    // build a tiny model via om_command: dim D{a,b}, cube C(D), view V
    const mk = async (cid, params) => call('om_command', { command_id: cid, params });
    const dim = await mk('create_dimension', { name: 'DimD', dim_type: 'set' });
    const dimId = dim.data?.dim_id ?? dim.data?.id;
    check('create_dimension', !dim.isError && !!dimId, dim.isError ? dim.data : dimId);
    await mk('create_dimension_item', { dim_id: dimId, name: 'alpha', position: 0 });
    await mk('create_dimension_item', { dim_id: dimId, name: 'beta', position: 1 });
    const cube = await mk('create_cube', { name: 'CubeC', dimension_ids: [dimId] });
    const cubeId = cube.data?.cube_id ?? cube.data?.id;
    check('create_cube', !cube.isError && !!cubeId, cube.isError ? cube.data : cubeId);
    const view = await mk('create_view', { cube_id: cubeId, name: 'V', row_dims: [dimId], col_dims: [] });
    const viewId = view.data?.view_id ?? view.data?.id;
    check('create_view', !view.isError && !!viewId, view.isError ? view.data : viewId);

    // dimension ids of items for addr
    const dd = await call('om_query', { query_id: 'dimension_detail', params: { dim_id: dimId } });
    const itemIds = (dd.data?.items ?? []).map(i => i.id);
    check('dimension_detail returns items', itemIds.length === 2, itemIds.join(','));

    // mutation through MCP → value visible through MCP query
    const addr = ['at_value', itemIds[0]];
    const setv = await mk('set_cell_hardvalue_by_addr', { cube_id: cubeId, addr, value: 777 });
    check('set_cell_hardvalue_by_addr', !setv.isError, setv.isError ? setv.data : '');

    const gv = await call('om_query', { query_id: 'cell_detail', params: { view_id: viewId, row_key: [itemIds[0]], col_key: [] } });
    const got = gv.data?.value ?? gv.data?.cell?.value ?? gv.data;
    check('mutation visible in follow-up query', String(got) === '777' || Number(got) === 777, JSON.stringify(gv.data).slice(0, 80));

    // ── 3. cross-session: a second EngineClient sees the MCP mutation ─────
    const client2 = new EngineClient({ kind: 'unix', path: SOCK });
    await client2.connect();
    const sid2 = await client2.openSession('repl');
    check('second session shares runtime session', sid2 === sessionId, `${sid2.slice(0, 8)} vs ${sessionId.slice(0, 8)}`);

    // second session reads the value the MCP tool wrote
    const gv2 = await client2.query('cell_detail', { view_id: viewId, row_key: [itemIds[0]], col_key: [] });
    const got2 = gv2?.value ?? gv2?.cell?.value ?? gv2;
    check('MCP mutation visible to second session', String(got2) === '777' || Number(got2) === 777, JSON.stringify(got2).slice(0, 80));

    // event delivery: GUI-path subscription on session 1 sees MCP mutation events
    const gotEvent = new Promise((resolve) => {
        const to = setTimeout(() => resolve(false), 8000);
        client.subscribe('event.cube.*', (env) => {
            const t = env?.topic ?? env?.payload?.topic ?? '';
            if (String(t).startsWith('event.cube.')) { clearTimeout(to); resolve(t); }
        });
        client.subscribe('command.*.succeeded', (env) => {
            const t = env?.topic ?? env?.payload?.topic ?? '';
            if (String(t).includes('succeeded')) { clearTimeout(to); resolve(t); }
        });
    });
    await new Promise(r => setTimeout(r, 1200)); // let subscriptions register server-side
    await mk('set_cell_hardvalue_by_addr', { cube_id: cubeId, addr: ['at_value', itemIds[1]], value: 888 });
    const evTopic = await gotEvent;
    check('GUI session receives event.* for MCP mutation', !!evTopic, String(evTopic));

    // ── 4. sequential calls work (fresh transport per request) ────────────
    const q1 = await call('om_query', { query_id: 'dimension_list' });
    const q2 = await call('om_query', { query_id: 'cube_list' });
    const cubeIds = (q2.data?.cubes ?? []).map(c => c.id);
    check('sequential calls succeed', !q1.isError && !q2.isError && cubeIds.includes(cubeId),
        `cubes=${cubeIds.length}`);

    // ── 5. disconnected path: isError, not a crash ────────────────────────
    const mcpDown = await startOmMcpServer({ getClient: () => null, resolveFileDir: () => WORK, port: 0 });
    const t2 = new StreamableHTTPClientTransport(new URL(mcpDown.url));
    const mc2 = new Client({ name: 'mcp-check-down', version: '0.0.0' });
    await mc2.connect(t2);
    const down = await mc2.callTool({ name: 'om_query', arguments: { query_id: 'dimension_list' } });
    check('disconnected client → isError result', !!down.isError && /not connected/i.test(down.content?.[0]?.text ?? ''));
    await mc2.close(); mcpDown.close();

    // ── 6. relative save_workspace path resolves against file dir ─────────
    const sv = await mk('save_workspace', { path: 'rel-save.json' });
    check('relative save_workspace path → file dir', !sv.isError && existsSync(join(WORK, 'rel-save.json')), sv.isError ? sv.data : '');

    client2.close();
    await mc.close();
    mcp.close();
    client.close();
} catch (e) {
    console.log('FATAL:', e?.message || e);
    fail++;
}

// The spawned runtime holds the event loop open (stderr pipe + child handle):
// stop it explicitly rather than relying on the exit hook, then hard-exit so
// lingering keep-alive sockets can't hang the script.
try { runtime.kill('SIGKILL'); } catch {} // the runtime survives SIGTERM
runtime.unref();
console.log(`\n${pass} passed, ${fail} failed`);
setTimeout(() => process.exit(fail ? 1 : 0), 300).unref();
