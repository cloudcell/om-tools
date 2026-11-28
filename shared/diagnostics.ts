// diagnostics.ts — diagnostics-report support shared by both hosts (the VS
// Code extension host imports it directly; om-tools-web's sync.sh compiles it
// to app/om-diagnostics.js for the in-page backend). DOM-free, dependency-free,
// no engine calls — the host gathers inputs, this formats them.
//
// Privacy model (a-08-0d, standard telemetry practice):
//   - whitelist, never bulk-dump
//   - identifiers → id_<hash> keyed by a per-report random salt: the same name
//     maps to one id inside a report, never across reports (the salt itself is
//     never emitted)
//   - values → type tags (<str>, <num>), paths → masked
//   - what cannot be verified clean is dropped, not included

/** Bounded timestamped line buffer — the always-on capture behind the report. */
export class DiagRing {
    private lines: string[] = [];
    constructor(private cap = 2000) {}
    push(line: string) {
        for (const l of String(line).split("\n")) {
            if (!l) continue;
            this.lines.push(`${new Date().toISOString()} ${l}`);
        }
        if (this.lines.length > this.cap) this.lines.splice(0, this.lines.length - this.cap);
    }
    all(): string[] { return this.lines.slice(); }
    get size(): number { return this.lines.length; }
    clear() { this.lines = []; }
}

// ── Scrubber ────────────────────────────────────────────────────────────
// FNV-1a 64-bit over salt+name → 8 hex chars. Not cryptographic — the defense
// is the per-report salt, which never leaves the host; without it a guessed
// name cannot be verified against an id.

function randomSalt(): string {
    const c = (globalThis as any).crypto;
    if (c?.getRandomValues) {
        const b = new Uint8Array(16);
        c.getRandomValues(b);
        return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
    }
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function fnv1a64(s: string): string {
    let h = 0xcbf29ce484222325n;
    const prime = 0x100000001b3n;
    for (let i = 0; i < s.length; i++) {
        h ^= BigInt(s.charCodeAt(i));
        h = (h * prime) & 0xffffffffffffffffn;
    }
    return h.toString(16).padStart(16, "0").slice(0, 8);
}

export interface Scrubber {
    /** Stable pseudonym for a name within this report. */
    id(name: string): string;
    /** Paths, dictionary names, name-shaped patterns, quoted literals. */
    scrubText(s: string): string;
    /** scrubText + numeric literals → <num> (formula texts). */
    scrubExpression(s: string): string;
}

// Engine vocabulary prefixes that are not user data (event/command topics).
const SAFE_PREFIX = /^(?:event|command|request|om|ts|wasm)[._]/;

export function createScrubber(opts?: { salt?: string; names?: string[] }): Scrubber {
    const salt = opts?.salt ?? randomSalt();
    const cache = new Map<string, string>();
    const id = (name: string): string => {
        let v = cache.get(name);
        if (v === undefined) { v = `id_${fnv1a64(salt + "\x00" + name)}`; cache.set(name, v); }
        return v;
    };
    // Longest first so a name that is a prefix of another replaces correctly.
    // Each name compiles to a boundary-guarded regex: adjacent word chars mean
    // the match is inside a larger token (item "A" must not hit the A in
    // "fullRecomputeAndBootstrap" or "BFS"; id "id_15" must not hit "id_156").
    const esc = (n: string) => n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const dict = (opts?.names ?? []).filter((n) => typeof n === "string" && n.length > 0)
        .sort((a, b) => b.length - a.length)
        .map((n) => ({ n, re: new RegExp(`(?<![\\w])${esc(n)}(?![\\w])`, "g") }));

    const scrubText = (text: string): string => {
        let s = String(text);
        // Endpoints and URLs first — they contain hosts/usernames.
        s = s.replace(/unix:\/\/[^\s"']*openm-[^.\s"']*\.sock/g, "unix:///tmp/openm-<user>.sock");
        s = s.replace(/unix:\/\/[^\s"']+/g, (m) => m.includes("<") ? m : "unix://<path>");
        s = s.replace(/tcp:\/\/[^\s"':/]+:(\d+)/g, "tcp://<host>:$1");
        s = s.replace(/tcp:\/\/[^\s"']+/g, (m) => m.includes("<") ? m : "tcp://<host>");
        s = s.replace(/wss?:\/\/[^\s"']+/g, "ws://<host>");
        s = s.replace(/https?:\/\/[^\s"']+/g, "<url>");
        // Bare absolute paths (posix + windows-drive). Skip when the match is
        // immediately followed by a mask placeholder it would mangle (e.g. the
        // `<user>.sock` emitted by the unix-socket rule above).
        s = s.replace(/(?:[A-Za-z]:)?[/\\][\w.~+@-]+(?:[/\\][\w.~+@-]+)+/g, (m, off) =>
            s[off + m.length] === "<" ? m : "<path>");
        // Dictionary names (longest-first, word-boundary guarded).
        for (const { n, re } of dict) s = s.replace(re, () => id(n));
        // Name-shaped leftovers not in the dictionary: Word[…], Word.Word.
        // Matches already produced by the dictionary pass start with id_ — skip.
        s = s.replace(/\b[A-Za-z_]\w*\s*\[[^\]\n]{1,120}\]/g, (m) =>
            m.startsWith("id_") ? m : id(m));
        s = s.replace(/\b[A-Za-z_]\w*\.[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*\b/g, (m, off) =>
            m.startsWith("id_") || SAFE_PREFIX.test(m) || s[off - 1] === "<" ? m : id(m));
        // Quoted literals last. A single token → pseudonym unless it already
        // is one (dict pass ran on the whole line — don't double-hash). Multi-
        // word text keeps its words: the dict/pattern passes already scrubbed
        // any names inside, and quoting in engine logs wraps messages like
        // "missing view_id argument" — collapsing to <str> hides exactly the
        // errors a diagnostics report exists for.
        s = s.replace(/"([^"\\\n]{0,200})"|'([^'\\\n]{0,200})'/g, (m, dq, sq) => {
            const inner: string = dq ?? sq ?? "";
            if (/^id_[0-9a-f]{8}$/.test(inner)) return m;
            return /^\S{1,60}$/.test(inner) ? id(inner) : m;
        });
        return s;
    };

    const scrubExpression = (text: string): string =>
        scrubText(text).replace(/\b\d+(?:\.\d+)?\b/g, "<num>");

    return { id, scrubText, scrubExpression };
}

// ── Report ──────────────────────────────────────────────────────────────

export interface DiagnosticsReportInput {
    /** "vscode-extension" | "web" */
    host: string;
    /** ISO timestamp; defaults to now. */
    generated?: string;
    versions?: { ext?: string; gui?: string; eng?: string; tsr?: string };
    /** Raw endpoint — scrubbed inside the formatter. */
    endpoint?: string;
    /** "embedded" | "socket" | other mode label. */
    mode?: string;
    /** e.g. "linux x64 node v22" or the UA string. */
    platform?: string;
    sessionId?: string;
    connected?: boolean;
    /** Whitelisted settings only (string|number|boolean). */
    settings?: Record<string, unknown>;
    /** query_id → payload; rule_eval_profile expressions are scrubbed. */
    diagnostics?: Record<string, unknown>;
    /** Host-side ring: lifecycle + failed command/query lines. */
    lifecycle?: string[];
    /** Engine/session ring lines (raw — scrubbed inside). */
    log?: string[];
    /** Buffered wasm engine stderr lines (omz_host_log ring — names dispatch faults behind status -14). */
    engine_log?: string[];
    /** Socket mode: where the engine's own log lives instead. */
    externalEngineLog?: string | null;
    /** Name dictionary for the scrubber. */
    names?: string[];
    /** Salt override — tests only. */
    salt?: string;
}

export interface DiagnosticsReport {
    text: string;
    suggestedName: string;
}

const SECRET_RE = /key|token|secret|password/i;
// "error/warn" line counter: real failures only — routine stat lines carry
// benign counters ("expected=0 ok=0 failed=0") that must not inflate it.
const ERR_RE = /error|exception|fatal|warn|fail(?![a-z]*=0)/i;

function settingLine(k: string, v: unknown, scrub: Scrubber): string {
    if (SECRET_RE.test(k)) return `${k}: [redacted]`;
    if (typeof v === "boolean" || typeof v === "number") return `${k}: ${v}`;
    if (typeof v === "string") return SECRET_RE.test(v) ? `${k}: [redacted]` : `${k}: ${scrub.scrubText(v)}`;
    return `${k}: <${Array.isArray(v) ? "list" : typeof v}>`;
}

function scrubJson(v: unknown, scrub: Scrubber, exprKeys: Set<string>): unknown {
    if (typeof v === "string") return scrub.scrubText(v);
    if (Array.isArray(v)) return v.map((x) => scrubJson(x, scrub, exprKeys));
    if (v && typeof v === "object") {
        const o: Record<string, unknown> = {};
        for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
            // No secret-name check here: diagnostics payload keys are engine
            // vocabulary ("…_key_ns", "…_key_call_count") — redacting them
            // destroys real counters. User-controlled keys live only in the
            // settings section (settingLine), where the check stays.
            o[k] = exprKeys.has(k) && typeof x === "string" ? scrub.scrubExpression(x) : scrubJson(x, scrub, exprKeys);
        }
        return o;
    }
    return v;
}

/** Keys inside diagnostics payloads whose string values are formula texts. */
const EXPR_KEYS = new Set(["expression"]);

export function formatDiagnosticsReport(input: DiagnosticsReportInput): DiagnosticsReport {
    const generated = input.generated ?? new Date().toISOString();
    const scrub = createScrubber({ salt: input.salt, names: input.names });
    const out: string[] = [];

    out.push("OM Core diagnostics report");
    out.push(`generated: ${generated}`);
    out.push("privacy: names are one-way hashed (id_*) with a per-report salt;");
    out.push("paths and literals are masked — review before sharing.");
    out.push("");
    out.push("[host]");
    out.push(`host: ${input.host}`);
    if (input.endpoint) out.push(`endpoint: ${scrub.scrubText(input.endpoint)}`);
    if (input.mode) out.push(`mode: ${input.mode}`);
    if (input.platform) out.push(`platform: ${input.platform}`);
    if (input.sessionId) out.push(`session: ${input.sessionId}`);
    out.push(`connected: ${input.connected === undefined ? "unknown" : input.connected}`);
    out.push("");
    out.push("[versions]");
    const v = input.versions ?? {};
    // An unstamped tsr means the host is running the vendored engine/ copy
    // (no build stamp) — the stale-engine tell from the 0.1.17 packaging gap.
    const tsr = v.tsr ?? "- (vendored engine, unstamped)";
    out.push(`ext: ${v.ext ?? "-"}`, `gui: ${v.gui ?? "-"}`, `eng: ${v.eng ?? "-"}`, `tsr: ${tsr}`);
    out.push("");
    out.push("[settings]");
    const settings = Object.entries(input.settings ?? {});
    if (settings.length === 0) out.push("(none)");
    else for (const [k, val] of settings) out.push(settingLine(k, val, scrub));
    out.push("");
    out.push("[engine diagnostics]");
    const diag = Object.entries(input.diagnostics ?? {});
    if (diag.length === 0) out.push("(not connected)");
    else for (const [k, val] of diag) out.push(`${k}: ${JSON.stringify(scrubJson(val, scrub, EXPR_KEYS))}`);
    out.push("");
    out.push("[lifecycle / recent errors]");
    const life = (input.lifecycle ?? []).map((l) => scrub.scrubText(l));
    if (life.length === 0) out.push("(none)");
    else out.push(...life);
    out.push("");
    out.push("[engine stderr]");
    const stderr = (input.engine_log ?? []).map((l) => scrub.scrubText(l));
    if (stderr.length === 0) out.push("(none)");
    else out.push(...stderr);
    out.push("");
    out.push("[engine diary]");
    const log = (input.log ?? []).map((l) => scrub.scrubText(l));
    const errLines = log.filter((l) => ERR_RE.test(l));
    out.push(`${log.length} lines captured; ${errLines.length} error/warn lines`);
    if (input.externalEngineLog) out.push(`note: ${scrub.scrubText(input.externalEngineLog)}`);
    if (log.length === 0) out.push("(empty)");
    else {
        // Compress runs of identical scrubbed lines — a repeated error (e.g.
        // a polled RPC failing each tick) reads as one line with a count.
        out.push("--- lines ---");
        for (let i = 0; i < log.length; i++) {
            let n = 1;
            while (i + n < log.length && log[i + n] === log[i]) n++;
            out.push(n > 1 ? `${log[i]}  (×${n})` : log[i]);
            i += n - 1;
        }
    }

    const d = new Date(generated);
    const p = (n: number) => String(n).padStart(2, "0");
    const ts = isNaN(d.getTime()) ? "unknown"
        : `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
    return { text: out.join("\n") + "\n", suggestedName: `OM_Diagnostics_${ts}.log` };
}
