/**
 * Minimal ambient types for node:sqlite (Node 22) — the tiny synchronous
 * surface this codebase uses. Kept here so the server stays dependency-free
 * without pulling @types/node into the workspace.
 */
declare module 'node:sqlite' {
  export interface StatementSync {
    run(...params: Array<string | number | null>): { changes: number | bigint; lastInsertRowid: number | bigint };
    get(...params: Array<string | number | null>): unknown;
    all(...params: Array<string | number | null>): unknown[];
  }

  export class DatabaseSync {
    constructor(path: string);
    exec(sql: string): void;
    prepare(sql: string): StatementSync;
    close(): void;
  }
}
