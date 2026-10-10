import 'dart:async';

import 'package:flutter/foundation.dart';

import 'sync_store.dart';
import 'sync_transport.dart';

/// Uploads local walk/stop/entry changes to the cloud whenever possible.
/// Photos are never uploaded; they live only in the local database. SQLite stays the
/// source of truth: a failed sync never blocks or loses anything; rows just
/// stay pending until the next attempt.
///
/// Attempts happen: [debounce] after local changes, every [interval], and on
/// [syncNow] (Settings button, walk finished).
class SyncService extends ChangeNotifier {
  final SyncableStore store;
  final SyncTransport transport;
  final String deviceId;
  final Stream<void>? changes;
  final Duration interval;
  final Duration debounce;
  final int batchSize;

  /// Data-track rule: a walk never touches the network. When this returns
  /// true (a walk is active), runs are skipped and resume after the walk.
  final Future<bool> Function()? walkInProgress;

  /// False when the transport was supplied from outside (and is reused), so
  /// [close] must not shut it.
  final bool ownsTransport;

  /// Safety cap so a store that never clears its pending rows can't loop forever.
  final int maxBatchesPerRun;
  final DateTime Function() clock;

  SyncService({
    required this.store,
    required this.transport,
    required this.deviceId,
    this.changes,
    this.interval = const Duration(minutes: 5),
    this.debounce = const Duration(seconds: 5),
    this.batchSize = 200,
    this.maxBatchesPerRun = 50,
    this.ownsTransport = true,
    this.walkInProgress,
    DateTime Function()? clock,
  }) : clock = clock ?? DateTime.now;

  DateTime? lastSuccess;
  Object? lastError;
  int pending = 0;
  bool running = false;

  /// True when the last attempt was skipped because a walk is in progress.
  bool waitingForWalk = false;

  /// Rows the server refused because a different install owns them. Should
  /// stay 0; anything else means this install's identity changed.
  int refused = 0;

  /// A permanent failure (e.g. wrong API key) stops automatic retries until
  /// [syncNow] is called explicitly.
  bool paused = false;

  Future<SyncResult>? _inFlight;
  Timer? _periodic;
  Timer? _debounced;
  StreamSubscription<void>? _sub;
  bool _disposed = false;

  void start() {
    _periodic ??= Timer.periodic(interval, (_) => _auto());
    _sub ??= changes?.listen((_) {
      _debounced?.cancel();
      _debounced = Timer(debounce, _auto);
    });
    _auto();
  }

  void _auto() {
    if (!paused && !_disposed) syncNow(manual: false).ignore();
  }

  /// Uploads everything pending. Concurrent calls share one run.
  Future<SyncResult> syncNow({bool manual = true}) {
    if (manual) paused = false;
    return _inFlight ??= _run().whenComplete(() => _inFlight = null);
  }

  Future<SyncResult> _run() async {
    running = true;
    _notify();
    final guard = walkInProgress;
    if (guard != null && await guard()) {
      waitingForWalk = true;
      running = false;
      try {
        pending = await store.pendingCount();
      } catch (_) {}
      _notify();
      return const SyncResult(uploaded: 0, skippedForWalk: true);
    }
    waitingForWalk = false;
    var uploaded = 0;
    var refusedRows = 0;
    try {
      for (var i = 0; i < maxBatchesPerRun; i++) {
        final batch = await store.pendingChanges(limitPerTable: batchSize);
        if (batch.isEmpty) break;
        final refused = await transport.push(deviceId, batch);
        // Rows the server refused because another install owns them can never
        // be written by this one; mark them done but tell the user.
        refusedRows += refused;
        await store.markSynced(batch);
        uploaded += batch.count;
      }
      lastSuccess = clock();
      lastError = null;
      if (refusedRows > 0) {
        refused += refusedRows;
        debugPrint('[sync] $refusedRows rows refused: owned by another install');
      }
      return SyncResult(uploaded: uploaded);
    } catch (e) {
      lastError = e;
      if (e is SyncException && e.isPermanent) paused = true;
      return SyncResult(uploaded: uploaded, error: e);
    } finally {
      try {
        pending = await store.pendingCount();
      } catch (_) {}
      running = false;
      _notify();
    }
  }

  void _notify() {
    if (!_disposed) notifyListeners();
  }

  /// Stops scheduling, waits for any upload in progress, then releases the
  /// transport. Use this rather than [dispose] when shutting services down.
  Future<void> close() async {
    _stopTimers();
    try {
      await _inFlight;
    } catch (_) {}
    if (ownsTransport) await transport.close();
    dispose();
  }

  void _stopTimers() {
    _periodic?.cancel();
    _debounced?.cancel();
    _sub?.cancel();
  }

  @override
  void dispose() {
    if (_disposed) return;
    _disposed = true;
    _stopTimers();
    super.dispose();
  }
}

class SyncResult {
  final int uploaded;
  final Object? error;

  /// Nothing was sent because a walk is in progress (not an error).
  final bool skippedForWalk;
  const SyncResult({required this.uploaded, this.error, this.skippedForWalk = false});
  bool get ok => error == null;
}
