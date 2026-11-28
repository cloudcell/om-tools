"use strict";
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));

// src/engineWorker.ts
var import_worker_threads = require("worker_threads");
var fs = __toESM(require("fs"));

// src/omEngine.ts
var enc = new TextEncoder();
var dec = new TextDecoder();
async function createOmEngine(wasmBytes, logSink) {
  let memory;
  const env = {
    omz_host_now_ns: () => BigInt(Math.floor(performance.now() * 1e6)),
    omz_host_local_ms: () => Date.now() - (/* @__PURE__ */ new Date()).getTimezoneOffset() * 6e4,
    omz_host_log: (ptr, len) => {
      const line = dec.decode(new Uint8Array(memory.buffer, ptr >>> 0, len >>> 0));
      (logSink ?? ((l) => console.log("[om_engine]", l)))(line);
    }
  };
  const result = await WebAssembly.instantiate(wasmBytes, { env });
  const instance = result.instance;
  memory = instance.exports.memory;
  const x = instance.exports;
  const u32 = (ptr) => new DataView(memory.buffer, ptr, 4).getUint32(0, true);
  function alloc(size) {
    const p = x.omz_wasm_alloc(size) >>> 0;
    if (!p) throw new Error("omz_wasm_alloc failed");
    return p;
  }
  function allocStr(s) {
    const bytes = enc.encode(s);
    const p = alloc(bytes.length || 1);
    new Uint8Array(memory.buffer, p, bytes.length).set(bytes);
    return { p, len: bytes.length };
  }
  function alignUp(ptr, align) {
    return ptr + align - 1 & -align;
  }
  const LIMITS_SIZE = 24, LAYOUT_SIZE = 24;
  const limitsPtr = alloc(LIMITS_SIZE);
  const layoutPtr = alloc(LAYOUT_SIZE);
  check(x.omz_engine_limits_default(limitsPtr), "limits_default");
  function setStateBytes(n) {
    new DataView(memory.buffer, limitsPtr + 20, 4).setUint32(0, n, true);
  }
  function limits() {
    const v = new DataView(memory.buffer, limitsPtr, LIMITS_SIZE);
    return {
      max_expression_bytes: v.getUint32(4, true),
      max_tokens: v.getUint32(8, true),
      max_nodes: v.getUint32(12, true),
      max_parse_depth: v.getUint32(16, true),
      state_bytes: v.getUint32(20, true)
    };
  }
  let enginePtr = 0;
  function create(limitsOverride) {
    if (limitsOverride) {
      const f = [4, 8, 12, 16, 20];
      const v = new DataView(memory.buffer, limitsPtr, LIMITS_SIZE);
      const src = { ...limits(), ...limitsOverride };
      const vals = [src.max_expression_bytes, src.max_tokens, src.max_nodes, src.max_parse_depth, src.state_bytes];
      vals.forEach((n, i) => v.setUint32(f[i], n >>> 0, true));
    }
    check(x.omz_engine_layout_for_limits(limitsPtr, layoutPtr), "layout_for_limits");
    const lv = new DataView(memory.buffer, layoutPtr, LAYOUT_SIZE);
    const totalBytes = lv.getUint32(4, true), align = lv.getUint32(20, true);
    const raw = alloc(totalBytes + align);
    const buf = alignUp(raw, align);
    const out = alloc(4);
    check(x.omz_engine_create(buf, totalBytes, limitsPtr, out), "engine_create");
    enginePtr = u32(out);
    x.omz_wasm_free(out, 4);
    return enginePtr;
  }
  function check(status, what) {
    if (status !== 0) throw new Error(`omz ${what} failed: status ${status}`);
  }
  function evaluate(expr) {
    const { p, len } = allocStr(expr);
    const out = alloc(64);
    const outLen = alloc(4);
    const st = x.omz_engine_evaluate(enginePtr, p, len, out, 64, outLen);
    const n = u32(outLen);
    const res = st === 0 ? dec.decode(new Uint8Array(memory.buffer, out, n)) : `status ${st}`;
    x.omz_wasm_free(p, len);
    x.omz_wasm_free(out, 64);
    x.omz_wasm_free(outLen, 4);
    return res;
  }
  function loadWorkspace(bytes) {
    const p = alloc(bytes.length || 1);
    new Uint8Array(memory.buffer, p, bytes.length).set(bytes);
    try {
      check(x.omz_engine_load_workspace(enginePtr, p, bytes.length), "load_workspace");
    } finally {
      x.omz_wasm_free(p, bytes.length || 1);
    }
  }
  function destroy() {
    if (enginePtr) check(x.omz_engine_destroy(enginePtr), "engine_destroy");
    enginePtr = 0;
  }
  let serverPtr = 0;
  function serverCreate(stateBytes = 8 << 20, scratchBytes = 2 << 20) {
    serverPtr = x.omz_server_create(stateBytes, scratchBytes);
    if (!serverPtr) throw new Error("omz_server_create failed");
    return serverPtr;
  }
  const RPC_OUT_INITIAL = 4 * 1024 * 1024;
  const RPC_OUT_MAX = 64 * 1024 * 1024;
  function rpc(reqBytes) {
    const reqPtr = alloc(reqBytes.length || 1);
    new Uint8Array(memory.buffer, reqPtr, reqBytes.length).set(reqBytes);
    let cap = RPC_OUT_INITIAL;
    try {
      while (true) {
        const outPtr = alloc(cap);
        const lenPtr = alloc(4);
        try {
          const st = x.omz_rpc(serverPtr, reqPtr, reqBytes.length, outPtr, cap, lenPtr);
          const n = u32(lenPtr);
          if (st === -13) {
            const need = n || cap * 2;
            if (need > RPC_OUT_MAX) throw new Error(`omz_rpc output_too_small (need ${need}, max ${RPC_OUT_MAX})`);
            cap = Math.max(need, cap * 2);
            continue;
          }
          if (st !== 0) throw new Error(`omz_rpc failed: status ${st}`);
          return new Uint8Array(memory.buffer, outPtr, n).slice();
        } finally {
          x.omz_wasm_free(outPtr, cap);
          x.omz_wasm_free(lenPtr, 4);
        }
      }
    } finally {
      x.omz_wasm_free(reqPtr, reqBytes.length || 1);
    }
  }
  function serverDestroy() {
    if (serverPtr) check(x.omz_server_destroy(serverPtr), "server_destroy");
    serverPtr = 0;
  }
  return { memory, exports: x, limits, setStateBytes, create, evaluate, loadWorkspace, destroy, serverCreate, rpc, serverDestroy };
}

// src/msgpack.ts
var te = new TextEncoder();
var td = new TextDecoder();
function encode(v, out = []) {
  if (v === null || v === void 0) {
    out.push(192);
  } else if (v === false) {
    out.push(194);
  } else if (v === true) {
    out.push(195);
  } else if (typeof v === "number") {
    if (Number.isInteger(v)) {
      if (v >= 0 && v < 128) {
        out.push(v);
      } else if (v >= -32 && v < 0) {
        out.push(v & 255);
      } else if (v >= 0 && v < 256) {
        out.push(204, v);
      } else if (v >= 0 && v < 65536) {
        out.push(205, v >> 8, v & 255);
      } else if (v >= 0 && v < 4294967296) {
        out.push(206, v >>> 24, v >>> 16 & 255, v >>> 8 & 255, v & 255);
      } else if (v >= 0) {
        const b = new DataView(new ArrayBuffer(8));
        b.setBigUint64(0, BigInt(v));
        out.push(207, ...new Uint8Array(b.buffer));
      } else if (v >= -128) {
        const b = new DataView(new ArrayBuffer(1));
        b.setInt8(0, v);
        out.push(208, ...new Uint8Array(b.buffer));
      } else if (v >= -32768) {
        const b = new DataView(new ArrayBuffer(2));
        b.setInt16(0, v);
        out.push(209, ...new Uint8Array(b.buffer));
      } else if (v >= -2147483648) {
        const b = new DataView(new ArrayBuffer(4));
        b.setInt32(0, v);
        out.push(210, ...new Uint8Array(b.buffer));
      } else {
        const b = new DataView(new ArrayBuffer(8));
        b.setBigInt64(0, BigInt(v));
        out.push(211, ...new Uint8Array(b.buffer));
      }
    } else {
      const b = new DataView(new ArrayBuffer(8));
      b.setFloat64(0, v);
      out.push(203, ...new Uint8Array(b.buffer));
    }
  } else if (typeof v === "string") {
    const s = te.encode(v);
    if (s.length < 32) {
      out.push(160 | s.length);
    } else if (s.length < 256) {
      out.push(217, s.length);
    } else if (s.length < 65536) {
      out.push(218, s.length >> 8, s.length & 255);
    } else {
      out.push(219, s.length >>> 24 & 255, s.length >>> 16 & 255, s.length >>> 8 & 255, s.length & 255);
    }
    for (let i = 0; i < s.length; i++) out.push(s[i]);
  } else if (v instanceof Uint8Array) {
    const n = v.length;
    if (n < 256) {
      out.push(196, n);
    } else if (n < 65536) {
      out.push(197, n >> 8, n & 255);
    } else {
      out.push(198, n >>> 24 & 255, n >>> 16 & 255, n >>> 8 & 255, n & 255);
    }
    for (let i = 0; i < n; i++) out.push(v[i]);
  } else if (Array.isArray(v)) {
    if (v.length < 16) {
      out.push(144 | v.length);
    } else if (v.length < 65536) {
      out.push(220, v.length >> 8, v.length & 255);
    } else {
      out.push(221, v.length >>> 24 & 255, v.length >>> 16 & 255, v.length >>> 8 & 255, v.length & 255);
    }
    for (const e of v) encode(e, out);
  } else if (typeof v === "object") {
    const ks = Object.keys(v);
    if (ks.length < 16) {
      out.push(128 | ks.length);
    } else if (ks.length < 65536) {
      out.push(222, ks.length >> 8, ks.length & 255);
    } else {
      out.push(223, ks.length >>> 24 & 255, ks.length >>> 16 & 255, ks.length >>> 8 & 255, ks.length & 255);
    }
    for (const k of ks) {
      encode(k, out);
      encode(v[k], out);
    }
  } else {
    throw new Error(`msgpack: cannot encode ${typeof v}`);
  }
  return out;
}
function encodeBytes(v) {
  return new Uint8Array(encode(v));
}
function decode(buf, pos = { i: 0 }) {
  const u8 = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const b = u8[pos.i++];
  if (b < 128) return b;
  if (b >= 224) return b - 256;
  if ((b & 224) === 160) {
    const n = b & 31;
    const s = td.decode(u8.subarray(pos.i, pos.i + n));
    pos.i += n;
    return s;
  }
  if ((b & 240) === 144) {
    const n = b & 15;
    return Array.from({ length: n }, () => decode(u8, pos));
  }
  if ((b & 240) === 128) {
    const n = b & 15;
    const o = {};
    for (let i = 0; i < n; i++) o[decode(u8, pos)] = decode(u8, pos);
    return o;
  }
  switch (b) {
    case 192:
      return null;
    case 194:
      return false;
    case 195:
      return true;
    case 202: {
      const v = dv.getFloat32(pos.i);
      pos.i += 4;
      return v;
    }
    case 203: {
      const v = dv.getFloat64(pos.i);
      pos.i += 8;
      return v;
    }
    case 204:
      return u8[pos.i++];
    case 205: {
      const v = dv.getUint16(pos.i);
      pos.i += 2;
      return v;
    }
    case 206: {
      const v = dv.getUint32(pos.i);
      pos.i += 4;
      return v;
    }
    case 207: {
      const v = Number(dv.getBigUint64(pos.i));
      pos.i += 8;
      return v;
    }
    case 208: {
      const v = dv.getInt8(pos.i);
      pos.i += 1;
      return v;
    }
    case 209: {
      const v = dv.getInt16(pos.i);
      pos.i += 2;
      return v;
    }
    case 210: {
      const v = dv.getInt32(pos.i);
      pos.i += 4;
      return v;
    }
    case 211: {
      const v = Number(dv.getBigInt64(pos.i));
      pos.i += 8;
      return v;
    }
    case 217: {
      const n = u8[pos.i++];
      const s = td.decode(u8.subarray(pos.i, pos.i + n));
      pos.i += n;
      return s;
    }
    case 218: {
      const n = dv.getUint16(pos.i);
      pos.i += 2;
      const s = td.decode(u8.subarray(pos.i, pos.i + n));
      pos.i += n;
      return s;
    }
    case 219: {
      const n = dv.getUint32(pos.i);
      pos.i += 4;
      const s = td.decode(u8.subarray(pos.i, pos.i + n));
      pos.i += n;
      return s;
    }
    case 220: {
      const n = dv.getUint16(pos.i);
      pos.i += 2;
      return Array.from({ length: n }, () => decode(u8, pos));
    }
    case 221: {
      const n = dv.getUint32(pos.i);
      pos.i += 4;
      return Array.from({ length: n }, () => decode(u8, pos));
    }
    case 222: {
      const n = dv.getUint16(pos.i);
      pos.i += 2;
      const o = {};
      for (let i = 0; i < n; i++) o[decode(u8, pos)] = decode(u8, pos);
      return o;
    }
    case 223: {
      const n = dv.getUint32(pos.i);
      pos.i += 4;
      const o = {};
      for (let i = 0; i < n; i++) o[decode(u8, pos)] = decode(u8, pos);
      return o;
    }
    case 196: {
      const n = u8[pos.i++];
      const r = u8.slice(pos.i, pos.i + n);
      pos.i += n;
      return r;
    }
    case 197: {
      const n = dv.getUint16(pos.i);
      pos.i += 2;
      const r = u8.slice(pos.i, pos.i + n);
      pos.i += n;
      return r;
    }
    case 198: {
      const n = dv.getUint32(pos.i);
      pos.i += 4;
      const r = u8.slice(pos.i, pos.i + n);
      pos.i += n;
      return r;
    }
  }
  throw new Error(`msgpack: unknown byte 0x${b.toString(16)} at ${pos.i - 1}`);
}
function decodeFrames(bytes) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const out = [];
  let off = 0;
  while (off + 4 <= bytes.length) {
    const n = dv.getUint32(off, false);
    const payload = bytes.subarray(off + 4, off + 4 + n);
    try {
      out.push(decode(payload));
    } catch {
    }
    off += 4 + n;
  }
  return out;
}

// src/engineSession.ts
function createEngineSession(om, hooks) {
  const log2 = hooks.log ?? (() => {
  });
  let wsCache = null;
  let reqSeq = 0;
  async function zrpc(method, kwargs = {}, args = null, quiet = false) {
    const req = { id: `w${reqSeq++}`, method, kwargs };
    if (args) req.args = args;
    const frames = decodeFrames(om.rpc(encodeBytes(req)));
    const r = frames.find((f) => f && f.id === req.id) ?? frames[frames.length - 1] ?? {};
    if (r.error && !quiet) log2(`${method} error: ${JSON.stringify(r.error)}`);
    return r;
  }
  async function rpcResult(method, kwargs = {}, args = null) {
    const r = await zrpc(method, kwargs, args);
    if (r.error) throw new Error(typeof r.error === "string" ? r.error : JSON.stringify(r.error));
    return r.result;
  }
  async function getWs(force = false) {
    if (!wsCache || force) wsCache = await rpcResult("get_workspace") ?? {};
    return wsCache;
  }
  const afterMutation = async () => {
    wsCache = null;
    await zrpc("recompute_dirty", {}, null, true).catch(() => {
    });
  };
  function itemsOf(dim) {
    const arr = dim?.items ?? [];
    return arr.map((i) => typeof i === "string" ? { id: i, name: i } : { id: i.id ?? i.name, name: i.name ?? i.id });
  }
  function viewportCellKey(rowKey, colKey) {
    return JSON.stringify(rowKey) + "\uF8FF" + JSON.stringify(colKey);
  }
  const EVENT_TOPICS = {
    run_recalculation: ["event.calculation.finished", "event.cube.changed"],
    save_workspace: ["event.workspace.saved"],
    load_workspace: ["event.workspace.loaded"],
    create_new_workspace: ["event.workspace.created"],
    delete_view: ["event.view.deleted"],
    delete_cube: ["event.cube.deleted"],
    undo: ["event.workspace.changed"],
    redo: ["event.workspace.changed"],
    set_selection: ["event.selection.changed"],
    move_selection: ["event.selection.changed"],
    set_active_view: ["event.active_view.changed"],
    clear_dimension_outline: ["event.dimension.structure_changed"],
    set_dimension_outline: ["event.dimension.structure_changed"],
    set_dimension_item_order: ["event.dimension.structure_changed"],
    create_group: ["event.dimension.structure_changed"],
    delete_group: ["event.dimension.structure_changed"],
    delete_group_node: ["event.dimension.structure_changed"],
    move_nodes: ["event.dimension.structure_changed"],
    move_items_to_group: ["event.dimension.structure_changed"],
    ungroup_items: ["event.dimension.structure_changed"],
    rename_group_node: ["event.dimension.structure_changed"],
    place_item_nodes: ["event.dimension.structure_changed"],
    create_dimension_item: ["event.dimension.structure_changed"],
    create_dimension_items_batch: ["event.dimension.structure_changed"],
    delete_dimension_items: ["event.dimension.structure_changed"],
    create_checkpoint: ["event.workspace.checkpoint_created"],
    restore_checkpoint: ["event.workspace.changed"]
  };
  function domainOf(cid) {
    if (cid.includes("dimension")) return "dimension";
    if (cid.includes("cube") || cid.includes("cell") || cid.includes("rule") || cid.includes("recalc") || cid === "set_range_values") return "cube";
    if (cid.includes("view")) return "view";
    return "workspace";
  }
  const VERB = { create: "created", delete: "deleted", rename: "renamed", set: "changed", update: "changed", undo: "changed", redo: "changed", clear: "changed", run: "changed", move: "changed", attach: "changed", detach: "changed", place: "changed", ensure: "changed", ungroup: "changed", batch: "changed" };
  function verbOf(cid) {
    return VERB[cid.split("_")[0]] ?? "changed";
  }
  function defaultTopics(cid) {
    return [`event.${domainOf(cid)}.${verbOf(cid)}`];
  }
  function eventTopicsFor(cid) {
    return EVENT_TOPICS[cid] ?? defaultTopics(cid);
  }
  const QUERIES = {
    // Live workspace bytes for .omz bundle capture — same payload save_workspace writes.
    async serialize_workspace() {
      return { json: await workspaceSnapshotJson() };
    },
    async engine_version() {
      return await rpcResult("version").catch(() => null) ?? null;
    },
    async runtime_version() {
      return typeof TS_RUNTIME_BUILD !== "undefined" ? TS_RUNTIME_BUILD : null;
    },
    async workspace_summary() {
      const ws = await getWs();
      return {
        saved_default_view_id: ws.saved_default_view_id ?? null,
        dimension_ids: Object.keys(ws.dimensions ?? {}).sort((a, b) => a === "@" ? -1 : b === "@" ? 1 : 0),
        cube_ids: Object.keys(ws.cubes ?? {}),
        view_ids: Object.keys(ws.views ?? {})
      };
    },
    async dimension_list() {
      const ws = await getWs();
      const entries = Object.entries(ws.dimensions ?? {}).sort(([a], [b]) => a === "@" ? -1 : b === "@" ? 1 : 0);
      return { dimensions: entries.map(([id, d]) => ({ id, name: d.name ?? id, items: (d.items ?? []).length, item_list: itemsOf(d) })) };
    },
    async cube_list() {
      const ws = await getWs();
      return { cubes: Object.entries(ws.cubes ?? {}).map(([id, c]) => ({ id, name: c.name ?? id, dimensions: (c.dimension_ids ?? c.dimensions ?? []).length })) };
    },
    async view_list() {
      const ws = await getWs();
      return { views: Object.entries(ws.views ?? {}).map(([id, v]) => ({ id, name: v.name ?? id })) };
    },
    async dimension_detail(p) {
      const ws = await getWs();
      const d = (ws.dimensions ?? {})[p.dim_id];
      if (!d) throw new Error(`dimension ${p.dim_id} not found`);
      const outline = await rpcResult("dimension_outline", { dim_id: p.dim_id }).catch(() => []);
      return { id: p.dim_id, name: d.name ?? p.dim_id, dim_type: d.dim_type ?? d.kind ?? "set", items: itemsOf(d), outline: Array.isArray(outline) ? outline : [] };
    },
    async cube_detail(p) {
      const ws = await getWs();
      const c = (ws.cubes ?? {})[p.cube_id] ?? {};
      return { id: p.cube_id, name: c.name ?? p.cube_id, dimension_ids: c.dimension_ids ?? c.dimensions ?? [] };
    },
    async view_detail(p) {
      const v = await rpcResult("require_view", { view_id: p.view_id });
      return { ...v, layout: { rows: v.row_dim_ids ?? [], cols: v.col_dim_ids ?? [], page: v.page_dim_ids ?? [] } };
    },
    async page_selection(p) {
      const res = await rpcResult("page_selection", { view_id: p.view_id, dim_id: p.dim_id }).catch(() => null);
      let item_id = res?.item_id ?? null;
      if (item_id == null) {
        if (p.dim_id === "@") {
          item_id = "at_value";
        } else {
          const ws = await getWs();
          const its = itemsOf((ws.dimensions ?? {})[p.dim_id] ?? {});
          item_id = its.length ? its[0].id : null;
        }
      }
      return { type: "page_selection", view_id: p.view_id, dim_id: p.dim_id, item_id };
    },
    async view_row_keys(p) {
      return { keys: await rpcResult("view_row_keys", { view_id: p.view_id }) ?? [] };
    },
    async view_col_keys(p) {
      return { keys: await rpcResult("view_col_keys", { view_id: p.view_id }) ?? [] };
    },
    async view_row_header(p) {
      const keys = await rpcResult("view_row_keys", { view_id: p.view_id }) ?? [];
      const key = keys[p.section] ?? [];
      const ws = await getWs();
      const names = key.map((kid) => {
        for (const d of Object.values(ws.dimensions ?? {})) {
          const it = itemsOf(d).find((i) => i.id === kid);
          if (it) return it.name;
        }
        return kid;
      });
      return { header: names.join(" / ") };
    },
    async view_col_header(p) {
      const h = await rpcResult("view_col_header", { view_id: p.view_id, col_index: p.section });
      return { header: typeof h === "string" ? h : h?.header ?? "" };
    },
    async cell_range(p) {
      const rows = p.row_keys ?? [], cols = p.col_keys ?? [];
      const vd = await QUERIES.view_detail(p).catch(() => ({}));
      const ws = await getWs();
      const matrix = await rpcResult("get_range", {
        view_id: p.view_id,
        top: 0,
        left: 0,
        bottom: Math.max(0, rows.length - 1),
        right: Math.max(0, cols.length - 1)
      }) ?? [];
      const pageSel = await pageSelMap(p.view_id, vd.page_dim_ids ?? []);
      const addrFor = (rowKey, colKey) => viewAddrKey(ws, vd, rowKey, colKey, null, pageSel);
      const addrKeys = [];
      for (let r = 0; r < rows.length; r++)
        for (let c = 0; c < cols.length; c++)
          addrKeys.push(addrFor(rows[r], cols[c]));
      const ev = await zrpc("evaluate_cells", {}, [vd.cube_id, addrKeys]);
      const results = ev?.result ?? [];
      const storedFlags = await Promise.all(addrKeys.map(async (ak, i) => {
        const raw = matrix?.[Math.floor(i / cols.length)]?.[i % cols.length];
        if (raw === null || raw === void 0) return null;
        const cv = await rpcResult("get_cell_value", { cube_id: vd.cube_id, addr_key: ak }).catch(() => null);
        return cv?.hardcoded === true;
      }));
      const cells = [];
      for (let r = 0; r < rows.length; r++) {
        for (let c = 0; c < cols.length; c++) {
          const i = r * cols.length + c;
          const stored = storedFlags[i] !== null;
          const res = results[i];
          const value = res && typeof res === "object" ? res.value ?? null : res;
          const empty = value === null || value === void 0;
          const source = empty ? "empty" : stored ? storedFlags[i] ? "override" : "input" : "rule";
          cells.push({
            view_id: p.view_id,
            cube_id: vd.cube_id ?? "",
            row_key: rows[r],
            col_key: cols[c],
            addr: addrKeys[i].split("|"),
            value: empty ? null : value,
            display_value: empty ? "" : String(value),
            kind: empty ? "empty" : res?._type === "error" ? "error" : typeof value === "number" ? "number" : "text",
            explain: { source, rule_body: null, error: null, depends: null }
          });
        }
      }
      return { view_id: p.view_id, cube_id: vd.cube_id ?? "", row_start: 0, col_start: 0, row_end: rows.length, col_end: cols.length, cells, row_keys: rows, col_keys: cols };
    },
    async cell_detail(p) {
      const [rk, ck] = await Promise.all([
        rpcResult("view_row_keys", { view_id: p.view_id }),
        rpcResult("view_col_keys", { view_id: p.view_id })
      ]);
      const r = (rk ?? []).findIndex((k) => JSON.stringify(k) === JSON.stringify(p.row_key));
      const c = (ck ?? []).findIndex((k) => JSON.stringify(k) === JSON.stringify(p.col_key));
      const v = await rpcResult("cell_value_for_view_rc", { view_id: p.view_id, row: r, col: c }).catch(() => null);
      return v ?? { value: null };
    },
    async cell_rule() {
      return { rule: null };
    },
    async diagnostics_calculation_flow(p) {
      return (await zrpc("trace_calculation_flow", p)).result ?? {};
    },
    async diagnostics_circular_references(p) {
      return (await zrpc("trace_circular_references", p)).result ?? {};
    },
    async diagnostics_dependency_metrics() {
      return (await zrpc("dependency_metrics")).result ?? {};
    },
    async diagnostics_dependency_tracking_state() {
      return (await zrpc("get_dep_tracking")).result ?? {};
    },
    async diagnostics_dirty_count() {
      return (await zrpc("dirty_count")).result ?? { count: 0 };
    },
    async diagnostics_engine_backend() {
      return { backend: "zig/wasm", mode: "embedded" };
    },
    async diagnostics_multithread_config() {
      return { enabled: false, threads: 1 };
    },
    async diagnostics_rule_eval_profile() {
      return (await zrpc("rule_eval_profile")).result ?? {};
    },
    async workspace_rules() {
      const ws = await getWs();
      const rules = Object.entries(ws.rules ?? {}).map(([id, r]) => ({
        id,
        cube_id: r.cube_id ?? "",
        expression: r.expression ?? r.body ?? "",
        targets: r.targets ?? [],
        addr_mask: r.addr_mask ?? [],
        is_anchored: !!r.is_anchored
      }));
      return { type: "list", rules, rule_order: ws.rule_order ?? [], cube_ids: Object.keys(ws.cubes ?? {}) };
    },
    async cube_rule_counts(p) {
      return (await zrpc("rule_counts_for_cube", { cube_id: p.cube_id })).result ?? { cell_rules: 0, rules: 0 };
    },
    async undo_state() {
      const [cu, cr, ud, rd] = await Promise.all([
        zrpc("can_undo"),
        zrpc("can_redo"),
        zrpc("get_undo_description"),
        zrpc("get_redo_description")
      ]);
      const b = (v) => v === true || v?.can === true || v?.result === true;
      return { can_undo: b(cu.result), can_redo: b(cr.result), undo_description: ud.result?.description ?? "", redo_description: rd.result?.description ?? "" };
    },
    async selection_stats(p) {
      const zeroed = { total_count: 0, count: 0, counta: 0, sum: 0, avg: 0, min: null, max: null, sampled: false };
      if (!p.view_id || !p.mode) return zeroed;
      try {
        const vd = await QUERIES.view_detail(p).catch(() => ({}));
        const ws = await getWs();
        const sel = { ...await pageSelMap(p.view_id, vd.page_dim_ids ?? []), ...p.page_selections ?? {} };
        const allRows = await rpcResult("view_row_keys", { view_id: p.view_id }) ?? [];
        const allCols = await rpcResult("view_col_keys", { view_id: p.view_id }) ?? [];
        const pairs = [];
        if (p.mode === "cell" && Array.isArray(p.cell_keys)) pairs.push(...p.cell_keys);
        else if (p.mode === "row" && Array.isArray(p.row_keys)) for (const rk of p.row_keys) for (const ck of allCols) pairs.push([rk, ck]);
        else if (p.mode === "col" && Array.isArray(p.col_keys)) for (const rk of allRows) for (const ck of p.col_keys) pairs.push([rk, ck]);
        else if (p.mode === "all") for (const rk of allRows) for (const ck of allCols) pairs.push([rk, ck]);
        const addrKeys = pairs.map(([rk, ck]) => viewAddrKey(ws, vd, rk, ck, null, sel));
        const results = (await zrpc("evaluate_cells", {}, [vd.cube_id, addrKeys]).catch(() => null))?.result ?? [];
        let count = 0, counta = 0, sum = 0, min = null, max = null;
        for (let i = 0; i < pairs.length; i++) {
          const res = results[i];
          const value = res && typeof res === "object" ? res.value ?? null : res;
          if (value === null || value === void 0 || value === "") continue;
          counta++;
          const num = Number(value);
          if (!isNaN(num)) {
            count++;
            sum += num;
            if (min === null || num < min) min = num;
            if (max === null || num > max) max = num;
          }
        }
        return { total_count: pairs.length, count, counta, sum, avg: count ? sum / count : 0, min, max, sampled: false };
      } catch {
        return zeroed;
      }
    },
    async selection_current() {
      return { row: null, col: null, row_key: [], col_key: [] };
    },
    async active_view_current() {
      return { view_id: null };
    },
    async grid_viewport_snapshot(p) {
      const rows = p.row_keys ?? [], cols = p.col_keys ?? [];
      const vd = await QUERIES.view_detail(p).catch(() => ({}));
      const ws = await getWs();
      const channels = {};
      for (const ch of p.channels ?? []) {
        const atItem = ch.startsWith("at_") ? ch : `at_${ch}`;
        const keys = [];
        for (const r of rows) for (const c of cols)
          keys.push(viewAddrKey(ws, vd, r, c, atItem, p.page_selections));
        const ev = await zrpc("evaluate_cells", {}, [vd.cube_id, keys]);
        const map = {};
        (ev?.result ?? []).forEach((res, i) => {
          const v = res && typeof res === "object" ? res.value ?? null : res;
          if (v !== null && v !== void 0)
            map[viewportCellKey(rows[Math.floor(i / cols.length)], cols[i % cols.length])] = v;
        });
        channels[ch] = map;
      }
      return { view_id: p.view_id, cube_id: vd.cube_id ?? "", channels, item_formats: {}, group_formats: {}, user_override_addrs: [] };
    },
    async timeline_snapshots() {
      return { snapshots: [] };
    },
    async outline_tree(p) {
      return (await zrpc("dimension_outline", { dim_id: p.dim_id })).result ?? { nodes: [] };
    },
    async dimension_effective_order(p) {
      return (await zrpc("dimension_effective_order", { dim_id: p.dim_id })).result;
    },
    async dimension_deletion_impact(p) {
      return (await zrpc("analyze_dim_deletion", { dim_id: p.dim_id, item_ids: p.item_ids })).result ?? {};
    },
    async dimension_item_deletion_impact(p) {
      return (await zrpc("analyze_item_deletion", { dim_id: p.dim_id, item_ids: p.item_ids })).result ?? {};
    },
    async cube_detach_impact(p) {
      return (await zrpc("analyze_detach", { cube_id: p.cube_id, dim_id: p.dim_id })).result ?? {};
    },
    async rule_detail(p) {
      return (await zrpc("find_rule", { cube_id: p.cube_id, rule_id: p.rule_id })).result ?? { rule: null };
    },
    async rule_target_resolve(p) {
      try {
        return { type: "rule_target_resolve", cube_id: p.cube_id, targets: parseRuleTarget(p.lhs ?? ""), error: null };
      } catch (e) {
        return { type: "rule_target_resolve", cube_id: p.cube_id, targets: null, error: String(e?.message || e) };
      }
    },
    async cell_channel_values(p) {
      const vd = await QUERIES.view_detail(p).catch(() => ({}));
      const ws = await getWs();
      const chData = {};
      for (const ch of p.channels ?? []) {
        const atItem = ch.startsWith("at_") ? ch : `at_${ch}`;
        const key = viewAddrKey(ws, vd, p.row_key ?? [], p.col_key ?? [], atItem, p.page_selections);
        const ev = await zrpc("evaluate_cells", {}, [vd.cube_id, [key]]);
        const res = (ev?.result ?? [])[0];
        const v = res && typeof res === "object" ? res.value ?? null : res;
        chData[ch] = v ?? null;
      }
      return { view_id: p.view_id, cube_id: vd.cube_id ?? "", channels: chData };
    }
  };
  const PASSTHRU = /* @__PURE__ */ new Set([
    "create_dimension",
    "create_dimension_item",
    "create_dimension_items_batch",
    "rename_dimension",
    "rename_dimension_item",
    "delete_dimension",
    "delete_dimension_items",
    "create_cube",
    "rename_cube",
    "delete_cube",
    "set_cell_hardvalue",
    "set_cell_hardvalue_by_addr",
    "clear_cell_hardvalue",
    "batch_set_cell_hardvalues_by_addr",
    "set_rule",
    "update_rule",
    "delete_rule",
    "delete_rule_anchored",
    "set_rule_order",
    "set_rule_anchored",
    "update_cell_rule",
    "apply_rule_batch",
    "undo",
    "redo",
    "set_view_axes",
    "set_view_layout",
    "move_view_dimension",
    "set_view_col_width",
    "set_view_row_header_width",
    "set_page_item_id",
    "set_dimension_item_order",
    "create_group",
    "delete_group",
    "delete_group_node",
    "move_nodes",
    "move_items_to_group",
    "ungroup_items",
    "rename_group_node",
    "place_item_nodes",
    "create_aggregate_item",
    "ensure_group_in_graph",
    "delete_view",
    "rename_view",
    "create_view",
    "create_default_view",
    "create_new_workspace"
  ]);
  const RENAME = {
    run_recalculation: "recalculate_all",
    set_dependency_tracking: "set_dep_tracking",
    clear_cache: "clear_caches",
    attach_dimension_to_cube: "attach_dimension",
    detach_dimension_from_cube: "detach_dimension",
    set_range_values: "set_range",
    set_dimension_outline: "dimension_outline",
    set_cell_hardvalues_batch_by_addr: "batch_set_cell_hardvalues_by_addr"
  };
  const ADDR_ARRAY_METHODS = /* @__PURE__ */ new Set(["set_rule_anchored", "set_rule_anchored_by_addr", "delete_rule_anchored", "find_anchored_rule"]);
  const STUB_OK = /* @__PURE__ */ new Set([
    "set_selection",
    "move_selection",
    "set_active_view",
    "set_property",
    "set_engine",
    "set_multithread_recompute",
    "cancel_operation",
    "clear_profiler_snapshot",
    "create_checkpoint",
    "restore_checkpoint",
    "rename_checkpoint",
    "delete_checkpoint"
  ]);
  async function workspaceSnapshotJson() {
    const snap = await rpcResult("get_workspace_snapshot");
    const ws = { ...snap.workspace ?? snap };
    delete ws.graph;
    const ORDER = [
      "id",
      "name",
      "dimensions",
      "cubes",
      "rules",
      "rule_order",
      "views",
      "views_order",
      "udfs",
      "saved_default_view_id"
    ];
    const ordered = {};
    for (const k of ORDER) if (k in ws) ordered[k] = ws[k];
    for (const k of Object.keys(ws)) if (!(k in ordered)) ordered[k] = ws[k];
    return JSON.stringify({ schema_version: 17, workspace: ordered }, null, 2);
  }
  async function handleCommand(command_id, params) {
    if (STUB_OK.has(command_id)) return { ok: true };
    if (command_id === "save_workspace") {
      const bytes = new TextEncoder().encode(await workspaceSnapshotJson());
      await hooks.saveWorkspace(params?.path ?? "workspace.json", bytes);
      return { ok: true };
    }
    if (command_id === "load_workspace") {
      const buf = await hooks.loadWorkspaceBytes(params?.path ?? "");
      let bytes = buf;
      try {
        const obj = JSON.parse(new TextDecoder().decode(buf));
        bytes = encodeBytes(obj);
      } catch {
      }
      const r2 = await zrpc("load_workspace_msgpack", {}, [bytes]);
      if (r2.error) throw new Error(`load_workspace: ${r2.error}`);
      wsCache = null;
      await afterMutation();
      return { ok: true };
    }
    if (command_id === "run_excel_import") {
      throw new Error("run_excel_import: not supported by the embedded engine");
    }
    if (command_id === "clear_dimension_outline") {
      const r2 = await zrpc("dimension_outline", { dim_id: params?.dim_id, outline: [] });
      if (r2.error) throw new Error(typeof r2.error === "string" ? r2.error : JSON.stringify(r2.error));
      await afterMutation();
      return { data: { affected: 1, property: "dimension_outline", dim_id: params?.dim_id }, _events: r2.result?.events };
    }
    let method = RENAME[command_id] ?? (PASSTHRU.has(command_id) ? command_id : null);
    if (!method) throw new Error(`unsupported command: ${command_id}`);
    const kw = { ...params ?? {} };
    if (kw.row_dims && !kw.row_dim_ids) {
      kw.row_dim_ids = kw.row_dims;
      delete kw.row_dims;
    }
    if (kw.col_dims && !kw.col_dim_ids) {
      kw.col_dim_ids = kw.col_dims;
      delete kw.col_dims;
    }
    if (kw.page_dims && !kw.page_dim_ids) {
      kw.page_dim_ids = kw.page_dims;
      delete kw.page_dims;
    }
    if (kw.cell_ref && kw.view_id) {
      const ref = kw.cell_ref;
      const vd = await QUERIES.view_detail({ view_id: kw.view_id }).catch(() => ({}));
      if (!vd.cube_id) throw new Error(`${command_id}: view ${kw.view_id} not found`);
      const ws = await getWs();
      const sels = await pageSelMap(kw.view_id, vd.page_dim_ids);
      const channel = ref.channel ? ref.channel.startsWith("at_") ? ref.channel : `at_${ref.channel}` : null;
      const addrKey = viewAddrKey(ws, vd, ref.row_key ?? [], ref.col_key ?? [], channel, sels);
      kw.cube_id = vd.cube_id;
      kw.addr_key = addrKey;
      kw.addr = addrKey.split("|");
      delete kw.cell_ref;
      delete kw.view_id;
    }
    if (command_id === "update_cell_rule" && kw.addr) {
      const found = await rpcResult("find_anchored_rule", { cube_id: kw.cube_id, addr: kw.addr }).catch(() => null);
      const rid = found?.id ?? found?.rule_id ?? found?.rule?.id;
      if (rid) {
        kw.rule_id = rid;
        delete kw.addr;
        delete kw.addr_key;
        delete kw.cube_id;
      } else {
        method = "set_rule_anchored";
        delete kw.addr_key;
      }
    }
    if (Array.isArray(kw.addr) && !ADDR_ARRAY_METHODS.has(method)) {
      kw.addr_key = kw.addr.join("|");
      delete kw.addr;
    }
    if (method === "batch_set_cell_hardvalues_by_addr" && Array.isArray(kw.entries)) {
      kw.entries = kw.entries.map((e) => Array.isArray(e?.addr) ? { addr_key: e.addr.join("|"), value: e.value } : e);
    }
    const r = await zrpc(method, kw);
    if (r.error) throw new Error(typeof r.error === "string" ? r.error : JSON.stringify(r.error));
    await afterMutation();
    const res = r.result;
    const data = res && typeof res === "object" && "data" in res ? res.data : res;
    return { data, _events: res?.events };
  }
  const SEQ_KEYWORDS = /* @__PURE__ */ new Set(["THIS", "PREV", "NEXT", "FIRST", "LAST"]);
  function validateDynamicBound(expr) {
    if (expr.includes(".."))
      throw new Error(`Dynamic bound $<${expr}> must resolve to a single cell; range syntax not allowed in dynamic bounds`);
    if (expr.includes("*") && /[.\[,]\s*\*\s*(?:[,\]]|$)/.test(expr))
      throw new Error(`Dynamic bound $<${expr}> must resolve to a single cell; wildcard not allowed in dynamic bounds`);
  }
  function parseRefSegment(segment) {
    let seg = segment.trim();
    if (!seg) throw new Error("Empty cell ref segment");
    if (seg === "*.*" || seg === "[*.*]") return ["*", "*"];
    const sheetPos = seg.indexOf("::");
    if (sheetPos !== -1) {
      const specials = [".", "$<", ".."].map((m) => seg.indexOf(m)).filter((i) => i !== -1);
      const firstSpecial = specials.length ? Math.min(...specials) : -1;
      if (firstSpecial === -1 || sheetPos < firstSpecial) seg = seg.split("::").slice(1).join("::").trim();
    }
    const rangePos = seg.indexOf(".."), dynPos = seg.indexOf("$<");
    if (dynPos !== -1) {
      const endDyn = seg.indexOf(">", dynPos);
      if (endDyn !== -1) validateDynamicBound(seg.slice(dynPos + 2, endDyn));
    }
    const limit = rangePos !== -1 || dynPos !== -1 ? Math.min(...[rangePos, dynPos].filter((pp) => pp !== -1)) : seg.length;
    const bracketSep = seg.lastIndexOf("[", limit - 1);
    if (bracketSep !== -1 && seg.trimEnd().endsWith("]")) {
      const closePos = seg.lastIndexOf("]");
      const dimName2 = seg.slice(0, bracketSep).trim();
      const itemName2 = seg.slice(bracketSep + 1, closePos).trim();
      if (!dimName2 || !itemName2) throw new Error(`Bad cell ref syntax: [${segment}]`);
      if (!SEQ_KEYWORDS.has(itemName2.toUpperCase()))
        throw new Error(`Invalid bracketed item reference [${segment}]. Brackets after a dimension name are reserved for sequential accessors (${[...SEQ_KEYWORDS].sort().join(", ")}). Use ${dimName2}.${itemName2} for regular item references.`);
      return [dimName2, itemName2];
    }
    let sep = seg.lastIndexOf(".", limit - 1);
    if (sep === -1) sep = seg.lastIndexOf(".");
    if (sep === -1) {
      const dimName2 = seg.trim();
      if (!dimName2) throw new Error(`Bad cell ref syntax: [${segment}]`);
      return [dimName2, ""];
    }
    const dimName = seg.slice(0, sep).trim(), itemName = seg.slice(sep + 1).trim();
    if (!dimName || !itemName) throw new Error(`Bad cell ref syntax: [${segment}]`);
    return [dimName, itemName];
  }
  function parseRuleTarget(lhs) {
    const text = lhs.trim();
    if (!text) throw new Error("Empty rule target");
    if (text.startsWith("@.") && !text.includes(":")) {
      const channel = text.slice(2).trim();
      if (channel) return [["@", channel]];
      throw new Error(`Invalid @ dimension target: ${text}`);
    }
    if (text.includes("::") && text.endsWith("::*")) return [["*", "*"]];
    if (text === "*") return [["*", "*"]];
    if (text.includes(":") && text.includes(".") && !text.startsWith("[")) {
      const parts = text.split(/\s*:\s*/).map((pp) => pp.trim()).filter(Boolean);
      if (parts.length > 1 && parts.every((pp) => pp.includes("[") && pp.includes("]") || pp.includes(".")))
        return parts.map(parseRefSegment);
    }
    if (text.startsWith("[") && text.endsWith("]")) {
      const inner = text.slice(1, -1).trim();
      const segments = inner.split(",").map((s) => s.trim()).filter(Boolean);
      if (!segments.length) throw new Error("Empty rule target list []");
      return segments.map(parseRefSegment);
    }
    return [parseRefSegment(text)];
  }
  function viewAddrKey(ws, vd, rowKey, colKey, channel = null, pageSelections = null) {
    const cube = (ws.cubes ?? {})[vd.cube_id] ?? {};
    const dimOrder = cube.dimension_ids ?? cube.dimensions ?? [];
    const rowDims = vd.row_dim_ids ?? [], colDims = vd.col_dim_ids ?? [];
    const pageItem = (dimId) => {
      if (pageSelections?.[dimId]) return pageSelections[dimId];
      const its = itemsOf((ws.dimensions ?? {})[dimId] ?? {});
      return its.length ? its[0].id : "";
    };
    const atItem = channel ?? pageSelections?.["@"] ?? "at_value";
    return dimOrder.map((d) => {
      if (d === "@") return atItem;
      const ri = rowDims.indexOf(d);
      if (ri >= 0) return rowKey[ri] ?? "";
      const ci = colDims.indexOf(d);
      if (ci >= 0) return colKey[ci] ?? "";
      return pageItem(d);
    }).join("|");
  }
  async function pageSelMap(viewId, pageDimIds) {
    const map = {};
    await Promise.all((pageDimIds ?? []).map(async (d) => {
      const res = await rpcResult("page_selection", { view_id: viewId, dim_id: d }).catch(() => null);
      if (res?.item_id != null) map[d] = res.item_id;
    }));
    return map;
  }
  return {
    zrpc,
    rpcResult,
    async query(queryId, params) {
      const q = QUERIES[queryId];
      if (!q) throw new Error(`unsupported query: ${queryId}`);
      return q(params || {});
    },
    async command(commandId, params) {
      const r = await handleCommand(commandId, params || {});
      hooks.onEvent(`command.${commandId}.succeeded`, { command_id: commandId });
      for (const t of eventTopicsFor(commandId)) hooks.onEvent(t, { command_id: commandId });
      const engineEvents = r?._events;
      if (Array.isArray(engineEvents) && engineEvents.length)
        log2(`engine events[${engineEvents.length}]: ${engineEvents.map((e) => e?.event_id).join(",")}`);
      return "data" in r ? r.data : r;
    }
  };
}

// src/serialize.ts
function createSerializer() {
  let tail = Promise.resolve();
  return function serialize(task) {
    const run = tail.then(task);
    tail = run.catch(() => {
    });
    return run;
  };
}

// src/engineWorker.ts
var log = (...a) => console.error("[engine-worker]", ...a);
async function main() {
  const { wasmPath, stateBytes, scratchBytes } = import_worker_threads.workerData;
  const om = await createOmEngine(
    new Uint8Array(fs.readFileSync(wasmPath)),
    (line) => console.error(`[om_engine] ${line}`)
  );
  om.serverCreate(stateBytes ?? 8 << 20, scratchBytes ?? 2 << 20);
  const session = createEngineSession(om, {
    saveWorkspace: async (p, bytes) => {
      fs.writeFileSync(p, Buffer.from(bytes));
    },
    loadWorkspaceBytes: async (p) => new Uint8Array(fs.readFileSync(p)),
    onEvent: (topic, data) => import_worker_threads.parentPort.postMessage({ event: { topic, data } }),
    log
  });
  const serialize = createSerializer();
  const sessionId = `embedded-${Date.now().toString(36)}`;
  import_worker_threads.parentPort.postMessage({ ready: true });
  import_worker_threads.parentPort.on("message", (msg) => {
    const { id, kind } = msg;
    serialize(async () => {
      try {
        switch (kind) {
          case "ping": {
            const r = await session.zrpc("ping");
            import_worker_threads.parentPort.postMessage({ id, ok: !r.error, data: r.result ?? { pong: true } });
            return;
          }
          case "openSession":
            import_worker_threads.parentPort.postMessage({ id, ok: true, data: { session_id: sessionId } });
            return;
          case "query": {
            const data = await session.query(msg.query_id, msg.params || {});
            import_worker_threads.parentPort.postMessage({ id, ok: true, data });
            return;
          }
          case "command": {
            const data = await session.command(msg.command_id, msg.params || {});
            import_worker_threads.parentPort.postMessage({ id, ok: true, data });
            return;
          }
          default:
            import_worker_threads.parentPort.postMessage({ id, ok: false, error: `unknown kind: ${kind}` });
        }
      } catch (e) {
        import_worker_threads.parentPort.postMessage({ id, ok: false, error: String(e?.message || e) });
      }
    }).catch(() => {
    });
  });
}
main().catch((e) => {
  import_worker_threads.parentPort.postMessage({ fatal: String(e?.message || e) });
});
