/**
 * ADR-0004 cell value formatting — TS port of om-core's
 * lib_openm/formatting/preset_parser.py,
 * lib_contracts/gui_read_models/format_renderer.py and
 * lib_gui_elements/matrix/value_format.py (`format_cell_value`).
 *
 * Format strings: "general" | "preset:<kind>(k=v; k=v)" | "pattern:..." (deferred).
 * Supported kinds: general, number, currency, percent, scientific, boolean.
 * date/time/datetime/pattern render as str(value) — same as the Python MVP.
 */

export interface CellFormats {
    format_number?: string | null;
    format_text?: string | null;
    format_null?: string | null;
    format_error?: string | null;
}

interface FormatPreset {
    kind: string;
    args: Record<string, string | number | boolean>;
}

const VALID_KINDS = new Set([
    "general", "number", "currency", "percent", "scientific",
    "boolean", "date", "time", "datetime",
]);

const REQUIRED_ARGS: Record<string, Set<string>> = {
    general: new Set(), number: new Set(), currency: new Set(["code"]),
    percent: new Set(), scientific: new Set(), boolean: new Set(["style"]),
    date: new Set(["pattern"]), time: new Set(["pattern"]), datetime: new Set(["pattern"]),
};

const DEFAULTS: Record<string, Record<string, string | number | boolean>> = {
    general: {},
    number: { decimals: 2, group: false, negative: "minus", zero: "normal" },
    currency: { decimals: 2, symbol: false, negative: "minus", zero: "normal" },
    percent: { decimals: 0 },
    scientific: { decimals: 2 },
    boolean: {}, date: {}, time: {}, datetime: {},
};

class FormatParseError extends Error {}

/** Strip one outer matching quote pair (normalize_format_string). */
function normalizeFormatString(raw: string): string {
    const stripped = String(raw ?? "").trim();
    if (!stripped) return stripped;
    const first = stripped[0], last = stripped[stripped.length - 1];
    if (first === "'" || first === '"') {
        if (last !== first || stripped.length <= 2) throw new FormatParseError("mismatched quotes");
        return stripped.slice(1, -1);
    }
    return stripped;
}

function parseArgs(argsStr: string): Record<string, string | number | boolean> {
    const args: Record<string, string | number | boolean> = {};
    if (!argsStr) return args;
    for (const part of argsStr.split(";")) {
        const eq = part.indexOf("=");
        if (eq < 0) throw new FormatParseError(`malformed arg: ${part}`);
        const k = part.slice(0, eq).trim(), v = part.slice(eq + 1).trim();
        if (!k) throw new FormatParseError("empty arg name");
        if (v === "true") args[k] = true;
        else if (v === "false") args[k] = false;
        else if (/^-?\d+$/.test(v)) args[k] = parseInt(v, 10);
        else args[k] = v;
    }
    return args;
}

const VALID_BOOLEAN_STYLES = new Set(["true_false", "yes_no", "one_zero"]);
const VALID_NEGATIVE_STYLES = new Set(["minus", "parentheses"]);
const VALID_ZERO_STYLES = new Set(["normal", "dash"]);

function parsePreset(text: string): FormatPreset {
    text = text.trim();
    if (!text) throw new FormatParseError("empty format string");
    if (text === "general") return { kind: "general", args: {} };
    if (text.startsWith("pattern:")) {
        // Deferred in the Python MVP — render as str(value).
        return { kind: "__pattern__", args: {} };
    }
    if (!text.startsWith("preset:")) throw new FormatParseError(`expected preset: ${text}`);
    const body = text.slice("preset:".length);
    const paren = body.indexOf("(");
    if (paren < 0 || !body.endsWith(")")) throw new FormatParseError(`bad preset: ${text}`);
    const kind = body.slice(0, paren).trim();
    if (!VALID_KINDS.has(kind)) throw new FormatParseError(`unknown preset kind: ${kind}`);
    const args = { ...(DEFAULTS[kind] ?? {}), ...parseArgs(body.slice(paren + 1, -1)) };
    for (const req of REQUIRED_ARGS[kind] ?? []) {
        if (!(req in args)) throw new FormatParseError(`missing arg: ${req}`);
    }
    const neg = String(args.negative ?? "minus"), zero = String(args.zero ?? "normal"), bs = String(args.style ?? "");
    if (args.negative !== undefined && !VALID_NEGATIVE_STYLES.has(neg)) throw new FormatParseError(`bad negative: ${neg}`);
    if (args.zero !== undefined && !VALID_ZERO_STYLES.has(zero)) throw new FormatParseError(`bad zero: ${zero}`);
    if (kind === "boolean" && !VALID_BOOLEAN_STYLES.has(bs)) throw new FormatParseError(`bad boolean style: ${bs}`);
    return { kind, args };
}

function groupThousands(intPart: string): string {
    return intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

function formatAmount(num: number, decimals: number, group: boolean, negative: string, zero: string): string {
    if (num === 0 && zero === "dash") {
        const raw = "-";
        return negative === "parentheses" ? ` ${raw} ` : raw;
    }
    const fixed = Math.abs(num).toFixed(decimals);
    const dot = fixed.indexOf(".");
    const intPart = dot < 0 ? fixed : fixed.slice(0, dot);
    const frac = dot < 0 ? "" : fixed.slice(dot);
    const raw = (group ? groupThousands(intPart) : intPart) + frac;
    if (num < 0) return negative === "parentheses" ? `(${raw})` : `-${raw}`;
    return negative === "parentheses" ? ` ${raw} ` : raw;
}

function toFloat(value: unknown): number {
    const n = typeof value === "number" ? value : parseFloat(String(value));
    if (Number.isNaN(n)) throw new FormatParseError(`non-numeric: ${value}`);
    return n;
}

/** FormatRenderer.render — preset kinds that are deferred yield str(value). */
function renderPreset(value: unknown, preset: FormatPreset): string {
    const { kind, args } = preset;
    switch (kind) {
        case "general": return String(value);
        case "number":
            return formatAmount(toFloat(value),
                typeof args.decimals === "number" ? args.decimals : 2,
                args.group === true, String(args.negative ?? "minus"), String(args.zero ?? "normal"));
        case "currency":
            return `${args.code} ${formatAmount(toFloat(value),
                typeof args.decimals === "number" ? args.decimals : 2,
                true, String(args.negative ?? "minus"), String(args.zero ?? "normal"))}`;
        case "percent": {
            const d = typeof args.decimals === "number" ? args.decimals : 0;
            return `${(toFloat(value) * 100).toFixed(d)}%`;
        }
        case "scientific": {
            const d = typeof args.decimals === "number" ? args.decimals : 2;
            // Python's f"{n:.2E}" — uppercase E, exponent padded to 2 digits
            return toFloat(value).toExponential(d).replace(/e([+-]?)(\d+)$/, (_, sign, digits) =>
                `E${sign === "-" ? "-" : "+"}${digits.padStart(2, "0")}`);
        }
        case "boolean": {
            const t = toFloat(value) !== 0;
            switch (String(args.style ?? "true_false")) {
                case "true_false": return t ? "TRUE" : "FALSE";
                case "yes_no": return t ? "Yes" : "No";
                case "one_zero": return t ? "1" : "0";
                default: return String(value);
            }
        }
        default: return String(value); // date/time/datetime/pattern: deferred
    }
}

/** _legacy_format_number — hardcoded fallback for unparseable patterns. */
function legacyFormatNumber(value: unknown, pattern: string): string {
    let num: number;
    try { num = toFloat(value); } catch { return String(value); }
    switch (pattern) {
        case "general": return String(value);
        case "number": return groupThousands(Math.abs(num).toFixed(2).split(".")[0]) + "." + Math.abs(num).toFixed(2).split(".")[1];
        case "currency":
            return num < 0 ? `($${Math.abs(num).toFixed(2)})` : `$${num.toFixed(2)}`;
        case "percentage": return `${(num * 100).toFixed(2)}%`;
        case "scientific": return num.toExponential(2);
        default: return String(value);
    }
}

/** _format_number — preset parse first, legacy fallback on failure. */
function formatNumberValue(value: unknown, formatPattern: string | null | undefined): string {
    const pattern = formatPattern == null ? "general" : String(formatPattern);
    try {
        return renderPreset(value, parsePreset(normalizeFormatString(pattern)));
    } catch (e) {
        if (e instanceof FormatParseError) return legacyFormatNumber(value, pattern);
        return String(value);
    }
}

/** _format_text — upper/lower/title/truncate:N masks. */
function formatTextValue(value: string, formatPattern: string | null | undefined): string {
    if (!formatPattern) return value;
    if (formatPattern === "upper") return value.toUpperCase();
    if (formatPattern === "lower") return value.toLowerCase();
    if (formatPattern === "title") return value.replace(/\b\w/g, c => c.toUpperCase());
    if (formatPattern.startsWith("truncate:")) {
        const n = parseInt(formatPattern.slice("truncate:".length), 10);
        if (!Number.isNaN(n) && value.length > n) return value.slice(0, n) + "…";
    }
    return value;
}

/**
 * format_cell_value — apply the @-channel format masks to a cell.
 * kind: "number" | "text" | "error" | "empty" (CellDTO.kind).
 */
export function formatCellValue(value: unknown, fmt: CellFormats, kind: string): string {
    if (value === null || value === undefined) {
        const nullFmt = fmt.format_null ?? "";
        if (nullFmt === "na") return "N/A";
        if (nullFmt === "dash") return "—";
        return "";
    }
    const v = String(value);
    switch (kind) {
        case "number":
            return formatNumberValue(value, fmt.format_number);
        case "text":
            return formatTextValue(v, fmt.format_text);
        case "error":
            return fmt.format_error ? `[${v}]` : v;
        default:
            return v;
    }
}
