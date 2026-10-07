// Commit message rules (Conventional Commits). See CONTRIBUTING.md and .gitmessage.
//
// commitlint is deliberately not a project dependency: CI installs it on the fly
// (.github/workflows/ci.yml). To check your own commits before opening a pull request:
//
//   npm install --global @commitlint/cli@19 @commitlint/config-conventional@19
//   commitlint --from origin/main --to HEAD --verbose
//
// A global install is needed because commitlint resolves the shared config below from
// the project folder or from the global npm folder, not from the npx cache.

/** Keep these lists in sync with CONTRIBUTING.md and .gitmessage. */
const types = ['feat', 'fix', 'docs', 'refactor', 'perf', 'test', 'build', 'ci', 'chore', 'revert']

const scopes = [
  'generate',
  'prompt',
  'library',
  'assets',
  'sequences',
  'images',
  'export',
  'agent',
  'mcp',
  'db',
  'ui',
  'settings',
  'build',
  'deps',
  'docs'
]

// Rule levels: 0 = off, 1 = warning, 2 = error.
/** @type {import('@commitlint/types').UserConfig} */
export default {
  extends: ['@commitlint/config-conventional'],
  rules: {
    'type-enum': [2, 'always', types],
    // An unknown scope only warns, so a new area of the app never blocks a pull request.
    'scope-enum': [1, 'always', scopes],
    // Long URLs and pasted output in the body or footer only warn.
    'body-max-line-length': [1, 'always', 100],
    'footer-max-line-length': [1, 'always', 100]
  },
  // Dependabot writes its own commit bodies (release notes with long lines).
  ignores: [(message) => message.includes('Signed-off-by: dependabot[bot]')]
}
