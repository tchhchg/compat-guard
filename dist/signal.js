/**
 * Turn the isolated host's output into structured signals.
 *
 * Every pattern here was observed in a real run against this host. Two of them look
 * similar but mean opposite things and must not be merged:
 *
 *   `dsh: disabling profile plugin "X": <reason>`  -> the host's own compatibility
 *       preflight denied the row. The host will boot fine; the plugin will not load.
 *       This is INFORMATION, not a crash.
 *
 *   `X (id): pending (waiting for services: a, b)` -> the plugin loaded but never
 *       activated because a service it injects is absent from THIS composition. In the
 *       isolated profile that is frequently our own doing (a minimal bundle list), so it
 *       must be classified as UNKNOWN unless the service exists in the real profile.
 */
const RE_PREFLIGHT_DISABLED = /^dsh: disabling profile plugin (.+?): (.+)$/;
const RE_PENDING = /^(\S+) \((\S+)\): pending \(waiting for services: (.+)\)$/;
const RE_DID_NOT_ACTIVATE = /^dsh: warning: (\d+) entry did not activate/;
const RE_STACK_FRAME = /^\s+at .*?(?:[\\/]node_modules[\\/](@[^\\/]+[\\/])?([^\\/\s)]+))[\\/]/;
const RE_ERROR_HEAD = /^(?:Error|TypeError|ReferenceError|SyntaxError|RangeError): (.+)$/;
export function parseSignals(stderr, stdout = "") {
    const signals = [];
    const lines = `${stderr}\n${stdout}`.split(/\r?\n/);
    for (const raw of lines) {
        const line = raw.trimEnd();
        if (line.length === 0)
            continue;
        let m = RE_PREFLIGHT_DISABLED.exec(line);
        if (m) {
            signals.push({
                kind: "preflight-disabled",
                line,
                plugin: unquote(m[1] ?? ""),
                detail: m[2] ?? "",
            });
            continue;
        }
        m = RE_PENDING.exec(line);
        if (m) {
            signals.push({
                kind: "pending",
                line,
                plugin: m[1] ?? "",
                detail: (m[3] ?? "").trim(),
            });
            continue;
        }
        m = RE_DID_NOT_ACTIVATE.exec(line);
        if (m) {
            signals.push({ kind: "did-not-activate", line, detail: m[1] ?? "" });
            continue;
        }
        m = RE_STACK_FRAME.exec(line);
        if (m) {
            signals.push({
                kind: "stack-frame",
                line,
                // m[2] is the package directory name inside node_modules (scope stripped).
                plugin: m[1] ? `${m[1]}${m[2]}` : (m[2] ?? ""),
            });
            continue;
        }
        m = RE_ERROR_HEAD.exec(line);
        if (m) {
            signals.push({ kind: "error-line", line, detail: m[1] ?? "" });
            continue;
        }
    }
    return signals;
}
function unquote(value) {
    return value.replace(/^["']|["']$/g, "");
}
/**
 * A pending signal is only a real defect when the missing service exists in the target
 * composition. In the isolated profile a missing service usually means "we did not mount
 * the bundle that provides it".
 */
export function pendingIsDefect(pendingServices, servicesProvided) {
    const needed = pendingServices
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
    if (needed.length === 0)
        return false;
    return needed.every((service) => servicesProvided.has(service));
}
/** Parse `waiting for services: a, b` into a list. */
export function splitServices(detail) {
    if (!detail)
        return [];
    return detail
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
}
