import { beforeEach, describe, expect, it, jest } from '@jest/globals';

describe('captured clipboard dispatch', () => {
  beforeEach(() => {
    jest.resetModules();
    jest.doMock('react-native', () => ({
      AppState: { currentState: 'background' },
      Platform: { OS: 'android' },
    }));
    jest.doMock('@/features/settings', () => ({
      useSettingsStore: {
        getState: () => ({
          config: { autoPushLocal: true, autoPushLocalInBackground: true },
          isTempDisabledBackgroundTasks: false,
        }),
      },
    }));
    jest.doMock('@/utils/syncDirectionPolicy', () => ({
      canAutoPushInBackground: () => true,
    }));
    jest.doMock('@/platform/network', () => ({ getCurrentNetworkContext: () => ({}) }));
    jest.doMock('@/features/transfer/internal/deliveryState', () => ({
      persistP2pDeliveryReport: jest.fn<() => Promise<void>>(async () => {}),
    }));
    jest.doMock('@/support/observability', () => ({
      createLogger: () => ({ info: jest.fn() }),
    }));
  });

  it.each([
    {
      type: 'Text',
      text: 'already captured while Android allowed the read',
      profileHash: 'local-text',
    },
    {
      type: 'Image',
      fileUri: 'file:///clipboard.png',
      profileHash: 'local-image',
    },
  ])(
    'asks the engine to observe a changed $type clipboard through the system clipboard',
    async (content) => {
      const {
        configureClipboardObserver,
        notifyDeviceClipboardChanged,
      } = require('@/features/transfer/internal/clipboardObserver');
      const observe = jest.fn().mockResolvedValue(null);
      configureClipboardObserver(observe);
      await notifyDeviceClipboardChanged(content);

      expect(observe).toHaveBeenCalledWith(content, true);
    }
  );

  it.each([
    ['ios', 'inactive', true, true],
    ['ios', 'inactive', false, false],
    ['ios', 'background', true, false],
    ['ios', null, true, false],
    ['android', 'inactive', true, false],
    ['android', 'active', true, true],
  ])(
    '%s %s with auto push=%s dispatches=%s when background upload is disabled',
    async (platform, appState, autoPushLocal, expectedDispatch) => {
      jest.doMock('react-native', () => ({
        AppState: { currentState: appState },
        Platform: { OS: platform },
      }));
      jest.doMock('@/features/settings', () => ({
        useSettingsStore: {
          getState: () => ({
            config: {
              autoPushLocal,
              enableBackgroundTasks: false,
              enableBackgroundUpload: false,
            },
            isTempDisabledBackgroundTasks: false,
          }),
        },
      }));
      jest.dontMock('@/utils/syncDirectionPolicy');

      const {
        configureClipboardObserver,
        notifyDeviceClipboardChanged,
      } = require('@/features/transfer/internal/clipboardObserver');
      const observe = jest.fn<() => Promise<null>>().mockResolvedValue(null);
      configureClipboardObserver(observe);
      const content = { type: 'Text', text: 'local test', profileHash: 'local-test' };
      await notifyDeviceClipboardChanged(content);

      expect(observe).toHaveBeenCalledWith(content, expectedDispatch);
    }
  );
});
