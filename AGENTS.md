# AGENTS.md

## Project

This repository contains the Minutes transcription application.

Official repository:

OMU-Innovation-Frontier/minutes-transcription-app

Use the repository currently opened in Codex.
Do not copy the project into another directory unless explicitly instructed.

## General working rules

- Read this file before making changes.
- Inspect the existing implementation before designing a replacement.
- Prefer small, reviewable changes.
- Preserve the existing architecture and provider boundaries.
- Reuse existing utilities and abstractions where practical.
- Do not perform unrelated refactoring.
- Do not weaken tests to make them pass.
- Do not claim that a test or browser check was performed when it was not.
- Stop and report when the requested task requires a major redesign outside its stated scope.

## Git rules

- Never modify or commit directly on `main`.
- Create one feature branch for one feature or pull request.
- The official push destination is `origin`.
- Never treat `personal` as the official push destination.
- Never push to `personal`.
- Never use force push or force-with-lease.
- Never rewrite published history.
- Do not run `reset`, `rebase`, `clean`, `restore`, or `stash` unless explicitly instructed.
- Do not delete branches or tags unless explicitly instructed.
- Stop before changing anything when the working tree contains unexpected modifications.
- Do not stage, commit, push, create a pull request, or merge unless the current instruction explicitly permits that operation.
- When staging is permitted, stage expected files by explicit path.
- Do not use `git add .`, `git add -A`, or `git add --all`.

## Commit identity

Use the configured GitHub noreply identity.

Expected email:

235236025+Aoi1173@users.noreply.github.com

Stop before committing when the configured author or committer identity is different.

## Dependencies

- Use the existing package manager and lockfile.
- Use `pnpm.cmd` on Windows where appropriate.
- Do not add or upgrade dependencies unless explicitly approved.
- Do not modify `package.json` or `pnpm-lock.yaml` for a task that does not require dependency changes.
- Prefer Node.js standard APIs and existing dependencies.

## Required validation

After implementation, run the available project checks:

- `pnpm.cmd run typecheck`
- `pnpm.cmd run lint`
- `pnpm.cmd test`
- `pnpm.cmd run build`
- `git diff --check`

Run focused tests while implementing, followed by the full suite.

Report the actual number of test files and tests.
Do not rely on an old expected test count when the suite has changed.

Do not add:

- focused tests
- skipped tests
- artificial sleeps
- enlarged timeouts used only to hide races
- production branches that detect the test environment

## Secrets and configuration

- Never commit `.env`.
- Never display or report secret values.
- Never include API keys, authorization headers, workspace IDs, tokens, or credentials in source code, tests, logs, snapshots, URLs, or documentation examples.
- Server-only credentials must never use a `VITE_` prefix.
- Do not expose server credentials to browser code.
- Use empty placeholders only in `.env.example`.
- Do not create accounts, API keys, billing methods, payment settings, or external service resources.

## External services

- External services are opt-in.
- Do not make real external API calls during normal tests.
- Inject or fake network clients in unit and integration tests.
- Do not consume free quotas during ordinary validation.
- Only run a live external test when:
  - the required credential is already configured by the user;
  - the user explicitly authorized the live test;
  - the test uses non-sensitive synthetic content.
- Do not implement automatic repeated retries that could consume an external quota unless explicitly required.
- Treat free tiers and rate limits as changeable constraints, not unlimited resources.

## Audio and meeting data

- Do not commit audio files, model files, generated binaries, logs, transcripts, summaries, TODO contents, or real meeting data.
- Do not use real personal or meeting information in tests.
- Use synthetic test content.
- Do not log audio contents or transcript bodies.
- Do not persist temporary audio unless the task explicitly requires it.
- Do not include actual meeting content in the final report.

## STT provider architecture

- Keep browser capture, transport, server provider, and transcript storage responsibilities separated.
- Add new STT integrations through the existing provider boundaries.
- Do not call an external STT API directly from browser code.
- Keep external API credentials on the Node.js server.
- Preserve Local Whisper, Browser, Mock, WebSocket, and existing provider behavior unless the task explicitly changes them.
- Do not silently change the default provider.
- Validate external responses at runtime instead of trusting type assertions.
- Use fixed, safe user-facing error messages.
- Do not expose provider response bodies, stack traces, headers, or internal identifiers to users.

## Correction and summary architecture

- Keep STT, correction, and summary as separate pipelines.
- Do not make recording or STT wait for correction unless the existing design requires it.
- Preserve immutable raw transcript text.
- Do not allow delayed correction or summary results to update another meeting.
- Do not change Correction or Summary providers as part of an unrelated feature.

## Meeting history

- Preserve the separation between the current page-session meeting and persisted meeting records.
- Do not inject persisted records into the active recording session.
- Do not clear or delete history unless the current task explicitly requires it.
- Do not change the IndexedDB database version or `MeetingRecord` schema version without an explicit migration task.
- Do not use repository-wide `clear()` when deleting one record.
- Preserve other meeting records during individual updates or deletions.

## Concurrency and lifecycle

For asynchronous controllers, queues, and providers:

- Prevent duplicate operations.
- Bound queues and concurrency.
- Release in-flight references in `finally`.
- Reject stale results using generation IDs, operation tokens, session IDs, or equivalent safeguards.
- Ignore delayed results after `clear()`, reset, cancel, or dispose.
- Avoid unhandled Promise rejections.
- Make cleanup and close operations idempotent.
- Preserve existing `pagehide` and shutdown cleanup.

## DOM and UI safety

- Render user-controlled and persisted values with safe DOM APIs such as `textContent`.
- Do not insert them through `innerHTML`, `outerHTML`, or `insertAdjacentHTML`.
- Do not use stored values directly as DOM IDs, class names, styles, event-handler strings, or URLs.
- Use real buttons with `type="button"`.
- Preserve keyboard access, focus visibility, accessible names, and live-region behavior.
- Do not communicate important states using color alone.
- Check narrow layouts when UI changes are made.

## Running processes

- Check whether the development server or frontend is already running before starting another instance.
- Do not start a second server on the same port.
- Do not terminate all Node.js processes.
- Inspect the owning PID and command line before stopping a process.
- Do not stop processes belonging to another project.

## Scope control

Do only the work described in the active task.

Do not add adjacent features such as:

- accounts
- team sharing
- cloud history
- permissions
- deployment
- billing
- unrelated editing features
- unrelated migrations

unless explicitly requested.

## Final report

At the end of each task, report:

- starting branch and base commit
- created branch
- implementation summary
- changed files
- new files
- important design decisions
- focused test results
- full test results
- typecheck, lint, and build results
- `git diff --check` result
- browser or live API checks actually performed
- checks that remain manual
- dependency and lockfile status
- `.env` status
- schema and migration status
- external network calls performed
- commit, push, pull request, and merge status
- remaining limitations

Do not include local absolute paths, credentials, authorization values, real meeting contents, transcript bodies, summary bodies, or `.env` contents in the final report.
