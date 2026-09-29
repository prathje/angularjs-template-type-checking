# angularjs-template-type-checking

Type-check a legacy AngularJS 1.x app, including its HTML templates, with the
TypeScript compiler. This is a proof of concept.

> [!WARNING]
> **This code is vibe coded.** It was written largely with AI coding agents and
> reviewed only as far as this demo needs. It is a proof of concept, not a
> maintained library. Treat it as a starting point: **read and review every line
> carefully before adopting any of it in production**, and test it against your
> own codebase. The checker is deliberately pragmatic, not sound: it has known
> blind spots (listed below) and certainly some unknown ones. A green run means
> "no mismatches found", not "no mismatches".

It type-checks **both halves** of an AngularJS 1.x app with the TypeScript
compiler, without changing any runtime code and without a build step:

| Side          | How                                                                   | Command                         |
|---------------|-----------------------------------------------------------------------|---------------------------------|
| JavaScript    | `tsc --noEmit` with `allowJs` + `checkJs`, `$scope` typed via JSDoc   | `npm run type-check`            |
| HTML templates| every Angular expression rewritten as TypeScript, then compiled       | `npm run type-check:templates`  |

Both sides are checked against the same **scope contract**, a `*.scope.d.ts`
interface next to each controller or directive. `npm run gen-scope-types`
generates skeletons of these contracts from existing code.

```
poc/
├── index.html                          # runnable app (angular from cdnjs), `npm run serve`
├── tsconfig.json                       # side 1: checkJs over src/
├── .github/workflows/type-check.yml    # both checks as blocking CI jobs
├── checker/
│   ├── check-templates.js              # side 2: template -> TS -> in-memory tsc -> template:line
│   ├── gen-scope-types.js              # writes skeleton *.scope.d.ts + JSDoc for existing code
│   ├── expr.js                         # AngularJS expression AST -> TypeScript expression
│   ├── registry.js                     # finds controllers, directives, bindings, templateUrls
│   └── runtime.d.ts                    # filters ($filters.name(...)) and ng-repeat helpers
└── src/
    ├── app.js                          # module + a custom `fullName` filter
    ├── types/entities.d.ts             # API payload shapes (Student)
    ├── students/
    │   ├── students.controller.js      # /** @param {ng.IScope & StudentsScope} $scope */
    │   ├── students.controller.scope.d.ts   # interface StudentsScope
    │   └── students.html               # page template, ng-controller="Students"
    └── student-card/
        ├── student-card.directive.js   # isolate scope { student: '<', onEdit: '&', title: '@' }
        ├── student-card.directive.scope.d.ts  # interface StudentCardDirectiveScope
        └── student-card.html           # directive template, found through templateUrl
```

## Run it

```bash
npm install
npm run check
```

The sources contain seven deliberately planted bugs, each marked with a
`BUG:` comment. All of them are "valid" AngularJS: the app loads, nothing
throws, and the broken parts just quietly do nothing. The expected output:

```
src/students/students.controller.js(26,13): error TS2322: Type 'string' is not assignable to type 'boolean'.

src/student-card/student-card.html:6  TS2339 Property 'adress' does not exist on type 'string'.
    void ($scope.student.email.adress);
src/student-card/student-card.html:8  TS2339 Property 'select' does not exist on type 'IScope & StudentCardDirectiveScope'.
    void ($scope.select($scope.student));
src/students/students.html:10  TS2551 Property 'frist_name' does not exist on type 'Student'. Did you mean 'first_name'?
    void (student.frist_name);
src/students/students.html:12  TS2551 Property 'numbr' does not exist on type 'NgTemplateFilters'. Did you mean 'number'?
    void ($filters.numbr(student.lessons_taken));
src/students/students.html:15  TS2554 Expected 1 arguments, but got 2.
    void ($scope.remove(student, $index));
src/students/students.html:20  TS2551 Property 'isEditing' does not exist on type 'StudentsScope & IScope'. Did you mean 'editing'?
    void (($scope.selected && (!$scope.isEditing)));

2 templates checked: 6 errors, 0 warnings
```

Fix the seven lines and both commands exit 0.

To see the TypeScript generated for a template:

```bash
node checker/check-templates.js --print student-card
```

```ts
declare const $scope: ng.IScope & StudentCardDirectiveScope;
function __template() {
void (($scope.title || $filters.fullName($scope.student)));
void ($scope.age());
void ($scope.student.email);
void ($scope.student.email.adress);
void ($scope.select($scope.student));
void ($scope.onEdit());
}
```

## CI

`.github/workflows/type-check.yml` runs both checks as blocking jobs on every
push and pull request. Both commands exit 1 on any error, so they work as a gate
in any CI system. As shipped, with the planted bugs, both jobs fail on purpose.

GitLab CI equivalent:

```yaml
type_check:
    image: node:20
    needs: []
    script:
        - npm ci
        - npm run type-check
        - npm run type-check:templates
```

The workflow only runs if this folder is the root of its own repository; GitHub
doesn't read `.github/` from a subdirectory.

## Adopting it on an existing codebase

Nobody writes hundreds of scope interfaces from scratch. The generator scans
every `module.controller(...)` and `module.directive(...)` for `$scope.x` /
`scope.x` references and infers a loose type from the first assignment
(function arity, boolean, number, string, array, otherwise `any`):

```bash
npm run gen-scope-types                   # dry run: what would be written
npm run gen-scope-types -- --write        # write <file>.scope.d.ts + insert the JSDoc @param
npm run gen-scope-types -- --write --force students   # regenerate existing files matching "students"
```

Existing `*.scope.d.ts` files are kept unless you pass `--force`, so your hand
refinements survive re-runs. Other things it handles:

- **Isolate bindings** become members, and `&` bindings become `(locals?: object) => any`.
- **Mixins**: `$controller('Base', { $scope: $scope })` becomes `extends BaseScope`.
- **Members that are read but never assigned** are optional and get a comment:
  they come from a parent scope or from the template (e.g. a form name).

Skeletons are deliberately loose, but they already pay off. Delete both
contracts in this repo, regenerate them, and the checker still finds 4 of the 7
bugs: the unknown member `select`, the `numbr` filter, the extra argument to
`remove`, and `isEditing`. The other three need the types you add by hand:
`Student` for `frist_name` and `email.adress`, and `boolean` for `editing`.
Refine the interfaces one at a time, fix what the checker then reports, and
gate CI on it once it is green.

## What the template checker understands

- Every `{{ }}` in text and attributes, the built-in `ng-*` expression
  attributes, and the `=`, `<`, `&` attributes of the app's own directives.
- `ng-repeat` / `ng-repeat-start` … `ng-repeat-end`, with `$index` & co.,
  `(key, value) in`, `as alias`, `track by`, filters in the collection.
- `ng-controller="X"` and `ng-controller="X as vm"` (narrows `$scope` for the subtree).
- `<form name="f">` / `ng-form`, which publish an `ng.IFormController` named `f`.
- `ng-include="'literal/path.html'"` (checked inline, with the includer's scope)
  and `<script type="text/ng-template">` bodies.
- `ui-sref="state({ id: item.id })"`: the params object (not the state name).
- `$parent`, deliberately typed as `any` (see below).
- Filters, as `$filters.name(input, args…)` typed in `checker/runtime.d.ts`.
  Add your custom filters there.

Which scope type a template is checked against:

1. an explicit `<!-- @scope TypeName -->` comment in the template,
2. a directive whose `templateUrl` points at it,
3. any other object literal pairing `templateUrl` with `controller: 'Name'`:
   `$uibModal.open({...})`, `$routeProvider.when(url, {...})`, ui-router states,
4. otherwise plain `ng.IScope`, narrowed by `ng-controller` inside the template.

Not handled, to add for your app when needed:

- **Third-party expression attributes.** Only the attributes in `EXPR_ATTRS`,
  `THIRD_PARTY_EXPR_ATTRS` (in `checker/check-templates.js`) and the app's own
  directive bindings are checked. Any other attribute is ignored silently. Go
  through the libraries you use and extend the list.
- **Templates loaded dynamically** (`ng-include="someVariable"`, templates
  assembled at runtime) are checked on their own against plain `ng.IScope`,
  which reports every member access as an error. Give them a `<!-- @scope Type -->`
  comment, or add a rule to the scope resolution that matches your project's
  conventions (for example "a template below a directive's folder shares its scope").
- **Components** (`module.component(...)`, `$ctrl`) and controller-as contracts.
  `X as vm` reuses the scope contract for `vm`; code that puts members on
  `this` needs its own interface.

## Known blind spots

- **`ng.IFormController` has a string index signature**, so `form.field.$invald`
  is `any` and passes. Form *names* are checked, whatever comes after them isn't.
- **`@` bindings are plain strings**, so a wrong literal like `data-form="wrongName"`
  is invisible to the checker.
- **`$parent`** is deliberately untyped: prototypal scope inheritance is not
  statically knowable. Read inherited members directly instead, so they stay checked.
- **An error inside an `ng-repeat` collection makes the item `any`**, which can
  hide further errors in the loop body until you fix the first one.
- **Types can lie.** A contract is only as good as its author. If `Student`
  is modelled on the server's entity class and not on what the API really
  serializes, the checker will confidently "fix" your template the wrong way.

## License

[MIT](LICENSE). Provided as is, without warranty; see the disclaimer at the top.
