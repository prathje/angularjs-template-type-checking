'use strict';
/**
 * AngularJS expression -> TypeScript expression.
 *
 * `angular-expressions` is a standalone port of AngularJS's own $parse, so we
 * get exactly the AST angular would build. We print it back as TypeScript,
 * resolving every free identifier against `$scope` unless it is a template
 * local (ng-repeat item, $index, $event, a form name, ...).
 *
 *   student.frist_name        -> $scope.student.frist_name   (or student.frist_name inside ng-repeat)
 *   students | filter:search  -> $filters.filter($scope.students, $scope.search)
 */
const { Lexer, Parser } = require('angular-expressions');

const OPTS = { literals: { true: true, false: false, null: null, undefined: undefined } };
const parser = new Parser(new Lexer(OPTS), null, OPTS);

/**
 * @param {string} text   the raw expression from the template
 * @param {Set<string>} locals identifiers that are NOT scope members
 * @returns {string[]} one TS expression per statement (`a(); b()` => 2)
 */
function toTs(text, locals) {
    let src = text.trim();
    if (src.startsWith('::')) src = src.slice(2); // one-time binding
    return parser.ast.ast(src).body.map(stmt => print(stmt.expression, locals));
}

function print(n, locals) {
    const p = child => print(child, locals);
    switch (n.type) {
        case 'Literal':
            return n.value === undefined ? 'undefined' : JSON.stringify(n.value);
        case 'Identifier':
            if (locals.has(n.name)) return n.name;
            // prototypal scope inheritance makes $parent unknowable statically
            if (n.name === '$parent') return '($scope.$parent as UntypedScope)';
            return `$scope.${n.name}`;
        case 'ThisExpression':
            return '$scope';
        case 'MemberExpression':
            return n.computed ? `${p(n.object)}[${p(n.property)}]` : `${p(n.object)}.${n.property.name}`;
        case 'CallExpression':
            return `${p(n.callee)}(${n.arguments.map(p).join(', ')})`;
        case 'FilterExpression':
            // `x | name:a:b` -> `$filters.name(x, a, b)`; arguments[0] is the input
            return `$filters.${n.callee.name}(${n.arguments.map(p).join(', ')})`;
        case 'AssignmentExpression':
            return `(${p(n.left)} = ${p(n.right)})`;
        case 'ConditionalExpression':
            // Careful: angular's AST names the branches the other way round than
            // ESTree — `alternate` is the THEN branch, `consequent` the ELSE branch.
            return `(${p(n.test)} ? ${p(n.alternate)} : ${p(n.consequent)})`;
        case 'LogicalExpression':
        case 'BinaryExpression':
            return `(${p(n.left)} ${n.operator} ${p(n.right)})`;
        case 'UnaryExpression':
            return `(${n.operator}${p(n.argument)})`;
        case 'ArrayExpression':
            return `[${n.elements.map(p).join(', ')}]`;
        case 'ObjectExpression':
            return `({${n.properties.map(prop => {
                const key = prop.computed ? `[${p(prop.key)}]`
                    : prop.key.type === 'Identifier' ? prop.key.name : JSON.stringify(prop.key.value);
                return `${key}: ${p(prop.value)}`;
            }).join(', ')}})`;
        default:
            throw new Error(`unsupported AST node ${n.type}`);
    }
}

module.exports = { toTs };
