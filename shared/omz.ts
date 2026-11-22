/** `.omz` bundle — a zip containing `model.json` + `session.omsession.json` (+ a
 *  `manifest.json` naming the roles), so a complete shareable workspace is a single
 *  file. Pure TS, no imports: runs in the webview (browser), the extension host
 *  (node ≥18) and node test scripts — CompressionStream/DecompressionStream and
 *  Blob/Response streams exist in all three.
 *
 *  Codec scope is deliberately minimal: members are method 0 (stored) or 8
 *  (deflate-raw) — everything else throws. Writing uses deflate when
 *  CompressionStream exists, stored otherwise. */

export const BUNDLE_SCHEMA = "om.bundle/1";
export const BUNDLE_EXT = ".omz";
export const BUNDLE_MODEL_MEMBER = "model.json";
export const BUNDLE_SESSION_MEMBER = "session.omsession.json";
export const BUNDLE_MANIFEST_MEMBER = "manifest.json";

export function isZip(u8: Uint8Array): boolean {
  return u8.length > 4 && u8[0] === 0x50 && u8[1] === 0x4b && u8[2] === 0x03 && u8[3] === 0x04;
}

// ── CRC32 ──
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(u8: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < u8.length; i++) c = CRC_TABLE[(c ^ u8[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

async function pump(u8: Uint8Array, ts: CompressionStream | DecompressionStream): Promise<Uint8Array> {
  const stream = new Blob([u8 as BlobPart]).stream().pipeThrough(ts as unknown as ReadableWritablePair<Uint8Array, Uint8Array>);
  return new Uint8Array(await new Response(stream).arrayBuffer());
}
const inflateRaw = (u8: Uint8Array) => pump(u8, new DecompressionStream("deflate-raw"));
const deflateRaw = (u8: Uint8Array) => pump(u8, new CompressionStream("deflate-raw"));
const hasDeflate = () => typeof CompressionStream === "function" && typeof DecompressionStream === "function";

// ── read ──
interface CentralEntry { name: string; method: number; csize: number; lho: number }

export async function unzip(u8: Uint8Array): Promise<Map<string, Uint8Array>> {
  if (!isZip(u8)) throw new Error("not a zip file");
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  // End Of Central Directory — scan the last 64KiB for PK\x05\x06.
  let eocd = -1;
  const scanFrom = Math.max(0, u8.length - 0xffff - 22);
  for (let i = u8.length - 22; i >= scanFrom; i--) {
    if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error("zip: end-of-central-directory not found");
  const count = dv.getUint16(eocd + 10, true);
  let off = dv.getUint32(eocd + 16, true);
  const td = new TextDecoder();
  const entries: CentralEntry[] = [];
  for (let i = 0; i < count; i++) {
    if (dv.getUint32(off, true) !== 0x02014b50) throw new Error("zip: bad central directory");
    const method = dv.getUint16(off + 10, true);
    const csize = dv.getUint32(off + 20, true);
    const namelen = dv.getUint16(off + 28, true);
    const extralen = dv.getUint16(off + 30, true);
    const commentlen = dv.getUint16(off + 32, true);
    const lho = dv.getUint32(off + 42, true);
    entries.push({ name: td.decode(u8.subarray(off + 46, off + 46 + namelen)), method, csize, lho });
    off += 46 + namelen + extralen + commentlen;
  }
  const out = new Map<string, Uint8Array>();
  for (const e of entries) {
    if (dv.getUint32(e.lho, true) !== 0x04034b50) throw new Error(`zip: bad local header for ${e.name}`);
    const namelen = dv.getUint16(e.lho + 26, true);
    const extralen = dv.getUint16(e.lho + 28, true);
    const data = u8.subarray(e.lho + 30 + namelen + extralen, e.lho + 30 + namelen + extralen + e.csize);
    if (e.method === 0) out.set(e.name, data.slice());
    else if (e.method === 8) out.set(e.name, await inflateRaw(data));
    else throw new Error(`zip: unsupported compression method ${e.method} for ${e.name}`);
  }
  return out;
}

// ── write ──
export async function makeZip(entries: [string, Uint8Array][]): Promise<Uint8Array> {
  const te = new TextEncoder();
  const method = hasDeflate() ? 8 : 0;
  const parts: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  const put = (u8: Uint8Array) => { parts.push(u8); offset += u8.length; };
  const le16 = (n: number) => new Uint8Array([n & 0xff, (n >>> 8) & 0xff]);
  const le32 = (n: number) => new Uint8Array([n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff]);
  for (const [name, raw] of entries) {
    const nameBytes = te.encode(name);
    if (nameBytes.length > 0xffff) throw new Error(`zip: member name too long: ${name}`);
    const data = method === 8 ? await deflateRaw(raw) : raw;
    const crc = crc32(raw);
    const localOff = offset;
    put(new Uint8Array([0x50, 0x4b, 0x03, 0x04]));       // local header sig
    put(le16(20));                                       // version needed
    put(le16(0x0800));                                   // flags: UTF-8 names
    put(le16(method));
    put(le16(0)); put(le16(0));                          // mod time/date
    put(le32(crc)); put(le32(data.length)); put(le32(raw.length));
    put(le16(nameBytes.length)); put(le16(0));           // name, extra len
    put(nameBytes); put(data);
    central.push(
      new Uint8Array([0x50, 0x4b, 0x01, 0x02]),          // central sig
      le16(20), le16(20),                                // version made by / needed
      le16(0x0800), le16(method), le16(0), le16(0),
      le32(crc), le32(data.length), le32(raw.length),
      le16(nameBytes.length), le16(0), le16(0), le16(0), le16(0),
      le32(0), le32(localOff), nameBytes,
    );
  }
  const cdOff = offset;
  let cdLen = 0;
  for (const c of central) { parts.push(c); offset += c.length; cdLen += c.length; }
  parts.push(
    new Uint8Array([0x50, 0x4b, 0x05, 0x06]),            // EOCD sig
    le16(0), le16(0), le16(entries.length), le16(entries.length),
    le32(cdLen), le32(cdOff), le16(0),
  );
  offset += 22;
  const out = new Uint8Array(offset);
  let pos = 0;
  for (const p of parts) { out.set(p, pos); pos += p.length; }
  return out;
}

// ── bundle ──
export interface BundleContents {
  manifest: { schema?: string; model?: string; session?: string } | null;
  modelBytes: Uint8Array | null;
  sessionText: string | null;
  members: string[];
}

/** Extract the model + session members of an .omz. Member names come from the
 *  manifest when present, else by convention: model = `model.json` (or the first
 *  .json that isn't the session/manifest), session = `*.omsession.json`
 *  (or `session.json`). Tolerant like the rest of the session layer. */
export async function readBundle(u8: Uint8Array): Promise<BundleContents> {
  const files = await unzip(u8);
  const td = new TextDecoder();
  let manifest: BundleContents["manifest"] = null;
  const mBytes = files.get(BUNDLE_MANIFEST_MEMBER);
  if (mBytes) { try { manifest = JSON.parse(td.decode(mBytes)); } catch {} }
  const pickModel = () => {
    const name = manifest?.model;
    if (name && files.has(name)) return files.get(name)!;
    if (files.has(BUNDLE_MODEL_MEMBER)) return files.get(BUNDLE_MODEL_MEMBER)!;
    for (const [n, b] of files) if (/\.json$/i.test(n) && n !== BUNDLE_MANIFEST_MEMBER && !/\.omsession\.json$/i.test(n)) return b;
    return null;
  };
  const pickSession = () => {
    const name = manifest?.session;
    if (name && files.has(name)) return td.decode(files.get(name)!);
    if (files.has(BUNDLE_SESSION_MEMBER)) return td.decode(files.get(BUNDLE_SESSION_MEMBER)!);
    for (const [n, b] of files) if (/\.omsession\.json$/i.test(n)) return td.decode(b);
    return null;
  };
  return { manifest, modelBytes: pickModel(), sessionText: pickSession(), members: [...files.keys()] };
}

/** Wrap model bytes + a session descriptor into a single .omz. The session's
 *  `model` field should be `{bundle: "model.json"}` — the caller sets it. */
export async function makeBundle(modelBytes: Uint8Array, sessionJson: string): Promise<Uint8Array> {
  const te = new TextEncoder();
  const manifest = JSON.stringify({ schema: BUNDLE_SCHEMA, model: BUNDLE_MODEL_MEMBER, session: BUNDLE_SESSION_MEMBER });
  return makeZip([
    [BUNDLE_MANIFEST_MEMBER, te.encode(manifest)],
    [BUNDLE_MODEL_MEMBER, modelBytes],
    [BUNDLE_SESSION_MEMBER, te.encode(sessionJson)],
  ]);
}
