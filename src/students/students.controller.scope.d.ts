// Scope contract for the `Students` controller.
// The controller is checked against it via JSDoc (students.controller.js),
// the template via checker/check-templates.js. One interface, two consumers:
// if either side disagrees with it, you get an error.

/** Scope of controller 'Students' (src/students/students.controller.js) */
interface StudentsScope {
    students: Student[];
    selected: Student | null;
    editing: boolean;
    search: string;
    select(student: Student): void;
    remove(student: Student): void;
    startEditing(): void;
    /** template form (name="editForm"), published on the scope by angular */
    editForm?: ng.IFormController;
}
