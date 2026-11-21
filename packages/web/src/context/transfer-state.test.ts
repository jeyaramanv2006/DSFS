import { describe, it, expect } from 'vitest';
import {
  deriveTransferStatus,
  handleStartTransfer,
  handleUpdateTransfer,
  handleFinishTransfer,
  type ActiveTransfer,
} from './transfer-state.js';

describe('Transfer State Transitions', () => {
  it('defaults to idle when no transfers are active and no transient state exists', () => {
    const status = deriveTransferStatus({
      activeTransfers: [],
      transientStatus: null,
    });
    expect(status).toBe('idle');
  });

  it('reports uploading when at least one active transfer is an upload', () => {
    const status = deriveTransferStatus({
      activeTransfers: [{ id: 'up-1', type: 'upload', percent: 10 }],
      transientStatus: null,
    });
    expect(status).toBe('uploading');
  });

  it('reports downloading when active transfers are downloads', () => {
    const status = deriveTransferStatus({
      activeTransfers: [{ id: 'down-1', type: 'download', percent: 50 }],
      transientStatus: null,
    });
    expect(status).toBe('downloading');
  });

  it('prioritizes uploading over downloading when both exist', () => {
    const status = deriveTransferStatus({
      activeTransfers: [
        { id: 'down-1', type: 'download', percent: 20 },
        { id: 'up-1', type: 'upload', percent: 50 },
      ],
      transientStatus: null,
    });
    expect(status).toBe('uploading');
  });

  it('reports completed when active is empty and transientStatus is completed', () => {
    const status = deriveTransferStatus({
      activeTransfers: [],
      transientStatus: 'completed',
    });
    expect(status).toBe('completed');
  });

  it('reports error when active is empty and transientStatus is error', () => {
    const status = deriveTransferStatus({
      activeTransfers: [],
      transientStatus: 'error',
    });
    expect(status).toBe('error');
  });

  it('manages lifecycle correctly across multiple transfers', () => {
    let map = new Map<string, ActiveTransfer>();

    // Start upload 1
    map = handleStartTransfer(map, 'up-1', 'upload');
    expect(map.size).toBe(1);
    expect(deriveTransferStatus({ activeTransfers: Array.from(map.values()), transientStatus: null })).toBe('uploading');

    // Update progress
    map = handleUpdateTransfer(map, 'up-1', 45);
    expect(map.get('up-1')?.percent).toBe(45);

    // Start download 2 concurrently
    map = handleStartTransfer(map, 'down-2', 'download');
    expect(map.size).toBe(2);
    expect(deriveTransferStatus({ activeTransfers: Array.from(map.values()), transientStatus: null })).toBe('uploading');

    // Finish upload 1: download 2 is still active, so isLast is false
    const finish1 = handleFinishTransfer(map, 'up-1');
    map = finish1.nextMap;
    expect(finish1.isLast).toBe(false);
    expect(map.size).toBe(1);
    expect(deriveTransferStatus({ activeTransfers: Array.from(map.values()), transientStatus: null })).toBe('downloading');

    // Finish download 2: now isLast is true
    const finish2 = handleFinishTransfer(map, 'down-2');
    map = finish2.nextMap;
    expect(finish2.isLast).toBe(true);
    expect(map.size).toBe(0);
    expect(deriveTransferStatus({ activeTransfers: Array.from(map.values()), transientStatus: 'completed' })).toBe('completed');
  });
});
