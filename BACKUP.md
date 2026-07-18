# Backup and restore

The verified baseline was backed up before external STT work.

- Source: `minutes-transcription-app`
- Backup: `minutes-transcription-app-backup-20260715-2000`
- Created: 2026-07-15 20:00 JST
- Excluded: `node_modules`, `dist`, `server/dist`, `coverage`, `.git`, `.env`, cache directories, logs, temporary files, and TypeScript build-info files
- Verification at creation time: 61 included source files, 61 backup files, 0 missing, 0 extra

## Restore

1. Stop the frontend and backend development servers.
2. Keep the current application directory as a separate safety copy; do not overwrite it in place unless its contents are no longer needed.
3. Copy `minutes-transcription-app-backup-20260715-2000` to a new directory named `minutes-transcription-app-restored`.
4. In the restored directory, create `.env` from `.env.example` if local settings are needed. Never copy API keys into source control.
5. Run `pnpm install --frozen-lockfile`.
6. Run `pnpm run typecheck`, `pnpm run lint`, `pnpm test`, and `pnpm run build`.
7. Start the backend with `pnpm run dev:server` and the frontend with `pnpm run dev`.

The backup intentionally does not include generated dependencies or secrets. Reinstall dependencies and recreate local environment variables after restoration.
