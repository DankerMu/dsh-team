// Dependabot capitalises its version-update subject (`Bump …`) whatever its
// configured prefix, so such a message skips linting only with both this subject
// shape and Dependabot's signed-off trailer line (#715). Every other message is
// linted unchanged.
const DEPENDABOT_SUBJECT = /^build\((?:deps|deps-dev)\): Bump \S/;
const DEPENDABOT_SIGNOFF = /^Signed-off-by: dependabot\[bot\] <support@github\.com>$/m;

module.exports = {
  extends: ['@commitlint/config-conventional'],
  ignores: [
    (message) =>
      DEPENDABOT_SUBJECT.test(message.split('\n', 1)[0]) && DEPENDABOT_SIGNOFF.test(message),
  ],
  rules: {
    'type-enum': [
      2,
      'always',
      ['feat', 'fix', 'refactor', 'chore', 'docs', 'test', 'ci', 'build', 'perf'],
    ],
    'subject-max-length': [2, 'always', 72],
  },
};
