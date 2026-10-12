# Legacy Dart data track

This directory contains the original/reference Dart implementation of place selection, offline map packs, routing, weather, community notes, and route JSON. The currently deployed product is the TypeScript PWA in [`web/`](../../../../web/README.md); this Dart track is retained for parity and integration work.

## Responsibilities

- Query Overpass while online and cache places and walkable ways.
- Use a bundled fallback dataset when no network or map pack is available.
- Rank places by category, distance, visit history, and optional community data.
- Build 2–3 loop suggestions and encode the selected route in `route_json`.
- Keep shared-note behavior opt-in and privacy-filtered.

The data track does not own the web UI or browser IndexedDB. The deployed web equivalents live under `web/src/data/` and `web/src/routing/`.

## Offline route pipeline

```text
cached map pack → Overpass refresh when online → candidate filtering → scoring → loop routing
```

The bundled demo pack allows deterministic tests without network access. A downloaded pack is required for real street routing in a new area; a straight-line fallback is used when no street graph is available.

## Route and community behavior

- Route budgets are based on the requested walking duration.
- Up to three route options can be offered.
- Skipping a place recalculates without a network request.
- Community notes are snapshots of cleaned journal text and are shared only by explicit user choice.
- Photos and audio are local-only in the deployed web application.

## Useful checks

```bash
flutter test
dart run scripts/datatrack/smoke_route.dart
dart run scripts/datatrack/smoke_data.dart
```

Use the Dart track when maintaining the original mobile/data implementation. For current Render deployment, PWA setup, Whisper/Gemma behavior, and Atlas sync, use [`web/README.md`](../../../../web/README.md) and [`server/README.md`](../../../../server/README.md).
