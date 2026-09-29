#!/usr/bin/env node
'use strict';
/**
 * Generates skeleton scope interfaces for AngularJS controllers and directives.
 *
 *   node checker/gen-scope-types.js [--write] [--force] [--verbose] [path/filter]
 *
 * For every `module.controller('Name', [..., function ($scope, ...) {...}])`
 * and `module.directive('name', ...)` (its `controller` and/or `link`
 * function) it collects every `$scope.member` / `scope.member` reference,
 * infers a loose type from the first assignment and writes
 *
 *   <file>.scope.d.ts     ->  interface NameScope { member: type; ... }
 *
 * next to the JS file, and inserts `/** @param {ng.IScope & NameScope} $scope *\/`
 * in front of the function so `tsc --checkJs` links the two.
 *
 * Existing .scope.d.ts files are left alone unless --force is given, so hand
 * tuned interfaces survive re-runs. Without --write it only reports.
 *
 * The output is deliberately loose (`any` wherever the first assignment does
 * not give the type away). It is a starting point to refine by hand, and it
 * is what makes adopting the checker on a large codebase feasible at all.
 */
const fs = require('fs');
const path = require('path');
const { buildRegistry, controllerScopeType, directiveScopeType } = require('./registry');

const ROOT = path.resolve(__dirname, '..');
const APP = path.join(ROOT, 'src');
const args = process.argv.slice(2);
const WRITE = args.includes('--write');
const FORCE = args.includes('--force');
const FILTER = args.find(a => !a.startsWith('--')) || '';

const registry = buildRegistry(APP);

// members of ng.IScope / ng.IRootScopeService that must not be re-declared
const NG_SCOPE_MEMBERS = new Set(['$apply', '$applyAsync', '$broadcast', '$destroy', '$digest', '$emit', '$eval', '$evalAsync', '$new', '$on', '$watch', '$watchCollection', '$watchGroup', '$parent', '$root', '$id', '$$phase', '$suspend', '$resume', '$isSuspended', '$$destroyed', '$$listeners', '$$watchers', '$$childHead', '$$childTail', '$$nextSibling', '$$prevSibling']);

function matchBrace(src, start, open = '{', close = '}') {
    let depth = 0, inStr = null, inLineComment = false, inBlockComment = false;
    for (let i = start; i < src.length; i++) {
        const c = src[i], n = src[i + 1];
        if (inLineComment) { if (c === '\n') inLineComment = false; continue; }
        if (inBlockComment) { if (c === '*' && n === '/') { inBlockComment = false; i++; } continue; }
        if (inStr) { if (c === '\\') { i++; continue; } if (c === inStr) inStr = null; continue; }
        if (c === '/' && n === '/') { inLineComment = true; continue; }
        if (c === '/' && n === '*') { inBlockComment = true; i++; continue; }
        if (c === '"' || c === "'" || c === '`') { inStr = c; continue; }
        if (c === open) depth++;
        else if (c === close) { depth--; if (depth === 0) return i; }
    }
    return -1;
}

/** Find the first `function (...)` after `from` whose params contain `paramName`; returns {fnStart, paramsStart, bodyStart, bodyEnd, params}. */
function findFunctionWithParam(src, from, paramName, limit) {
    const re = /function\s*[A-Za-z_$]*\s*\(/g;
    re.lastIndex = from;
    let m;
    while ((m = re.exec(src)) && m.index < limit) {
        const pStart = m.index + m[0].length - 1;
        const pEnd = matchBrace(src, pStart, '(', ')');
        const params = src.slice(pStart + 1, pEnd).split(',').map(s => s.trim()).filter(Boolean);
        if (params.includes(paramName)) {
            const bodyStart = src.indexOf('{', pEnd);
            const bodyEnd = matchBrace(src, bodyStart);
            return { fnStart: m.index, paramsStart: pStart, bodyStart, bodyEnd, params };
        }
    }
    return null;
}

function inferType(rhs) {
    rhs = rhs.trim();
    let m;
    if ((m = /^function\s*[A-Za-z_$]*\s*\(([^)]*)\)/.exec(rhs))) {
        // JS callers may omit any argument, so every parameter is optional in the skeleton
        const ps = m[1].split(',').map(s => s.trim()).filter(Boolean).map(p => `${p}?: any`);
        return `(${ps.join(', ')}) => any`;
    }
    if (/^(true|false)\b/.test(rhs)) return 'boolean';
    if (/^-?\d+(\.\d+)?\s*;/.test(rhs)) return 'number';
    if (/^(['"]).*\1\s*;/.test(rhs) || /^(['"])[\s\S]*?\1\s*\+/.test(rhs)) return 'string';
    if (/^\[\s*\]/.test(rhs)) return 'any[]';
    if (/^null\b/.test(rhs)) return 'any';
    return 'any';
}

/** Collect `<ident>.member` accesses in body; returns Map member -> {type, assigned} */
function collectMembers(body, ident, into) {
    const escaped = ident.replace(/\$/g, '\\$');
    const re = new RegExp(`(?<![\\w$.])${escaped}\\.([A-Za-z_$][\\w$]*)`, 'g');
    let m;
    while ((m = re.exec(body))) {
        const name = m[1];
        if (NG_SCOPE_MEMBERS.has(name)) continue;
        const after = body.slice(m.index + m[0].length, m.index + m[0].length + 400);
        const entry = into.get(name) || { type: 'any', assigned: false, types: new Set(), called: false };
        const am = /^\s*=(?!=)\s*([\s\S]*)$/.exec(after);
        if (am) {
            entry.assigned = true;
            entry.types.add(inferType(am[1]));
        } else if (/^\s*\(/.test(after)) {
            entry.called = true;
        } else {
            entry.otherUse = true;
        }
        into.set(name, entry);
    }
    // a member gets a concrete type only when every assignment agrees on it
    for (const e of into.values()) {
        const ts = [...e.types];
        if (ts.length === 1 && ts[0] !== 'any') e.type = ts[0];
        else if (ts.length > 1 && ts.every(t => t.includes('=>'))) e.type = '(...args: any[]) => any';
        else if (!ts.length && e.called && !e.otherUse) e.type = '(...args: any[]) => any';
        else e.type = 'any';
    }
    return into;
}

/** `$controller('Base', {$scope: $scope})` mixes another controller's members into this scope. */
function mixins(body) {
    const out = [];
    const re = /\$controller\(\s*['"]([A-Za-z_$][\w$]*)['"]\s*,\s*\{\s*\$scope\s*:/g;
    let m;
    while ((m = re.exec(body))) out.push(controllerScopeType(m[1]));
    return out;
}

function renderInterface(name, members, bindings, header, extendsTypes = []) {
    const lines = [`/** ${header} */`, `interface ${name}${extendsTypes.length ? ' extends ' + extendsTypes.join(', ') : ''} {`];
    for (const [camel, kind] of Object.entries(bindings)) {
        const existing = members.get(camel);
        // '@' bindings arrive as strings but are often normalised to booleans/numbers in the controller, so start with `any`
        const t = kind === '&' ? '(locals?: object) => any' : (existing && existing.type !== 'any' && kind !== '@' ? existing.type : 'any');
        lines.push(`    /** \`${kind}\` binding */`);
        lines.push(`    ${camel}: ${t};`);
        members.delete(camel);
    }
    const sorted = [...members.entries()].sort(([a], [b]) => a.localeCompare(b));
    for (const [m, e] of sorted) {
        const key = /^[A-Za-z_$][\w$]*$/.test(m) ? m : JSON.stringify(m);
        lines.push(`    ${key}${e.assigned ? '' : '?'}: ${e.type};${e.assigned ? '' : ' // never assigned here: inherited from a parent scope or set by the template'}`);
    }
    lines.push('}');
    return lines.join('\n');
}

// an existing `/** @param {...} $scope */`, also when it sits before the `link:` / `controller:` key
const JSDOC_RE = /\/\*\*\s*@param\s*\{[^}]*\}\s*\$?scope\s*\*\/\s*(?:[A-Za-z_$][\w$]*\s*:\s*)?$/;

function processFile(file) {
    let src = fs.readFileSync(file, 'utf8');
    const rel = path.relative(APP, file);
    const interfaces = [];
    const edits = []; // {index, text}

    // controllers
    const cre = /\.controller\(\s*['"]([A-Za-z_$][\w$]*)['"]\s*,/g;
    let m;
    while ((m = cre.exec(src))) {
        const name = m[1];
        const fn = findFunctionWithParam(src, m.index, '$scope', src.length);
        if (!fn) continue;
        const body = src.slice(fn.bodyStart, fn.bodyEnd + 1);
        const members = collectMembers(body, '$scope', new Map());
        const type = controllerScopeType(name);
        interfaces.push(renderInterface(type, members, {}, `Scope of controller '${name}' (${rel})`, mixins(body)));
        edits.push({ index: fn.fnStart, text: `/** @param {ng.IScope & ${type}} $scope */\n`, type });
    }

    // directives
    const dre = /\.directive\(\s*['"]([A-Za-z_$][\w$]*)['"]\s*,/g;
    while ((m = dre.exec(src))) {
        const name = m[1];
        const next = src.indexOf('.directive(', m.index + 10);
        const limit = next === -1 ? src.length : next;
        const d = registry.directives[name];
        if (d.controllerName) continue; // uses a named controller -> its scope type
        const members = new Map();
        const ctrlIdx = src.slice(m.index, limit).search(/controller\s*:\s*(?:\/\*\*[\s\S]*?\*\/\s*)?(\[|function)/);
        let ctrlFn = null, linkFn = null;
        if (ctrlIdx !== -1) ctrlFn = findFunctionWithParam(src, m.index + ctrlIdx, '$scope', limit);
        const linkIdx = src.slice(m.index, limit).search(/link\s*:\s*(?:\/\*\*[\s\S]*?\*\/\s*)?function/);
        if (linkIdx !== -1) linkFn = findFunctionWithParam(src, m.index + linkIdx, 'scope', limit) || findFunctionWithParam(src, m.index + linkIdx, '$scope', limit);
        if (ctrlFn) collectMembers(src.slice(ctrlFn.bodyStart, ctrlFn.bodyEnd + 1), '$scope', members);
        if (linkFn) collectMembers(src.slice(linkFn.bodyStart, linkFn.bodyEnd + 1), linkFn.params.includes('scope') ? 'scope' : '$scope', members);
        if (!ctrlFn && !linkFn && !Object.keys(d.members).length && !d.templateUrl) continue;
        const type = directiveScopeType(name);
        const ext = ctrlFn ? mixins(src.slice(ctrlFn.bodyStart, ctrlFn.bodyEnd + 1)) : [];
        interfaces.push(renderInterface(type, members, d.members, `Scope of directive '${name}' (${rel})`, ext));
        if (ctrlFn) edits.push({ index: ctrlFn.fnStart, text: `/** @param {ng.IScope & ${type}} $scope */\n`, type });
        if (linkFn && linkFn.fnStart !== (ctrlFn && ctrlFn.fnStart)) {
            const p = linkFn.params.includes('scope') ? 'scope' : '$scope';
            edits.push({ index: linkFn.fnStart, text: `/** @param {ng.IScope & ${type}} ${p} */\n`, type });
        }
    }

    if (!interfaces.length) return null;
    const dts = file.replace(/\.js$/, '.scope.d.ts');
    const exists = fs.existsSync(dts);
    if (WRITE && (!exists || FORCE)) {
        fs.writeFileSync(dts, `// Generated by checker/gen-scope-types.js — refine by hand, re-run with --force to regenerate.\n\n${interfaces.join('\n\n')}\n`);
    }
    // insert JSDoc (back to front so indices stay valid), skipping functions that already have one
    let inserted = 0;
    for (const e of edits.sort((a, b) => b.index - a.index)) {
        const before = src.slice(Math.max(0, e.index - 200), e.index);
        if (JSDOC_RE.test(before)) continue;
        const lineStart = src.lastIndexOf('\n', e.index) + 1;
        const indent = src.slice(lineStart, e.index).match(/^\s*/)[0];
        const onOwnLine = src.slice(lineStart, e.index).trim() === '';
        const text = onOwnLine ? indent + e.text.trimEnd() + '\n' + indent : e.text.trimEnd() + ' ';
        src = onOwnLine ? src.slice(0, lineStart) + text + src.slice(e.index) : src.slice(0, e.index) + text + src.slice(e.index);
        inserted++;
    }
    if (WRITE && inserted) fs.writeFileSync(file, src);
    return { rel, dts: path.relative(ROOT, dts), interfaces: interfaces.length, inserted, existed: exists };
}

function walk(dir, out = []) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p, out); else if (e.name.endsWith('.js')) out.push(p);
    }
    return out;
}

let files = 0, ifaces = 0, docs = 0, kept = 0;
for (const f of walk(APP).filter(f => f.includes(FILTER))) {
    const r = processFile(f);
    if (!r) continue;
    files++; ifaces += r.interfaces; docs += r.inserted; if (r.existed) kept++;
    if (!WRITE || args.includes('--verbose')) console.log(`${r.rel}: ${r.interfaces} interface(s) -> ${r.dts}${r.existed ? ' (exists, kept)' : ''}, ${r.inserted} JSDoc insert(s)`);
}
console.log(`${WRITE ? 'Wrote' : 'Would write'} ${ifaces} interfaces in ${files} files (${kept} existing kept), ${docs} JSDoc annotations`);
