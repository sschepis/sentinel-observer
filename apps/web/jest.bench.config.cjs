/** @type {import('jest').Config} */
// The BENCH configuration: the unit config with its ignore list removed, so
// a measurement suite can be selected by path or pattern without the
// `--testPathIgnorePatterns /dev/null/` override (which, combined with a
// positional path, re-selects every suite in this Jest version).
//   npx jest -c jest.bench.config.cjs --testPathPatterns nullArmsBenchmark
const base = require('./jest.config.cjs');
module.exports = { ...base, testPathIgnorePatterns: [] };
