# AGENTS.md

Instructions for AI coding agents working in this repository. People: see [CONTRIBUTING.md](CONTRIBUTING.md). (Connecting
an agent to the app itself over MCP is another matter: [docs/AGENTS.md](docs/AGENTS.md).)

## The name: a brand, nothing more

The project's public name is **JIBES Studio** (JIBES always in capitals; "Studio" for short in running text). JIBES is
a brand and a public name only.

- Never write anything – in code, comments, docs, commit messages, release notes, issues or the app – that reveals what
  is behind the name: no tools, services, machines, hosts, accounts, workflows or setup used to build or run the project.
- Never add personal information: no people's names (beyond the copyright holder in `LICENSE`, `package.json`'s author
  and the copyright line), no e-mail addresses, private IP addresses, host names, paths from someone's computer, or
  content from anyone's own library (names of characters, sequences, prompts, pictures or films).
- Examples, fixtures and screenshots are made up (`npm run screenshots` uses a fresh, empty library).

## Working rules

- Every feature an agent could use also gets its MCP tools and guide text (`src/main/agent/**`), and its docs:
  `docs/GUIDE.md`, `docs/ARCHITECTURE.md`, `docs/AGENTS.md` and `CHANGELOG.md` under *Unreleased*. The README stays short.
- The version number (`package.json`, a CHANGELOG version section, a `v…` tag) changes only when the maintainer asks.
- Commits follow Conventional Commits with the scopes in [CONTRIBUTING.md](CONTRIBUTING.md); AI help is credited with
  an `Assisted-by:` trailer.
- Paid generations (Venice) never run in tests: stub the API.
- UI copy is English; macOS and Windows wording goes through the platform helpers (`src/main/platform.ts`,
  `src/renderer/src/lib/platform.ts`).
