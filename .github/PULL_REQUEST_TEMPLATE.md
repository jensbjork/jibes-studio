<!--
Thanks for contributing to Studio! Please read CONTRIBUTING.md first.
Pull requests are squash-merged, so the title becomes the commit message on
main. Write it as a Conventional Commit, for example:
  feat(sequences): continue from the trimmed last frame
-->

## Summary

<!-- What does this pull request change? Keep it short; link the issue it closes. -->

Closes #

## Why

<!-- The problem this solves or the use case it enables. -->

## How it was tested

<!--
What you ran and clicked, on which macOS version. Mention whether the change
triggered paid Venice generations (and roughly what they cost) or was tested
without them. Add screenshots or a short recording for UI changes.
-->

## Checklist

- [ ] The title follows [Conventional Commits](https://www.conventionalcommits.org/) with a type and scope from CONTRIBUTING.md.
- [ ] `npm run check` (typecheck + build) passes.
- [ ] Tested in the dev profile (`npm run dev`, "Studio Dev"), not against a real library.
- [ ] Database changes are a new migration appended in `src/main/db.ts`; existing libraries still open.
- [ ] Every new path that spends Venice credits runs the same `@ImageN` / `@AudioN` check, and agent requests still need approval in the app.
- [ ] New user-facing capabilities have matching agent tools and guide text in `src/main/agent/` (and docs/AGENTS.md).
- [ ] Changes to the MCP server or agent tools keep it bound to `127.0.0.1` and the Tailscale interface, behind the bearer token.
- [ ] UI text is in English (short, plain, sentence case for buttons and headings); code comments and docs are in English too.
- [ ] README, `docs/` and `CHANGELOG.md` (*Unreleased*) are updated if behaviour, settings or agent tools changed.
- [ ] No API keys, tokens, personal names, personal paths or private library content in code, screenshots or logs.
- [ ] If an AI tool helped: the commits carry an `Assisted-by:` trailer (not `Co-authored-by:`) and the summary says so.
