#!/usr/bin/env node
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

// src/tsEngineServer.ts
var net = __toESM(require("net"));
var fs = __toESM(require("fs"));
var path = __toESM(require("path"));

// src/omEngine.ts
var enc = new TextEncoder();
var dec = new TextDecoder();
async function createOmEngine(wasmBytes, logSink) {
  let memory;
  const env = {
    omz_host_now_ns: () => BigInt(Math.floor(performance.now() * 1e6)),
    omz_host_local_ms: () => Date.now() - (/* @__PURE__ */ new Date()).getTimezoneOffset() * 6e4,
    omz_host_log: (ptr, len) => {
      const line = dec.decode(new Uint8Array(memory.buffer, ptr, len));
      (logSink ?? ((l) => console.log("[om_engine]", l)))(line);
    }
  };
  const result = await WebAssembly.instantiate(wasmBytes, { env });
  const instance = result.instance;
  memory = instance.exports.memory;
  const x = instance.exports;
  const u32 = (ptr) => new DataView(memory.buffer, ptr, 4).getUint32(0, true);
  function alloc(size) {
    const p = x.omz_wasm_alloc(size);
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
  function serverCreate(stateBytes2 = 8 << 20, scratchBytes2 = 2 << 20) {
    serverPtr = x.omz_server_create(stateBytes2, scratchBytes2);
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

// src/tsEngineServer.ts
var args = process.argv.slice(2);
var endpoint = null;
var stateBytes = 8 << 20;
var scratchBytes = 2 << 20;
for (const a of args) {
  if (a.startsWith("--state-bytes=")) stateBytes = Number(a.split("=")[1]) || stateBytes;
  else if (a.startsWith("--scratch-bytes=")) scratchBytes = Number(a.split("=")[1]) || scratchBytes;
  else if (a.startsWith("--max-undo-entries=") || a.startsWith("--mode=")) {
  } else if (!a.startsWith("--") && endpoint === null) endpoint = a;
}
if (!endpoint) {
  console.error("usage: ts-engine-server <socket-path|tcp://host:port> [--state-bytes=N] [--scratch-bytes=N]");
  process.exit(2);
}
var wasmPath = process.env.OM_WASM_PATH || path.join(__dirname, "om_engine.wasm");
var log = (...a) => console.error("[ts-engine-server]", ...a);
async function main() {
  const wasmBytes = new Uint8Array(fs.readFileSync(wasmPath));
  const om = await createOmEngine(wasmBytes, (line) => console.error(`[om_engine] ${line}`));
  om.serverCreate(stateBytes, scratchBytes);
  log(`engine up \u2014 wasm=${wasmPath} state=${stateBytes} scratch=${scratchBytes}`);
  const server = net.createServer((sock) => {
    let buf = Buffer.alloc(0);
    sock.on("data", (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      while (buf.length >= 4) {
        const n = buf.readUInt32BE(0);
        if (buf.length < 4 + n) break;
        const payload = buf.subarray(4, 4 + n);
        buf = buf.subarray(4 + n);
        try {
          const inBytes = bridgePathArgs(new Uint8Array(payload.buffer, payload.byteOffset, payload.byteLength));
          const out = om.rpc(inBytes);
          sock.write(Buffer.from(out.buffer, out.byteOffset, out.byteLength));
        } catch (e) {
          log("rpc error:", e?.message || e);
          sock.destroy(e instanceof Error ? e : new Error(String(e)));
          return;
        }
      }
    });
    sock.on("error", () => {
    });
  });
  if (endpoint.startsWith("tcp://")) {
    const u = new URL(endpoint);
    const port = Number(u.port) || 7654;
    const host = u.hostname || "127.0.0.1";
    server.listen(port, host, () => log(`listening on ${endpoint}`));
  } else {
    const sockPath = endpoint.startsWith("unix://") ? endpoint.slice(7) : endpoint;
    try {
      fs.unlinkSync(sockPath);
    } catch {
    }
    server.listen(sockPath, () => log(`listening on ${endpoint}`));
  }
  const shutdown = () => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 500).unref();
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
function bridgePathArgs(req) {
  let obj;
  try {
    obj = decode(req);
  } catch {
    return req;
  }
  if (!obj || typeof obj !== "object" || obj.method !== "load_workspace_msgpack") return req;
  const arg0 = obj.args?.[0];
  if (typeof arg0 !== "string") return req;
  try {
    obj.args[0] = fs.readFileSync(arg0);
    return encodeBytes(obj);
  } catch (e) {
    log(`load_workspace_msgpack: cannot read ${arg0}: ${e?.message || e}`);
    return req;
  }
}
main().catch((e) => {
  log("fatal:", e?.message || e);
  process.exit(1);
});
