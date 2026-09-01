#!/usr/bin/env node
/**
 * Make the ESM build importable by Node (and node-based tools like tsx/jest):
 *
 * `dist/esm/*.js` uses extensionless relative specifiers ("'./semantic'")
 * which bundlers accept but Node ESM rejects. When the build emits ESM, mark
 * the tree `type: module` and rewrite relative import/export specifiers to
 * `.js` in place.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const dir = path.join(__dirname, '..', 'dist', 'esm');
if (!fs.existsSync(dir)) {
  console.error('no dist/esm — run `npm run build` first');
  process.exit(1);
}

fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ type: 'module' }));
console.log('[build] dist/esm marked type=module');

const EXT = /\.(?:js|json|cjs|mjs)$/;

/**
 * Resolve a relative specifier the way Node ESM would: prefer `<spec>.js`,
 * then `<spec>/index.js` for directory specifiers.
 */
function resolveSpec(fromFile, spec) {
  const base = path.join(path.dirname(fromFile), spec);
  if (fs.existsSync(base + '.js')) return spec + '.js';
  if (fs.existsSync(path.join(base, 'index.js'))) return spec + '/index.js';
  return spec;
}

function rewrite(file) {
  const src = fs.readFileSync(file, 'utf8');
  const out = src.replace(
    /(?:from\s*['"]|^import\s*['"]|import\(['"])(\.[^'"]+)(['"])/gm,
    (match, spec, quote) => {
      if (EXT.test(spec)) return match;
      const resolved = resolveSpec(file, spec);
      return resolved === spec ? match : match.replace(spec, resolved);
    }
  );
  if (out !== src) {
    fs.writeFileSync(file, out);
    console.log(`[build] fixed ${path.relative(dir, file)}`);
  }
}

function walk(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) walk(full);
    else if (entry.name.endsWith('.js')) rewrite(full);
  }
}

walk(dir);
console.log('[build] rewrote relative specifiers with .js extensions');