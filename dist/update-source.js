/**
 * Version discovery for `--auto`: find out what is installed and what the newest
 * published release is, so the user never has to type two version numbers.
 *
 * Installed version comes from the same file the host itself reads
 * (`@deepseek-ai/dsh-app-boot/package.json` -> version), so it cannot disagree
 * with what the loader thinks it is running.
 *
 * Newest version comes from the npm registry, because `@deepseek-ai/dsh` is
 * published there (42 versions at the time of writing, `dist-tags.latest`
 * matching the desktop build). Two registries are tried: the public one first
 * for correctness, the mirror second because it answers in ~160ms where the
 * public one can take several seconds or fail behind a proxy.
 */
import { existsSync, readFileSync } from "node:fs";
import { get } from "node:https";
import { join } from "node:path";
import semver from "semver";
/**
 * One-shot HTTPS GET that never leaves a pooled socket behind (agent: false).
 *
 * fetch() would be shorter, but undici keeps its connection pool open and an
 * immediate process.exit() then trips the libuv UV_HANDLE_CLOSING assertion on
 * Windows — observed as exit code 127 with a valid JSON line already printed.
 * The contract cannot tolerate a wrong exit code, so the request path avoids
 * keep-alive entirely.
 */
function getJson(url, timeoutMs) {
    return new Promise((resolve, reject) => {
        const request = get(url, { agent: false, headers: { accept: "application/vnd.npm.install-v1+json" } }, (response) => {
            const status = response.statusCode ?? 0;
            if (status < 200 || status >= 300) {
                response.resume();
                reject(new Error(`HTTP ${status}`));
                return;
            }
            let body = "";
            response.setEncoding("utf8");
            response.on("data", (chunk) => {
                body += chunk;
            });
            response.on("end", () => {
                try {
                    resolve(JSON.parse(body));
                }
                catch (error) {
                    reject(error instanceof Error ? error : new Error(String(error)));
                }
            });
            response.on("error", reject);
        });
        request.setTimeout(timeoutMs, () => {
            request.destroy(new Error(`timeout after ${timeoutMs}ms`));
        });
        request.on("error", reject);
    });
}
const PACKAGE = "@deepseek-ai/dsh";
const REGISTRIES = [
    { name: "registry.npmjs.org", url: `https://registry.npmjs.org/${encodeURIComponent(PACKAGE)}` },
    { name: "registry.npmmirror.com", url: `https://registry.npmmirror.com/${encodeURIComponent(PACKAGE)}` },
];
/** The host's own runtime version, read exactly where the host reads it. */
export function installedDshVersion(profileDir) {
    const candidates = [
        join(profileDir, "node_modules", "@deepseek-ai", "dsh-app-boot", "package.json"),
        join(profileDir, "node_modules", "@deepseek-ai", "dsh", "package.json"),
    ];
    for (const path of candidates) {
        if (!existsSync(path))
            continue;
        try {
            const manifest = JSON.parse(readFileSync(path, "utf8"));
            if (typeof manifest.version === "string" && semver.valid(manifest.version) !== null) {
                return { version: manifest.version, source: path };
            }
        }
        catch {
            // Try the next candidate.
        }
    }
    return { version: null, source: "", error: "找不到已安装的 dsh 版本（node_modules 里没有 dsh-app-boot/dsh）" };
}
/** Newest published release, with the registry that answered. */
export async function latestDshVersion(timeoutMs = 8000) {
    let lastError = "";
    for (const registry of REGISTRIES) {
        const started = Date.now();
        try {
            const body = (await getJson(registry.url, timeoutMs));
            const ms = Date.now() - started;
            const tags = body["dist-tags"] ?? {};
            const latest = typeof tags.latest === "string" ? tags.latest : null;
            const versions = body.versions === undefined ? 0 : Object.keys(body.versions).length;
            if (latest === null) {
                lastError = `${registry.name}: 响应里没有 dist-tags.latest`;
                continue;
            }
            return { version: latest, source: registry.name, versions, ms };
        }
        catch (error) {
            lastError = `${registry.name}: ${error instanceof Error ? error.message : String(error)}`;
        }
    }
    return { version: null, source: "", versions: 0, ms: 0, error: lastError || "所有 registry 都不可达" };
}
export function relate(installed, latest) {
    if (installed === null || latest === null)
        return "unknown";
    if (installed === latest)
        return "same";
    const a = semver.valid(installed);
    const b = semver.valid(latest);
    if (a === null || b === null)
        return "unknown";
    return semver.gt(b, a) ? "newer" : "older";
}
