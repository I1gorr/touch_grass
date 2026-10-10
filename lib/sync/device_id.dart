import 'dart:io';

import 'package:path_provider/path_provider.dart';

/// Reads the device id older builds kept in a `device_id` file. The id now
/// lives in the database (SyncableStore.deviceId), which adopts this value
/// once so cloud rows written under it stay updatable. Never creates an id.
class DeviceId {
  static Future<String?> readLegacy({File? file}) async {
    try {
      final f = file ?? File('${(await getApplicationSupportDirectory()).path}/device_id');
      final value = (await f.readAsString()).trim();
      return RegExp(r'^[0-9a-f]{32}$').hasMatch(value) ? value : null;
    } catch (_) {
      return null;
    }
  }
}
