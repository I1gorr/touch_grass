import './ui/theme.css';
import { registerSW } from 'virtual:pwa-register';
import { startApp } from './app';
import { toast } from './ui/components';

const root = document.getElementById('app');
if (root) void startApp(root);

// The app works offline once opened. A new version waits until the app is closed and reopened, so an update never
// interrupts a walk or a recording.
registerSW({
  immediate: true,
  onNeedRefresh: () => toast('A new version is ready. Close and reopen the app to update.', 8000),
  onOfflineReady: () => toast('Ready to work offline.'),
});
