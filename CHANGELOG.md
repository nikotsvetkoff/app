# Changelog

## 0.1.0 - 2026-02-19

### Commit 1 - `chore(monorepo): bootstrap workspace and shared tooling`
- Initialized pnpm workspace (`pnpm-workspace.yaml`, root `package.json`).
- Added shared TypeScript config (`tsconfig.base.json`).
- Added ESLint + Prettier + editor config.
- Added `.gitignore` and root documentation stubs.

### Commit 2 - `feat(core): add shared IPTV domain + parsers + navigation`
- Implemented core domain models (`Channel`, `EpgProgram`, `UserProfile`, `Device`, `PlaybackState`).
- Added M3U parser with stable channel hash IDs.
- Added EPG now/next and day filter helpers.
- Added favorites/history storage interfaces + browser adapter.
- Added remote key mapping + focus manager.
- Added common `PlayerAdapter` interface.

### Commit 3 - `feat(ui): remote-first reusable React TV components`
- Added grouped channel list with collapse/favorites actions.
- Added search bar + TV shell layout.
- Added now/next overlay with progress.
- Added remote navigation hook for keyboard/TV events.

### Commit 4 - `feat(backend): nestjs api with auth, pairing, playlist, epg, telemetry`
- Added NestJS backend architecture with Prisma/PostgreSQL.
- Added JWT auth (`/auth/register`, `/auth/login`).
- Added pairing flow:
  - `POST /devices/pair/start`
  - `POST /devices/pair/confirm`
  - `GET /devices/pair/status`
- Added device token protected APIs:
  - `GET /device/profile`
  - `GET /device/playlist`
  - `GET /device/epg/now-next`
  - `GET /device/epg/day`
- Added playlist source management + cache TTL + fallback to last known good.
- Added XMLTV ingest/parser and EPG snapshot serving.
- Added telemetry ingest endpoint.
- Added URL security checks and basic SSRF mitigation.
- Added Swagger setup at `/docs`.

### Commit 5 - `feat(infra): prisma schema, migration, docker compose`
- Added Prisma schema and initial SQL migration.
- Added seed script.
- Added backend `.env.example`.
- Added Docker Compose for PostgreSQL + backend runtime.

### Commit 6 - `feat(tizen): react tv app with avplay adapter`
- Added Samsung Tizen app shell with pairing + polling.
- Added AVPlay-based player adapter with buffering/error events.
- Added channel browser, playback, now/next overlay, favorites persistence.
- Added telemetry emission from client.

### Commit 7 - `feat(webos): react tv app with html5 video adapter`
- Added LG webOS app shell with pairing + polling.
- Added HTML5 video adapter with HLS capability checks.
- Added channel browser, playback, now/next overlay, favorites persistence.
- Added telemetry emission from client.

### Commit 8 - `feat(android-tv): native kotlin app with media3`
- Added Android TV Gradle project (Compose + Media3 ExoPlayer).
- Added backend client, device token store, player controller.
- Added pairing flow, playlist retrieval, now/next overlay, favorites local persistence.
- Added remote key handling for D-pad/enter/menu.

### Commit 9 - `feat(web-admin): minimal onboarding panel`
- Added web-admin app for register/login.
- Added forms to set playlist URL and EPG URL.
- Added pairing code confirmation flow.

### Commit 10 - `chore(qa): lint, build, smoke-ready docs`
- Ensured workspace build passes for Node/TS projects.
- Ensured ESLint passes across TS workspaces.
- Added complete README run/build/package/smoke-test instructions.
- Documented MVP limitations and extension paths.

### Commit 11 - `chore(tizen): add packaging scripts and usb install guide`
- Added `apps/tizen/config.xml` at app root for packaging flow.
- Added `apps/tizen/icon.png` placeholder.
- Added scripts:
  - `package:wgt:signed`
  - `package:wgt:unsigned`
- Added PowerShell helpers in `apps/tizen/scripts/`.
- Added `apps/tizen/USB-INSTALL.md` with USB demo packaging flow.

### Commit 12 - `fix(tizen): make signed packaging command robust`
- Updated signed packaging script to detect `tizen` CLI from PATH or fallback path.
- Fixed Tizen CLI packaging option usage (`-o` output flag).
- Set default profile handling in signed script.
- Simplified `package:wgt:signed` npm script to run without extra args.
