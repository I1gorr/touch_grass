import 'dart:convert';
import 'dart:io';

/// Reports of community notes, kept on the phone until the internet is back.
/// A reported note is hidden for this person immediately, even offline.
class ReportQueue {
  final File file;
  ReportQueue(this.file);

  Future<Map<String, dynamic>> _read() async {
    try {
      if (await file.exists()) return jsonDecode(await file.readAsString()) as Map<String, dynamic>;
    } catch (_) {/* corrupt: start fresh */}
    return {'pending': <dynamic>[], 'hidden': <dynamic>[]};
  }

  Future<void> _write(Map<String, dynamic> m) async {
    await file.parent.create(recursive: true);
    final tmp = File('${file.path}.tmp');
    await tmp.writeAsString(jsonEncode(m));
    await tmp.rename(file.path);
  }

  /// Notes this person reported (and so no longer sees).
  Future<Set<String>> hiddenIds() async => {for (final id in (await _read())['hidden'] as List) id as String};

  Future<List<({String entryId, String reason})>> pending() async => [
        for (final p in (await _read())['pending'] as List)
          (entryId: (p as Map)['entryId'] as String, reason: p['reason'] as String),
      ];

  Future<void> report(String entryId, {String reason = 'other'}) async {
    final m = await _read();
    final hidden = {...(m['hidden'] as List).cast<String>(), entryId};
    final pending = [...(m['pending'] as List)];
    if (!pending.any((p) => (p as Map)['entryId'] == entryId)) pending.add({'entryId': entryId, 'reason': reason});
    await _write({'pending': pending, 'hidden': hidden.toList()});
  }

  /// Forget a report once the server has it. The note stays hidden locally.
  Future<void> markSent(String entryId) async {
    final m = await _read();
    m['pending'] = [for (final p in m['pending'] as List) if ((p as Map)['entryId'] != entryId) p];
    await _write(m);
  }
}
