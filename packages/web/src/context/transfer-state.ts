export type TransferStatus = 'idle' | 'uploading' | 'downloading' | 'completed' | 'error';

export interface ActiveTransfer {
  id: string;
  type: 'upload' | 'download';
  percent?: number;
}

export interface TransferStateSnapshot {
  activeTransfers: ActiveTransfer[];
  transientStatus: 'completed' | 'error' | null;
}

export function deriveTransferStatus(snapshot: TransferStateSnapshot): TransferStatus {
  if (snapshot.activeTransfers.length > 0) {
    const hasUpload = snapshot.activeTransfers.some((t) => t.type === 'upload');
    if (hasUpload) return 'uploading';
    return 'downloading';
  }
  if (snapshot.transientStatus === 'completed') return 'completed';
  if (snapshot.transientStatus === 'error') return 'error';
  return 'idle';
}

export function handleStartTransfer(
  prevMap: Map<string, ActiveTransfer>,
  id: string,
  type: 'upload' | 'download',
): Map<string, ActiveTransfer> {
  const next = new Map(prevMap);
  next.set(id, { id, type, percent: 0 });
  return next;
}

export function handleUpdateTransfer(
  prevMap: Map<string, ActiveTransfer>,
  id: string,
  percent: number,
): Map<string, ActiveTransfer> {
  const existing = prevMap.get(id);
  if (!existing) return prevMap;
  const next = new Map(prevMap);
  next.set(id, { ...existing, percent });
  return next;
}

export function handleFinishTransfer(
  prevMap: Map<string, ActiveTransfer>,
  id: string,
): { nextMap: Map<string, ActiveTransfer>; isLast: boolean } {
  if (!prevMap.has(id)) {
    return { nextMap: prevMap, isLast: false };
  }
  const nextMap = new Map(prevMap);
  nextMap.delete(id);
  return { nextMap, isLast: nextMap.size === 0 };
}
