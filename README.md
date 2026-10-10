# Touch Grass

Offline walk-quest app: an installable PWA for Android (Chrome → "Add to Home screen") that plans street-routed walk
loops, records voice notes, and transcribes them on the phone.

- Web app, deployment, on-device models, tests: [`web/README.md`](web/README.md)
- Cloud backup API (also serves the web app and answers browser calls): [`server/README.md`](server/README.md)
- **New to the project? Start with [`docs/WEB_HANDOFF.md`](docs/WEB_HANDOFF.md)** (what was built, why, architecture, what is verified, what to do next)
- Data schema (SQLite + Atlas) and why: [`docs/DATA_SCHEMA.md`](docs/DATA_SCHEMA.md)

Quick start: `cd web && npm install && npm run dev`.

Tests: `cd web && npm test` (web app), `cd server && npm test` (sync API).
