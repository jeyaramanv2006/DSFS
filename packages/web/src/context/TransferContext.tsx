import React, { createContext, useContext, useState, useRef, useCallback, useEffect, useMemo } from 'react';
import {
  type TransferStatus,
  type ActiveTransfer,
  deriveTransferStatus,
  handleStartTransfer,
  handleUpdateTransfer,
  handleFinishTransfer,
} from './transfer-state.js';

export type { TransferStatus, ActiveTransfer };

export interface BackgroundSweep {
  id: number;
  direction: 'down' | 'up';
}

export interface TransferContextValue {
  transferStatus: TransferStatus;
  activeTransfers: ActiveTransfer[];
  startTransfer: (id: string, type: 'upload' | 'download') => void;
  updateTransfer: (id: string, percent: number) => void;
  finishTransfer: (id: string, outcome: 'completed' | 'error' | 'aborted') => void;
  currentSweep: BackgroundSweep | null;
  triggerSweep: (direction: 'down' | 'up') => void;
}

const TransferContext = createContext<TransferContextValue | null>(null);

export const TransferProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [activeTransfersMap, setActiveTransfersMap] = useState<Map<string, ActiveTransfer>>(new Map());
  const [transientStatus, setTransientStatus] = useState<'completed' | 'error' | null>(null);
  const [currentSweep, setCurrentSweep] = useState<BackgroundSweep | null>(null);
  const transientTimerRef = useRef<number | null>(null);

  const clearTransientTimer = useCallback(() => {
    if (transientTimerRef.current !== null) {
      window.clearTimeout(transientTimerRef.current);
      transientTimerRef.current = null;
    }
  }, []);

  const triggerSweep = useCallback((direction: 'down' | 'up') => {
    setCurrentSweep({ id: Date.now() + Math.random(), direction });
  }, []);

  const startTransfer = useCallback((id: string, type: 'upload' | 'download') => {
    clearTransientTimer();
    setTransientStatus(null);
    setActiveTransfersMap((prev) => handleStartTransfer(prev, id, type));
  }, [clearTransientTimer]);

  const updateTransfer = useCallback((id: string, percent: number) => {
    setActiveTransfersMap((prev) => handleUpdateTransfer(prev, id, percent));
  }, []);

  const finishTransfer = useCallback((id: string, outcome: 'completed' | 'error' | 'aborted') => {
    setActiveTransfersMap((prev) => {
      const { nextMap, isLast } = handleFinishTransfer(prev, id);

      // If this was the last active transfer, trigger transient completion/error state
      if (isLast) {
        clearTransientTimer();
        if (outcome === 'completed') {
          setTransientStatus('completed');
          transientTimerRef.current = window.setTimeout(() => {
            setTransientStatus(null);
            transientTimerRef.current = null;
          }, 2400);
        } else if (outcome === 'error') {
          setTransientStatus('error');
          transientTimerRef.current = window.setTimeout(() => {
            setTransientStatus(null);
            transientTimerRef.current = null;
          }, 2400);
        } else {
          setTransientStatus(null);
        }
      }

      return nextMap;
    });
  }, [clearTransientTimer]);

  useEffect(() => {
    return () => {
      clearTransientTimer();
    };
  }, [clearTransientTimer]);

  const activeTransfers = useMemo(() => Array.from(activeTransfersMap.values()), [activeTransfersMap]);

  // Aggregate transfer status
  const transferStatus = useMemo(
    () => deriveTransferStatus({ activeTransfers, transientStatus }),
    [activeTransfers, transientStatus],
  );

  const value = useMemo(
    () => ({
      transferStatus,
      activeTransfers,
      startTransfer,
      updateTransfer,
      finishTransfer,
      currentSweep,
      triggerSweep,
    }),
    [transferStatus, activeTransfers, startTransfer, updateTransfer, finishTransfer, currentSweep, triggerSweep],
  );

  return <TransferContext.Provider value={value}>{children}</TransferContext.Provider>;
};

export function useTransferState(): TransferContextValue {
  const ctx = useContext(TransferContext);
  if (!ctx) {
    throw new Error('useTransferState must be used within a TransferProvider');
  }
  return ctx;
}
