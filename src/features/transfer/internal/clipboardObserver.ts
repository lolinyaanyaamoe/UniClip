import { AppState, Platform } from 'react-native';
import type { ClipboardContent } from '@/types/clipboard';
import type { SyncDeliveryResult } from '@/features/sync';
import { useSettingsStore } from '@/features/settings';
import { canAutoPushInBackground } from '@/utils/syncDirectionPolicy';
import { getCurrentNetworkContext } from '@/platform/network';
import { createLogger } from '@/support/observability';

const log = createLogger('ClipboardSyncObserver');

let observeClipboardChange:
  | ((content: ClipboardContent, dispatch: boolean) => Promise<SyncDeliveryResult | null>)
  | null = null;

export function configureClipboardObserver(
  observe: (content: ClipboardContent, dispatch: boolean) => Promise<SyncDeliveryResult | null>
): void {
  observeClipboardChange = observe;
}

export async function notifyDeviceClipboardChanged(
  content: ClipboardContent
): Promise<SyncDeliveryResult | null> {
  const settings = useSettingsStore.getState();
  const config = settings.config;
  // iOS paste permission dialogs temporarily make the foreground app inactive.
  // The monitor keeps reading in that state; applying the background policy here
  // would capture without sending, then deduplication would hide the next read.
  const appState = AppState.currentState;
  const appIsBackground =
    appState !== 'active' && !(Platform.OS === 'ios' && appState === 'inactive');
  const dispatch =
    (appIsBackground
      ? canAutoPushInBackground(
          config,
          settings.isTempDisabledBackgroundTasks,
          getCurrentNetworkContext()
        )
      : config?.autoPushLocal ?? true) &&
    (content.type === 'Text' || content.type === 'Image');

  try {
    if (!observeClipboardChange) throw new Error('The clipboard observer is not configured');
    return await observeClipboardChange(content, dispatch);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    log.info('Clipboard observation failed; kept local:', detail);
    return null;
  }
}
