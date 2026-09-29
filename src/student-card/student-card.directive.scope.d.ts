/** Scope of directive 'studentCard' (src/student-card/student-card.directive.js) */
interface StudentCardDirectiveScope {
    /** `<` binding */
    student: Student;
    /** `&` binding; the caller's expression, e.g. on-edit="startEditing()" */
    onEdit(locals?: object): void;
    /** `@` binding: arrives as a string attribute */
    title: string;
    age(): number;
}
