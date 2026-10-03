// Module boundaries of the repository. Every rule is exercised by scripts/test-guardrails.sh.
/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    {
      name: 'no-circular',
      comment: 'Circular imports hide initialization-order bugs; extract the shared part.',
      severity: 'error',
      from: {},
      to: { circular: true },
    },
    {
      name: 'module-internals-are-private',
      comment:
        'A module under platform/src/<module>/ is imported by other modules only through its ' +
        'index.ts. Export what the caller needs from index.ts instead of reaching into the module.',
      severity: 'error',
      from: { path: '^platform/src/([^/]+)/' },
      to: {
        path: '^platform/src/[^/]+/',
        pathNot: ['^platform/src/$1/', '^platform/src/[^/]+/index\\.ts$'],
      },
    },
    {
      name: 'module-internals-are-private-to-callers',
      comment:
        'Files outside any module (platform/src/*.ts, tests, scripts) also import a module only ' +
        'through its index.ts.',
      severity: 'error',
      from: { path: '^platform/(src/[^/]+\\.ts$|test/|scripts/)' },
      to: { path: '^platform/src/[^/]+/', pathNot: '^platform/src/[^/]+/index\\.ts$' },
    },
    {
      name: 'only-db-touches-sqlite',
      comment: 'SQLite is reached only from platform/src/db/; other modules call the db module.',
      severity: 'error',
      from: { path: '^platform/', pathNot: '^platform/src/db/' },
      to: { path: '(^(node:)?sqlite$|node_modules/(better-sqlite3|sqlite3)/)' },
    },
    {
      name: 'platform-and-plugins-are-separate',
      comment: 'plugins/ run inside user instances; they never share code with the platform.',
      severity: 'error',
      from: { path: '^(platform|plugins)/' },
      to: { path: '^(platform|plugins)/', pathNot: '^$1/' },
    },
  ],
  options: {
    doNotFollow: { path: 'node_modules' },
    exclude: { path: '(^|/)(dist|coverage)/' },
    tsPreCompilationDeps: true,
    tsConfig: { fileName: 'tsconfig.json' },
  },
};
