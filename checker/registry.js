'use strict';
/**
 * Scans the JS sources with regexes (good enough for conventional AngularJS
 * code, no bundler or AST needed) and collects:
 *
 *   controllers:    'Students'    -> 'StudentsScope'
 *   directives:     'studentCard' -> { bindings: { student: '<', 'on-edit': '&', title: '@' }, ... }
 *   templateScopes: 'src/student-card/student-card.html' -> 'StudentCardDirectiveScope'
 *
 * A template gets a scope type from `templateUrl` + scope/controller in:
 *   - a directive definition            (-> <Name>DirectiveScope, or <Ctrl>Scope for `controller: 'Ctrl'`)
 *   - any other object literal that pairs `templateUrl` with `controller: 'Name'`:
 *     `$uibModal.open({...})`, `$routeProvider.when(url, {...})`, ui-router states
 *
 * Naming convention = the contract between the JS and the .scope.d.ts files:
 *   controller Foo    -> interface FooScope
 *   directive  fooBar -> interface FooBarDirectiveScope
 */
const fs = require('fs');
const path = require('path');

const pascal = s => s[0].toUpperCase() + s.slice(1);
const kebab = s => s.replace(/[A-Z]/g, c => '-' + c.toLowerCase());
const controllerScopeType = name => pascal(name) + 'Scope';
const directiveScopeType = name => pascal(name) + 'DirectiveScope';

function jsFiles(dir) {
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => {
        const p = path.join(dir, e.name);
        return e.isDirectory() ? jsFiles(p) : e.name.endsWith('.js') ? [p] : [];
    });
}

/**
 * `{ a: '<', onB: '&', c: '@?alias' }` ->
 *   bindings: { 'a': '<', 'on-b': '&', 'alias': '@' }   keyed by HTML attribute (what templates use)
 *   members:  { a: '<', onB: '&', c: '@' }              keyed by scope member (what the JS uses)
 */
function parseBindings(obj) {
    const bindings = {}, members = {};
    const re = /([A-Za-z_$][\w$]*)\s*:\s*['"]([=<@&])\??([A-Za-z_$][\w$]*)?['"]/g;
    let m;
    while ((m = re.exec(obj))) {
        bindings[kebab(m[3] || m[1])] = m[2];
        members[m[1]] = m[2];
    }
    return { bindings, members };
}

function buildRegistry(srcDir) {
    const files = jsFiles(srcDir).map(file => ({ file, src: fs.readFileSync(file, 'utf8') }));
    const controllers = {}, directives = {}, templateScopes = {};

    for (const { src } of files) {
        let m;
        const cre = /\.controller\(\s*['"]([\w$]+)['"]/g;
        while ((m = cre.exec(src))) controllers[m[1]] = controllerScopeType(m[1]);

        const dre = /\.directive\(\s*['"]([\w$]+)['"]/g;
        while ((m = dre.exec(src))) {
            const name = m[1];
            const next = src.indexOf('.directive(', m.index + 1);
            let body = src.slice(m.index, next === -1 ? undefined : next);
            // a `$uibModal.open({ templateUrl, controller })` inside the directive's
            // functions belongs to the modal, not to the directive definition
            const modal = body.search(/\$uibModal\s*\.\s*open/);
            if (modal !== -1) body = body.slice(0, modal);
            const scope = /scope\s*:\s*\{([\s\S]*?)\}/.exec(body);
            const tpl = /templateUrl\s*:\s*['"]([^'"]+)['"]/.exec(body);
            const ctrl = /controller\s*:\s*['"]([\w$]+)['"]/.exec(body);
            const type = ctrl ? controllerScopeType(ctrl[1]) : directiveScopeType(name);
            const { bindings, members } = scope ? parseBindings(scope[1]) : { bindings: {}, members: {} };
            directives[name] = { bindings, members, type, controllerName: ctrl ? ctrl[1] : null, templateUrl: tpl ? tpl[1] : null };
            if (tpl) templateScopes[path.normalize(tpl[1])] = type;
        }
    }

    // modals, routes, states: `templateUrl` next to `controller: 'Name'` in the same object literal
    for (const { src } of files) {
        const re = /templateUrl\s*:\s*['"]([^'"]+)['"]/g;
        let m;
        while ((m = re.exec(src))) {
            const rel = path.normalize(m[1]);
            if (templateScopes[rel]) continue;
            const literal = enclosingObject(src, m.index);
            const ctrl = literal && /controller\s*:\s*['"]([\w$]+)['"]/.exec(literal);
            if (ctrl && controllers[ctrl[1]]) templateScopes[rel] = controllers[ctrl[1]];
        }
    }
    return { controllers, directives, templateScopes };
}

/** The text of the innermost `{ ... }` around `index` (naive brace matching, ignores strings). */
function enclosingObject(src, index) {
    let depth = 0, start = -1;
    for (let i = index; i >= 0; i--) {
        if (src[i] === '}') depth++;
        else if (src[i] === '{') { if (depth === 0) { start = i; break; } depth--; }
    }
    if (start === -1) return null;
    depth = 0;
    for (let i = start; i < src.length; i++) {
        if (src[i] === '{') depth++;
        else if (src[i] === '}' && --depth === 0) return src.slice(start, i + 1);
    }
    return null;
}

module.exports = { buildRegistry, controllerScopeType, directiveScopeType };
