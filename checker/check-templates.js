#!/usr/bin/env node
'use strict';
/**
 * Side 2 of 2: the templates.
 *
 *   node checker/check-templates.js [--print] [filter]
 *
 * Every Angular expression in src/**\/*.html is rewritten as a TypeScript
 * statement against a typed `$scope`; the generated files are compiled in
 * memory together with the *.scope.d.ts contracts, and each diagnostic is
 * mapped back to `template.html:line`. `--print` dumps the generated code.
 *
 * Which scope type a template gets (first match wins):
 *   1. an explicit `<!-- @scope TypeName -->` comment in the template
 *   2. the directive whose `templateUrl` points at the template, or an object
 *      literal pairing `templateUrl` with `controller: 'X'` (modal, route, state)
 *   3. plain `ng.IScope` (a page) — `ng-controller="X"` inside narrows to XScope
 * Templates pulled in by a literal `ng-include="'path'"` are checked inline,
 * with the includer's scope, not on their own.
 */
const fs = require('fs');
const path = require('path');
const ts = require('typescript');
const { parseDocument } = require('htmlparser2');
const { toTs } = require('./expr');
const { buildRegistry, controllerScopeType } = require('./registry');

const ROOT = path.resolve(__dirname, '..');
const SRC = path.join(ROOT, 'src');
const args = process.argv.slice(2);
const PRINT = args.includes('--print');
const FILTER = args.find(a => !a.startsWith('--')) || '';

const registry = buildRegistry(SRC);

/* attributes whose value is an Angular expression */
const EXPR_ATTRS = new Set([
    'ng-if', 'ng-show', 'ng-hide', 'ng-click', 'ng-dblclick', 'ng-submit', 'ng-change', 'ng-model', 'ng-disabled',
    'ng-readonly', 'ng-checked', 'ng-selected', 'ng-class', 'ng-style', 'ng-bind', 'ng-bind-html', 'ng-value',
    'ng-init', 'ng-blur', 'ng-focus', 'ng-keyup', 'ng-keydown', 'ng-required', 'ng-switch', 'ng-messages',
    'ng-include', 'ng-mouseenter', 'ng-mouseleave',
]);
/*
 * Third-party directives whose attribute values are expressions. Nothing here is
 * used by the demo; add whatever your app uses. An attribute missing from both
 * lists is silently not checked. Examples for angular-ui-bootstrap:
 */
const THIRD_PARTY_EXPR_ATTRS = new Set([
    'uib-collapse', 'uib-datepicker-options', 'uib-typeahead', 'typeahead-on-select', 'is-open', 'uib-tooltip-enable',
]);
/* locals that exist in every template without being scope members */
const TEMPLATE_LOCALS = ['$event'];
const REPEAT_LOCALS = ['$index', '$first', '$last', '$middle', '$even', '$odd'];
const NG_REPEAT_RE = /^\s*(?:([$\w]+)|\(\s*([$\w]+)\s*,\s*([$\w]+)\s*\))\s+in\s+([\s\S]*?)(?:\s+as\s+([$\w]+))?(?:\s+track\s+by\s+([\s\S]+?))?\s*$/;

const norm = name => name.replace(/^(?:data|x)-/, '');
const camel = s => s.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
const lineOf = (src, index) => src.slice(0, index).split('\n').length;
const explicitScope = src => (/<!--\s*@scope\s+([\s\S]+?)\s*-->/.exec(src) || [])[1] || null;

/* ------------------------------------------------------------------ */
/* code generation                                                     */
/* ------------------------------------------------------------------ */

class Gen {
    constructor() { this.lines = []; this.origins = []; this.warnings = []; }
    /** every generated line remembers which template line it came from */
    emit(code, loc) { this.lines.push(code); this.origins.push(loc); }
    expr(text, locals, loc) {
        try {
            for (const stmt of toTs(text, locals)) this.emit(`void (${stmt});`, loc);
        } catch (e) {
            this.warnings.push(`${loc.file}:${loc.line}: cannot parse "${text.trim()}": ${e.message.split('\n')[0]}`);
        }
    }
    /** `{{ }}` inside text or an attribute; pass `at` (src + offset of text) to report each match on its own line */
    interp(text, locals, loc, at) {
        for (const m of text.matchAll(/\{\{([\s\S]*?)\}\}/g)) {
            if (!m[1].trim()) continue;
            this.expr(m[1], locals, at ? { file: loc.file, line: lineOf(at.src, at.offset + m.index) } : loc);
        }
    }
}

function genTemplate(gen, file, src, locals, stack = []) {
    const doc = parseDocument(src, { withStartIndices: true, lowerCaseAttributeNames: true });
    walk({ gen, file, src, stack }, doc.children, locals);
}

function walk(ctx, nodes, locals) {
    for (let i = 0; i < nodes.length; i++) {
        const node = nodes[i];
        const loc = { file: ctx.file, line: lineOf(ctx.src, node.startIndex) };
        if (node.type === 'text') ctx.gen.interp(node.data, locals, loc, { src: ctx.src, offset: node.startIndex });
        else if (node.type === 'script' && node.attribs.type === 'text/ng-template') inlineTemplate(ctx, node, locals);
        else if (node.type === 'tag') i = element(ctx, node, locals, loc, nodes, i);
    }
}

/**
 * `<script type="text/ng-template">` bodies are raw text to htmlparser2; parse them
 * as HTML of their own. They are checked with the scope of the place they are
 * defined, which is where they are usually used (ng-include, uib-* templates).
 */
function inlineTemplate(ctx, script, locals) {
    const start = script.children.length ? script.children[0].startIndex : script.endIndex;
    const body = script.children.map(c => c.data).join('');
    // pad with the original prefix length so every startIndex is valid in ctx.src
    const doc = parseDocument(' '.repeat(start) + body, { withStartIndices: true, lowerCaseAttributeNames: true });
    walk(ctx, doc.children, locals);
}

/** Returns the index of the last sibling it consumed (> i only for ng-repeat-start). */
function element(ctx, el, locals, loc, siblings, i) {
    const { gen } = ctx;
    const attrs = Object.fromEntries(Object.entries(el.attribs).map(([k, v]) => [norm(k), v]));
    let opened = 0;
    const block = head => { gen.emit(`${head} {`, loc); opened++; };

    // ng-repeat: a real for..of loop, so the item gets the element type of the collection
    const repeat = attrs['ng-repeat'] ?? attrs['ng-repeat-start'];
    if (repeat !== undefined) {
        const m = NG_REPEAT_RE.exec(repeat);
        if (!m) gen.warnings.push(`${loc.file}:${loc.line}: cannot parse ng-repeat`);
        else {
            const [, item, key, value, collection, alias, trackBy] = m;
            const coll = toTs(collection, locals)[0];
            locals = new Set([...locals, ...REPEAT_LOCALS]);
            if (item) { locals.add(item); block(`for (const ${item} of __each(${coll}))`); }
            else { locals.add(key); locals.add(value); block(`for (const [${key}, ${value}] of __entries(${coll}))`); }
            gen.emit('const $index = 0, $first = true, $last = true, $middle = false, $even = true, $odd = false;', loc);
            if (alias) { locals.add(alias); gen.emit(`const ${alias} = __each(${coll});`, loc); }
            if (trackBy) gen.expr(trackBy, locals, loc);
        }
    }

    // ng-controller: shadow $scope with the narrower type for everything inside
    const ctrl = /^\s*([\w$]+)(?:\s+as\s+([\w$]+))?\s*$/.exec(attrs['ng-controller'] || '');
    if (ctrl) {
        const [, name, alias] = ctrl;
        if (!registry.controllers[name]) gen.warnings.push(`${loc.file}:${loc.line}: unknown controller "${name}"`);
        block('');
        gen.emit('const __outer = $scope;', loc);
        block('');
        gen.emit(`const $scope: ${controllerScopeType(name)} & typeof __outer = null as any;`, loc);
        // `ng-controller="X as vm"`: the members live on the controller instance, which
        // this PoC types like the scope. Controller-as code should get its own contract.
        if (alias) { locals = new Set([...locals, alias]); gen.emit(`const ${alias} = $scope;`, loc); }
    }

    // <form name="x"> publishes an ng.IFormController named x
    const formName = el.name === 'form' || el.name === 'ng-form' ? attrs.name : attrs['ng-form'];
    if (formName && /^[A-Za-z_$][\w$]*$/.test(formName)) {
        locals = new Set([...locals, formName]);
        block('');
        gen.emit(`const ${formName}: ng.IFormController = null as any;`, loc);
    }

    // `=`, `<` and `&` bindings of the app's own directives are expressions too
    const bindings = {};
    for (const candidate of [el.name, ...Object.keys(attrs)]) {
        Object.assign(bindings, (registry.directives[camel(candidate)] || {}).bindings);
    }

    for (const [name, value] of Object.entries(attrs)) {
        if (['ng-repeat', 'ng-repeat-start', 'ng-controller'].includes(name)) continue;
        if (name === 'ui-sref') uiSref(gen, value, locals, loc);
        else if (value.includes('{{')) gen.interp(value, locals, loc);
        else if (value.trim() && (EXPR_ATTRS.has(name) || THIRD_PARTY_EXPR_ATTRS.has(name)
            || ['=', '<', '&'].includes(bindings[name]))) gen.expr(value, locals, loc);
    }

    // ng-include with a literal path: inline the partial right here, same scope
    const include = /^\s*'([^']+)'\s*$/.exec(attrs['ng-include'] || '');
    if (include) {
        const rel = include[1];
        const abs = path.join(ROOT, rel);
        if (ctx.stack.includes(rel)) gen.warnings.push(`${loc.file}:${loc.line}: recursive ng-include of ${rel}`);
        else if (!fs.existsSync(abs)) gen.warnings.push(`${loc.file}:${loc.line}: ng-include target not found: ${rel}`);
        else {
            const src = fs.readFileSync(abs, 'utf8');
            gen.emit('{', loc);
            if (explicitScope(src)) gen.emit(`const $scope: ${explicitScope(src)} = null as any;`, loc);
            genTemplate(gen, rel, src, locals, [...ctx.stack, rel]);
            gen.emit('}', loc);
        }
    }

    walk(ctx, el.children, locals);

    // ng-repeat-start: the following siblings up to ng-repeat-end are inside the loop
    if (attrs['ng-repeat-start'] !== undefined) {
        while (++i < siblings.length) {
            const s = siblings[i];
            const sLoc = { file: ctx.file, line: lineOf(ctx.src, s.startIndex) };
            if (s.type === 'text') { gen.interp(s.data, locals, sLoc, { src: ctx.src, offset: s.startIndex }); continue; }
            if (s.type !== 'tag') continue;
            element(ctx, s, locals, sLoc, siblings, i);
            if (Object.keys(s.attribs).some(k => norm(k) === 'ng-repeat-end')) break;
        }
    }

    for (let n = 0; n < opened; n++) gen.emit('}', loc);
    return i;
}

/** ui-router: `ui-sref="state.name({ id: item.id })"` — the state name is not checked, the params are. */
function uiSref(gen, value, locals, loc) {
    const m = /^\s*[\w.^]+\s*\(([\s\S]*)\)\s*$/.exec(value);
    if (m && m[1].trim()) gen.expr(m[1], locals, loc);
}

/* ------------------------------------------------------------------ */
/* driver                                                              */
/* ------------------------------------------------------------------ */

function htmlFiles(dir) {
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => {
        const p = path.join(dir, e.name);
        return e.isDirectory() ? htmlFiles(p) : e.name.endsWith('.html') ? [path.relative(ROOT, p)] : [];
    });
}

function main() {
    const templates = htmlFiles(SRC);
    const included = new Set(templates.flatMap(rel =>
        [...fs.readFileSync(path.join(ROOT, rel), 'utf8').matchAll(/ng-include="\s*'([^']+)'\s*"/g)].map(m => path.normalize(m[1]))));

    const virtual = {};   // generated file name -> source
    const origins = {};   // generated file name -> [template location per line]
    const warnings = [];
    for (const rel of templates.filter(t => t.includes(FILTER))) {
        const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
        const type = explicitScope(src) || registry.templateScopes[rel];
        if (!type && included.has(rel)) continue; // checked inline by its includer
        const gen = new Gen();
        const top = { file: rel, line: 1 };
        gen.emit('export {};', top);
        gen.emit('declare const $filters: NgTemplateFilters;', top);
        gen.emit('declare const $event: Event;', top);
        gen.emit(`declare const $scope: ng.IScope${type ? ` & ${type}` : ''};`, top);
        gen.emit('function __template() {', top);
        genTemplate(gen, rel, src, new Set(TEMPLATE_LOCALS), [rel]);
        gen.emit('}', top);
        const name = path.join(ROOT, '.generated', rel.replace(/\.html$/, '.ts'));
        virtual[name] = gen.lines.join('\n');
        origins[name] = gen.origins;
        warnings.push(...gen.warnings);
        if (PRINT) console.log(`// ---- ${rel} (scope: ${type || 'ng.IScope'})\n${virtual[name]}\n`);
    }

    // compile the generated files in memory, together with every contract (*.d.ts)
    const options = {
        noEmit: true, strict: false, skipLibCheck: true, target: ts.ScriptTarget.ES2017,
        lib: ['lib.es2017.d.ts', 'lib.dom.d.ts'], types: ['angular'], typeRoots: [path.join(ROOT, 'node_modules/@types')],
    };
    const dts = [path.join(__dirname, 'runtime.d.ts'), ...ts.sys.readDirectory(SRC, ['.d.ts'])];
    const host = ts.createCompilerHost(options);
    const readFile = host.readFile.bind(host);
    host.readFile = f => virtual[f] ?? readFile(f);
    host.fileExists = f => f in virtual || ts.sys.fileExists(f);
    const getSourceFile = host.getSourceFile.bind(host);
    host.getSourceFile = (f, lang) => f in virtual ? ts.createSourceFile(f, virtual[f], lang) : getSourceFile(f, lang);
    const program = ts.createProgram([...dts, ...Object.keys(virtual)], options, host);

    let errors = 0;
    for (const d of ts.getPreEmitDiagnostics(program)) {
        const message = ts.flattenDiagnosticMessageText(d.messageText, '\n    ');
        if (!d.file || !(d.file.fileName in virtual)) { console.log(`TS${d.code} ${message}`); errors++; continue; }
        const { line } = d.file.getLineAndCharacterOfPosition(d.start);
        const origin = origins[d.file.fileName][line];
        const generated = virtual[d.file.fileName].split('\n')[line].trim();
        console.log(`${origin.file}:${origin.line}  TS${d.code} ${message}\n    ${generated}`);
        errors++;
    }
    for (const w of warnings) console.log(`warning: ${w}`);
    console.log(`\n${Object.keys(virtual).length} templates checked: ${errors} errors, ${warnings.length} warnings`);
    process.exitCode = errors ? 1 : 0;
}

main();
