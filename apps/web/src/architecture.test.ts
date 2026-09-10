/**
 * @jest-environment node
 *
 * THE BROWSER DOES NOT CARRY THE MODEL.
 *
 * The observer runs in a server process. The page is for visualisation and
 * control: it sends turns, renders the server's state, and computes nothing
 * of the model's own. That is an architectural commitment, and until this
 * test it was only ever a comment at the top of App.tsx — so it drifted.
 *
 * Measured the day this test was written, by walking the runtime import
 * graph from `src/main.tsx`:
 *
 *   BEFORE   109 modules · 91 of them under teacher/ · 11 of them
 *            runtime-importing the cognitive core
 *   AFTER     18 modules ·  1 of them under teacher/ ·  0 importing the core
 *
 * The whole apparatus was in the page bundle — TeacherAgent and every agent
 * mixin, the rewrite engine (Peano, digits, rationals, the story engine),
 * the 20,000-word decks, network entropy, FSRS, the drive vector,
 * conceptSynthesis — pulled in by exactly TWO import lines: a chaperone
 * provider in the chat hook, and one numeric threshold read out of
 * `teacher/conversation` for a label. Nothing ran it, and it was still
 * wrong: shipped, loaded, instantiable, and the reason `main.tsx` needed a
 * Buffer shim for a crypto backend a browser has no business loading.
 *
 * TYPES ARE FREE. `import type` is erased before the bundle exists, so the
 * client may name the model's shapes as much as it likes. This test walks
 * VALUE imports only — the ones that put code in the page.
 */
import { describe, it, expect } from '@jest/globals';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, normalize, relative } from 'node:path';

const ROOT = join(__dirname, '..');
const ENTRY = 'src/main.tsx';

/** The cognitive core: the one import that must never reach the browser. */
const CORE = '@sschepis/sentient-core';

/**
 * Modules under `teacher/` the page is allowed to load, with the reason.
 * Anything else appearing here means the model is leaking into the page
 * again — move the value the client needs to a leaf (see
 * `learning/thresholds.ts`) or put it behind a server endpoint.
 */
const ALLOWED_TEACHER_MODULES = new Map<string, string>([
  ['src/teacher/conversations.ts', 'chat transcripts in localStorage — UX state, no model in it']
]);

/** `import ... from '<spec>'` and side-effect `import '<spec>'`. */
const FROM_IMPORT = /^\s*import\s+(type\s+)?([^;]*?)\s*from\s*['"]([^'"]+)['"]\s*;/gm;
const BARE_IMPORT = /^\s*import\s*['"]([^'"]+)['"]\s*;/gm;

/** The VALUE imports of one file: specs whose code lands in the bundle. */
function valueImports(file: string): string[] {
  const source = readFileSync(join(ROOT, file), 'utf8');
  const specs: string[] = [];
  for (const match of source.matchAll(FROM_IMPORT)) {
    const typeKeyword = match[1] !== undefined;
    const clause = match[2];
    // `import { type A, type B } from …` is also erased entirely.
    const allNamesAreTypes =
      clause.trim().startsWith('{') &&
      clause
        .trim()
        .replace(/^\{|\}$/g, '')
        .split(',')
        .map((name) => name.trim())
        .filter((name) => name.length > 0)
        .every((name) => name.startsWith('type '));
    if (typeKeyword || allNamesAreTypes) continue;
    specs.push(match[3]);
  }
  for (const match of source.matchAll(BARE_IMPORT)) specs.push(match[1]);
  return specs;
}

/** Resolve a relative spec the way the bundler would. */
function resolveSpec(fromFile: string, spec: string): string | null {
  if (!spec.startsWith('.')) return null;
  const base = normalize(join(dirname(fromFile), spec));
  const candidates = [`${base}.ts`, `${base}.tsx`, join(base, 'index.ts'), join(base, 'index.tsx'), base];
  for (const candidate of candidates) {
    const absolute = join(ROOT, candidate);
    if (existsSync(absolute) && statSync(absolute).isFile()) return relative(ROOT, absolute).split('\\').join('/');
  }
  return null;
}

/** Every module the page loads at runtime, and who pulls in the core. */
function walkClientGraph(): { modules: Set<string>; coreImporters: string[]; paths: Map<string, string> } {
  const modules = new Set<string>();
  const coreImporters: string[] = [];
  /** How each module got in, for a failure message that names the edge. */
  const paths = new Map<string, string>([[ENTRY, ENTRY]]);
  const stack = [ENTRY];
  while (stack.length > 0) {
    const current = stack.pop() as string;
    if (modules.has(current)) continue;
    modules.add(current);
    for (const spec of valueImports(current)) {
      if (spec === CORE) {
        coreImporters.push(current);
        continue;
      }
      const next = resolveSpec(current, spec);
      if (next === null) continue;
      if (!paths.has(next)) paths.set(next, `${paths.get(current) ?? current} → ${next}`);
      stack.push(next);
    }
  }
  return { modules, coreImporters, paths };
}

describe('the page carries no model', () => {
  const graph = walkClientGraph();

  it('nothing the browser loads imports the cognitive core', () => {
    // 11 modules did, through TeacherAgent, before the chat hook stopped
    // building a chaperone provider.
    expect(graph.coreImporters.map((file) => `${file} (via ${graph.paths.get(file) ?? file})`)).toEqual([]);
  });

  it('nothing under teacher/ reaches the page except the allowed leaves', () => {
    const leaked = [...graph.modules]
      .filter((file) => file.startsWith('src/teacher/'))
      .filter((file) => !ALLOWED_TEACHER_MODULES.has(file))
      .map((file) => `${file} (via ${graph.paths.get(file) ?? file})`);
    expect(leaked).toEqual([]);
  });

  it('the graph stays small — a page that grows a hundred modules is carrying something', () => {
    // 18 the day this was written. The ceiling is a smoke alarm, not a
    // budget: raise it deliberately, and only for UI.
    expect(graph.modules.size).toBeLessThan(40);
  });

  it('and the model side imports no components — the arrow points one way', () => {
    // ServerSession used to import `ruleStoreSnapshot` from
    // components/RulesPanel.tsx and the definitions progress shape from
    // components/ChaperoneProgress.tsx: a process with no DOM reaching into
    // the browser's half of the tree for its own state. A shape two sides
    // share belongs to neither (see learning/definitionsProgress.ts).
    const offenders = ['src/server/ServerSession.ts', 'src/server/definitionsRunner.ts', 'src/server/http.ts', 'src/server/main.ts', 'src/server/trainingLoop.ts']
      .filter((file) => existsSync(join(ROOT, file)))
      .filter((file) => /from '\.\.\/components\//.test(readFileSync(join(ROOT, file), 'utf8')));
    expect(offenders).toEqual([]);
  });
});
