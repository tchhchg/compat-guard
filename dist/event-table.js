/**
 * Event table extracted from the host's own type declarations.
 *
 * Cordis dispatches events by string name, and every package widens the shared
 * `Events` interface through declaration merging. There is no single exported
 * table, so the truth source is the set of `.d.ts` files that declare
 * `interface Events`. We read them syntactically (no type checking) because we
 * only need member names and parameter counts.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
const SKIP_DIRS = new Set(["node_modules", ".git", ".cache", "dist"]);
/** Collect every `.d.ts` under `<pkgRoot>/lib` (bounded depth) that declares `interface Events`. */
function collectDeclarationFiles(root, maxDepth = 3) {
    const found = [];
    const walk = (dir, depth) => {
        if (depth > maxDepth)
            return;
        let entries;
        try {
            entries = readdirSync(dir);
        }
        catch {
            return;
        }
        for (const entry of entries) {
            if (SKIP_DIRS.has(entry))
                continue;
            const full = join(dir, entry);
            let st;
            try {
                st = statSync(full);
            }
            catch {
                continue;
            }
            if (st.isDirectory()) {
                walk(full, depth + 1);
                continue;
            }
            if (!entry.endsWith(".d.ts"))
                continue;
            try {
                if (readFileSync(full, "utf8").includes("interface Events"))
                    found.push(full);
            }
            catch {
                /* unreadable declaration: ignore, absence is reported by `scanned` */
            }
        }
    };
    walk(root, 0);
    return found;
}
/** Read one `.d.ts` and harvest every member of `interface Events`. */
function harvestFile(file, pkgName, into) {
    const text = readFileSync(file, "utf8");
    const sf = ts.createSourceFile(file, text, ts.ScriptTarget.ESNext, false, ts.ScriptKind.TS);
    const visit = (node) => {
        if (ts.isInterfaceDeclaration(node) && node.name.text === "Events") {
            for (const member of node.members) {
                // String-literal members: `'name'(args): void`
                const nameNode = member.name;
                if (!nameNode)
                    continue;
                if (!ts.isStringLiteral(nameNode) && !ts.isNoSubstitutionTemplateLiteral(nameNode))
                    continue;
                const name = nameNode.text;
                // A symbol index signature (`[key: symbol]`) is not a nameable event.
                if (name.length === 0)
                    continue;
                const sig = member;
                const arity = sig.parameters ? sig.parameters.length : 0;
                if (!into.has(name))
                    into.set(name, { arity, source: pkgName });
            }
        }
        ts.forEachChild(node, visit);
    };
    visit(sf);
}
/**
 * Build the event table for the installed host.
 *
 * @param modulesRoot — the profile's `node_modules` directory.
 * @returns the table, plus the list of declaration files actually scanned.
 */
export function buildEventTable(modulesRoot) {
    const events = new Map();
    const scanned = [];
    let scopeRoot;
    try {
        scopeRoot = join(modulesRoot, "@deepseek-ai");
        statSync(scopeRoot);
    }
    catch {
        return { events, scanned, unavailable: `no @deepseek-ai scope under ${modulesRoot}` };
    }
    let pkgs;
    try {
        pkgs = readdirSync(scopeRoot).filter((n) => !n.startsWith("."));
    }
    catch (error) {
        return { events, scanned, unavailable: `cannot list ${scopeRoot}: ${String(error)}` };
    }
    for (const pkg of pkgs) {
        const pkgDir = join(scopeRoot, pkg);
        const libDir = join(pkgDir, "lib");
        try {
            statSync(libDir);
        }
        catch {
            continue;
        }
        for (const file of collectDeclarationFiles(libDir)) {
            try {
                harvestFile(file, `@deepseek-ai/${pkg}`, events);
                scanned.push(file);
            }
            catch {
                /* a malformed declaration must not abort the whole table */
            }
        }
    }
    if (events.size === 0) {
        return { events, scanned, unavailable: `no Events members found across ${scanned.length} declarations` };
    }
    return { events, scanned };
}
const DISPATCH_METHODS = new Set(["on", "emit", "parallel", "serial", "bail", "waterfall"]);
/**
 * Whether a receiver expression is the cordis context.
 *
 * This is the whole difference between a useful check and 325 false BLOCKERs: plugin
 * code also calls `.on('close')` on sockets, streams and `EventEmitter`s, and those names
 * never appear in the host event table. Only `ctx.<dispatch>(…)` (or `this.ctx.<dispatch>(…)`)
 * speaks the cordis event protocol; everything else is somebody else's emitter.
 */
function isContextReceiver(expr) {
    if (ts.isIdentifier(expr))
        return expr.text === "ctx" || expr.text === "context";
    // this.ctx / self.ctx
    if (ts.isPropertyAccessExpression(expr)) {
        return expr.name.text === "ctx" || expr.name.text === "context";
    }
    return false;
}
/**
 * Find `ctx.<dispatch>('event-name', …)` calls in a plugin source file.
 *
 * Only string literals are recovered: a computed name cannot be checked, and
 * guessing one would turn a "we cannot tell" into a false verdict.
 */
export function extractEventUses(file, text) {
    const uses = [];
    const sf = ts.createSourceFile(file, text, ts.ScriptTarget.ESNext, false, ts.ScriptKind.TSX);
    const visit = (node) => {
        if (ts.isCallExpression(node) &&
            ts.isPropertyAccessExpression(node.expression) &&
            isContextReceiver(node.expression.expression)) {
            const method = node.expression.name.text;
            if (DISPATCH_METHODS.has(method)) {
                const first = node.arguments[0];
                if (first && (ts.isStringLiteral(first) || ts.isNoSubstitutionTemplateLiteral(first))) {
                    const pos = sf.getLineAndCharacterOfPosition(node.getStart(sf));
                    const use = {
                        name: first.text,
                        via: method,
                        file,
                        line: pos.line + 1,
                    };
                    // A listener that declares MORE parameters than the host supplies is the
                    // dangerous direction; declaring fewer is legal JavaScript and ignored.
                    const listener = node.arguments[1];
                    if (listener && (ts.isArrowFunction(listener) || ts.isFunctionExpression(listener))) {
                        use.listenerArity = listener.parameters.length;
                    }
                    uses.push(use);
                }
            }
        }
        ts.forEachChild(node, visit);
    };
    visit(sf);
    return uses;
}
