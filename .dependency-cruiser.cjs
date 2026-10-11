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
    {
      name: 'browser-sources-are-isolated',
      comment: 'Browser code cannot bundle backend, test, plugin or server-library code.',
      severity: 'error',
      from: { path: '^platform/web/src/' },
      to: {
        path: '^platform/(src|test|scripts)/|^plugins/|node_modules/(fastify|@fastify|better-sqlite3)/',
      },
    },
    {
      name: 'browser-sources-have-no-node-builtins',
      comment: 'The browser has no Node runtime or privileged filesystem/process boundary.',
      severity: 'error',
      from: { path: '^platform/web/src/' },
      to: { dependencyTypes: ['core'] },
    },
    {
      name: 'backend-does-not-import-browser',
      comment: 'The backend serves built artifacts, never imports client source.',
      severity: 'error',
      from: { path: '^platform/src/' },
      to: { path: '^platform/web/src/' },
    },
  ],
  options: {
    doNotFollow: { path: 'node_modules' },
    exclude: { path: '(^|/)(dist|coverage)/' },
    tsPreCompilationDeps: true,
    tsConfig: { fileName: 'tsconfig.json' },
  },
};
