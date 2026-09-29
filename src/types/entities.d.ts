// Shapes of what the API actually sends (the serialized payload, not the
// server-side entity class — those two drift apart more often than you think).
// Global interfaces: no import/export, so both the JS and the generated
// template code can see them without module plumbing.

interface Student {
    id: number;
    first_name: string;
    last_name: string;
    email: string | null;
    /** ISO date string */
    birthdate: string;
    lessons_taken: number;
}
