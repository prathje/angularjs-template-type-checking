// Ambient helpers visible to the generated template code only.

/** What `$parent` resolves to: everything is `any`, nothing below it is checked. */
type UntypedScope = ng.IScope & { [key: string]: any };

/** Filters, as `x | name:a:b` => `$filters.name(x, a, b)`. A typo in a filter name is a compile error. */
interface NgTemplateFilters {
    filter<C>(array: C, expression: any, comparator?: any): NgRepeatItem<C>[];
    orderBy<C>(array: C, expression?: any, reverse?: boolean): NgRepeatItem<C>[];
    limitTo<T>(input: T, limit: number | string, begin?: number | string): T;
    number(value: number | string, fractionSize?: number): string;
    date(value: Date | string | number, format?: string, timezone?: string): string;
    uppercase(value: string): string;
    lowercase(value: string): string;
    json(value: any, spacing?: number): string;
    // custom filters (src/app.js)
    fullName(student: Student): string;
}

/** Element type of whatever ng-repeat iterates: arrays, array-likes, or object values. `any` stays `any`. */
type NgRepeatItem<C> = 0 extends (1 & C) ? any
    : C extends readonly (infer T)[] ? T
    : C extends ArrayLike<infer T> ? T
    : C extends { [key: string]: infer T } ? T
    : any;

declare function __each<C>(collection: C): NgRepeatItem<C>[];
declare function __entries<C>(collection: C): [C extends readonly any[] ? number : string, NgRepeatItem<C>][];
