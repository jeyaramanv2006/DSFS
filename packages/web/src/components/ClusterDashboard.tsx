import React, { useEffect, useRef, useState } from 'react';
import {
  fetchClusterEvents,
  fetchClusterNodes,
  fetchClusterOverview,
  fetchClusterTransfers,
  fetchTransferChunks,
  type ClusterChunkDetail,
  type ClusterEvent,
  type ClusterNodeInfo,
  type ClusterOverview,
  type ClusterTransferDetail,
  type ClusterTransferSummary,
} from '../cluster.js';

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function formatHeartbeatAge(ageMs: number): string {
  if (ageMs > 86400000) return 'Never / Offline';
  const seconds = ageMs / 1000;
  if (seconds < 1) return '< 1s ago';
  if (seconds < 60) return `${seconds.toFixed(1)}s ago`;
  const minutes = Math.floor(seconds / 60);
  const remSec = Math.floor(seconds % 60);
  return `${minutes}m ${remSec}s ago`;
}

function formatEventDetails(event: ClusterEvent): string {
  if (!event.details) return '';
  if (typeof event.details === 'string') return event.details;

  const d = event.details as Record<string, unknown>;
  if (event.eventType === 'HEALTH_TRANSITION' && d.from && d.to) {
    return `Transitioned from ${d.from} to ${d.to}`;
  }
  if (event.eventType === 'NODE_HEARTBEAT_REJECTED' && d.reason) {
    return `Rejected: ${d.reason}${d.endpointUrl ? ` (${d.endpointUrl})` : ''}`;
  }
  if (event.eventType === 'FAILOVER_READ' && d.fromNode && d.toNode) {
    return `Read failover from ${d.fromNode} to ${d.toNode} (chunk: ${d.chunkId ?? 'unknown'})`;
  }
  if (event.eventType === 'RECOVERY_RUN') {
    return `Candidate chunks: ${d.candidateCount ?? 0}, recovered: ${d.recoveredCount ?? 0}`;
  }
  if (event.eventType === 'RECONCILE_RUN') {
    return `Orphaned replicas purged: ${d.orphanedCount ?? 0}, missing chunks flagged: ${d.missingCount ?? 0}`;
  }
  if (event.eventType === 'EXPIRATION_SWEEP') {
    return `Swept transfers: ${d.sweptCount ?? 0}`;
  }
  if (event.eventType === 'TRANSFER_CREATED') {
    return `Created transfer: ${d.chunkCount ?? 0} chunks, ${formatBytes(Number(d.totalSizeBytes ?? 0))}`;
  }
  if (event.eventType === 'UPLOAD_FINALIZED') {
    return `Upload completed & verified on cluster nodes`;
  }
  if (event.eventType === 'TRANSFER_CONSUMED') {
    return `Download limit reached (${d.downloadCount ?? 1}/${d.maxDownloads ?? 1}) — scheduled for purge`;
  }

  return Object.entries(d)
    .map(([k, v]) => `${k}: ${typeof v === 'object' ? JSON.stringify(v) : v}`)
    .join(' · ');
}

export function ClusterDashboard() {
  const [overview, setOverview] = useState<ClusterOverview | null>(null);
  const [nodes, setNodes] = useState<ClusterNodeInfo[]>([]);
  const [transfers, setTransfers] = useState<ClusterTransferSummary[]>([]);
  const [selectedFileId, setSelectedFileId] = useState<string | null>(null);
  const [transferDetail, setTransferDetail] = useState<ClusterTransferDetail | null>(null);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [events, setEvents] = useState<ClusterEvent[]>([]);
  const [eventFilter, setEventFilter] = useState<'ALL' | 'HEALTH' | 'TRANSFERS' | 'REPLICATION'>('ALL');
  const [showDemoGuide, setShowDemoGuide] = useState(true);

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [consecutiveErrors, setConsecutiveErrors] = useState(0);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const isFetchingRef = useRef(false);

  const pollData = async (externalSignal?: AbortSignal) => {
    if (isFetchingRef.current) return;
    isFetchingRef.current = true;

    const timeoutController = new AbortController();
    const timeoutId = setTimeout(() => timeoutController.abort(), 4000);

    const onExternalAbort = () => timeoutController.abort();
    if (externalSignal) {
      externalSignal.addEventListener('abort', onExternalAbort);
    }

    try {
      const signal = timeoutController.signal;
      const [overviewData, nodesData, transfersData, eventsData] = await Promise.all([
        fetchClusterOverview(signal),
        fetchClusterNodes(signal),
        fetchClusterTransfers(20, signal),
        fetchClusterEvents({ limit: 50 }, signal),
      ]);
      setOverview(overviewData);
      setNodes(nodesData);
      setTransfers(transfersData);
      setEvents(eventsData);
      setLastUpdated(new Date());
      setError(null);
      setConsecutiveErrors(0);

      if (!selectedFileId && transfersData.length > 0) {
        setSelectedFileId(transfersData[0].fileId);
      }
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError' && externalSignal?.aborted) {
        return;
      }
      setConsecutiveErrors((prev) => prev + 1);
      setError(err instanceof Error ? err.message : 'Failed to connect to cluster API');
    } finally {
      clearTimeout(timeoutId);
      if (externalSignal) {
        externalSignal.removeEventListener('abort', onExternalAbort);
      }
      isFetchingRef.current = false;
      setLoading(false);
    }
  };

  useEffect(() => {
    if (!selectedFileId) {
      setTransferDetail(null);
      return;
    }
    let cancelled = false;
    setLoadingDetail(true);

    fetchTransferChunks(selectedFileId)
      .then((detail) => {
        if (!cancelled) setTransferDetail(detail);
      })
      .catch((err) => {
        if (!cancelled) console.error('Failed to fetch transfer detail', err);
      })
      .finally(() => {
        if (!cancelled) setLoadingDetail(false);
      });

    return () => {
      cancelled = true;
    };
  }, [selectedFileId]);

  useEffect(() => {
    const controller = new AbortController();
    void pollData(controller.signal);

    const intervalId = setInterval(() => {
      void pollData(controller.signal);
      if (selectedFileId) {
        fetchTransferChunks(selectedFileId, controller.signal)
          .then((detail) => setTransferDetail(detail))
          .catch(() => {});
      }
    }, 2000);

    return () => {
      controller.abort();
      clearInterval(intervalId);
    };
  }, [selectedFileId]);

  const unavailableNodesList = nodes.filter((n) => n.status === 'UNAVAILABLE');
  const unhealthyNodesList = nodes.filter((n) => n.status === 'UNHEALTHY');
  const isDataStale = !!(error && lastUpdated && Date.now() - lastUpdated.getTime() > 4000);

  const filteredEvents = events.filter((e) => {
    if (eventFilter === 'HEALTH') {
      return e.eventType.includes('HEALTH') || e.eventType.includes('HEARTBEAT');
    }
    if (eventFilter === 'TRANSFERS') {
      return (
        e.eventType.includes('TRANSFER') ||
        e.eventType.includes('UPLOAD') ||
        e.eventType.includes('EXPIRE') ||
        e.eventType.includes('CLEANUP')
      );
    }
    if (eventFilter === 'REPLICATION') {
      return (
        e.eventType.includes('REPLICA') ||
        e.eventType.includes('RECOVERY') ||
        e.eventType.includes('FAILOVER') ||
        e.eventType.includes('RECONCIL')
      );
    }
    return true;
  });

  return (
    <div className={`cluster-view ${isDataStale ? 'cluster-view-stale' : ''}`}>
      <header className="cluster-header">
        <div className="cluster-header-main">
          <div className="cluster-header-title-row">
            <span className="cluster-badge-tag">TOPOLOGY OBSERVABILITY</span>
            <div className="cluster-live-indicator">
              <span className={`live-dot ${error ? 'live-dot-error' : 'live-dot-pulse'}`} />
              <span className="live-label">
                {error
                  ? `CONNECTION DISRUPTED (${consecutiveErrors} missed)`
                  : 'LIVE TELEMETRY (2s)'}
              </span>
            </div>
          </div>
          <h1 className="cluster-heading">Cluster Operations Console</h1>
          <p className="cluster-subheading">
            Real-time topology health, storage distribution, and replica placement across 3-PC LAN
          </p>
        </div>

        <div className="cluster-header-actions">
          {lastUpdated && (
            <span className="cluster-timestamp">
              {isDataStale ? 'Last contact: ' : 'Updated: '}
              {lastUpdated.toLocaleTimeString()}
            </span>
          )}
          <button
            type="button"
            className="action-btn-secondary"
            onClick={() => void pollData()}
            disabled={loading}
          >
            Refresh Now
          </button>
        </div>
      </header>

      {/* Connection Outage Sticky Banner */}
      {error && (
        <div className="cluster-alert cluster-alert-error" role="alert">
          <div className="cluster-alert-icon">⚠️</div>
          <div className="cluster-alert-content">
            <div className="cluster-alert-title">
              <strong>Coordinator Connection Lost:</strong> {error}
            </div>
            <div className="cluster-alert-desc">
              Displaying cached cluster state from{' '}
              {lastUpdated
                ? `${Math.round((Date.now() - lastUpdated.getTime()) / 1000)}s ago`
                : 'previous cycle'}
              . Dashboard remains active and will automatically reconnect once available.
            </div>
          </div>
          <button
            type="button"
            className="action-btn-secondary alert-retry-btn"
            onClick={() => void pollData()}
          >
            Retry Connection
          </button>
        </div>
      )}

      {/* Node Failure / Failover Active Banner */}
      {unavailableNodesList.length > 0 && !error && (
        <div className="cluster-alert cluster-alert-warn" role="alert">
          <div className="cluster-alert-icon">⚡</div>
          <div className="cluster-alert-content">
            <div className="cluster-alert-title">
              <strong>Storage Node Outage Detected:</strong>{' '}
              {unavailableNodesList.map((n) => n.nodeId).join(', ')} is currently offline.
            </div>
            <div className="cluster-alert-desc">
              VoidShare read failover is ACTIVE. All chunk downloads will seamlessly route to online peer replicas on healthy storage nodes.
            </div>
          </div>
        </div>
      )}

      {/* Cluster Overview Metrics */}
      <section className="cluster-metrics-grid" aria-label="Cluster Metrics Overview">
        <div className="metric-card">
          <div className="metric-card-header">
            <span className="metric-title">STORAGE NODES</span>
            <span className="metric-icon">🖥️</span>
          </div>
          <div className="metric-value">
            {overview ? `${overview.healthyNodes} / ${overview.totalNodes}` : '—'}
            <span className="metric-unit">online</span>
          </div>
          <div className="metric-footer-tags">
            <span className="status-pill status-pill-success">
              {overview?.healthyNodes ?? 0} Healthy
            </span>
            {overview && overview.unhealthyNodes > 0 && (
              <span className="status-pill status-pill-warn">
                {overview.unhealthyNodes} Unhealthy
              </span>
            )}
            {overview && overview.unavailableNodes > 0 && (
              <span className="status-pill status-pill-error">
                {overview.unavailableNodes} Offline
              </span>
            )}
          </div>
        </div>

        <div className="metric-card">
          <div className="metric-card-header">
            <span className="metric-title">AGGREGATE STORAGE</span>
            <span className="metric-icon">💾</span>
          </div>
          <div className="metric-value">
            {overview ? formatBytes(overview.usedCapacityBytes) : '—'}
          </div>
          <div className="metric-subtext">
            of {overview ? formatBytes(overview.totalCapacityBytes) : '—'} total
          </div>
          <div className="metric-progress-bar">
            <div
              className="metric-progress-fill"
              style={{
                width:
                  overview && overview.totalCapacityBytes > 0
                    ? `${Math.min(100, (overview.usedCapacityBytes / overview.totalCapacityBytes) * 100)}%`
                    : '0%',
              }}
            />
          </div>
        </div>

        <div className="metric-card">
          <div className="metric-card-header">
            <span className="metric-title">STORED CHUNKS</span>
            <span className="metric-icon">📦</span>
          </div>
          <div className="metric-value">
            {overview?.storedChunkCount ?? '—'}
            <span className="metric-unit">chunks</span>
          </div>
          <div className="metric-subtext">
            {overview ? `${overview.activeReplicaCount} active replicas (2x target)` : '—'}
          </div>
        </div>

        <div className="metric-card">
          <div className="metric-card-header">
            <span className="metric-title">REPLICATION HEALTH</span>
            <span className="metric-icon">🛡️</span>
          </div>
          <div className="metric-value">
            {overview ? (
              overview.underReplicatedChunkCount === 0 ? (
                <span className="color-success">100%</span>
              ) : (
                <span className="color-warn">{overview.underReplicatedChunkCount}</span>
              )
            ) : (
              '—'
            )}
          </div>
          <div className="metric-subtext">
            {overview?.underReplicatedChunkCount === 0
              ? 'All chunks fully replicated'
              : 'Chunks under-replicated (< 2 healthy replicas)'}
          </div>
        </div>
      </section>

      {/* Storage Nodes Detail Cards */}
      <section className="cluster-section" aria-label="Storage Nodes Status">
        <div className="cluster-section-header">
          <h2 className="cluster-section-title">Cluster Storage Nodes</h2>
          <span className="cluster-section-count">{nodes.length} Configured</span>
        </div>

        <div className="node-cards-grid">
          {nodes.length === 0 && !loading && (
            <div className="empty-panel">No storage nodes registered in cluster.</div>
          )}

          {nodes.map((node) => {
            const isHealthy = node.status === 'HEALTHY';
            const isUnhealthy = node.status === 'UNHEALTHY';
            const isUnavailable = node.status === 'UNAVAILABLE';
            const percentUsed =
              node.totalCapacityBytes > 0
                ? Math.min(100, (node.usedCapacityBytes / node.totalCapacityBytes) * 100)
                : 0;

            return (
              <div
                key={node.nodeId}
                className={`node-card ${
                  isHealthy
                    ? 'node-card-healthy'
                    : isUnhealthy
                    ? 'node-card-unhealthy'
                    : 'node-card-unavailable'
                }`}
              >
                <div className="node-card-header">
                  <div className="node-card-title">
                    <span className="node-icon">🖥️</span>
                    <div>
                      <div className="node-id">{node.nodeId}</div>
                      <div className="node-sublabel">PC LAN Storage Daemon</div>
                    </div>
                  </div>
                  <span
                    className={`status-pill ${
                      isHealthy
                        ? 'status-pill-success'
                        : isUnhealthy
                        ? 'status-pill-warn'
                        : 'status-pill-error'
                    }`}
                  >
                    <span className="status-pill-dot" />
                    {node.status}
                  </span>
                </div>

                <div className="node-stats-grid">
                  <div className="node-stat-item">
                    <span className="node-stat-label">LAST HEARTBEAT</span>
                    <span
                      className={`node-stat-value ${
                        node.lastHeartbeatAgeMs < 6000
                          ? 'color-success'
                          : node.lastHeartbeatAgeMs < 15000
                          ? 'color-warn'
                          : 'color-error'
                      }`}
                    >
                      {formatHeartbeatAge(node.lastHeartbeatAgeMs)}
                    </span>
                  </div>

                  <div className="node-stat-item">
                    <span className="node-stat-label">IN-FLIGHT OPS</span>
                    <span className="node-stat-value">{node.activeOperations}</span>
                  </div>

                  <div className="node-stat-item">
                    <span className="node-stat-label">STORED CHUNKS</span>
                    <span className="node-stat-value">{node.storedChunkCount}</span>
                  </div>

                  <div className="node-stat-item">
                    <span className="node-stat-label">REPLICA INSTANCES</span>
                    <span className="node-stat-value">{node.replicaCount}</span>
                  </div>
                </div>

                <div className="node-capacity-section">
                  <div className="node-capacity-header">
                    <span>CAPACITY UTILIZATION</span>
                    <span>
                      {formatBytes(node.usedCapacityBytes)} / {formatBytes(node.totalCapacityBytes)}{' '}
                      ({percentUsed.toFixed(1)}%)
                    </span>
                  </div>
                  <div className="node-capacity-bar">
                    <div
                      className={`node-capacity-fill ${
                        percentUsed > 90
                          ? 'node-capacity-danger'
                          : percentUsed > 75
                          ? 'node-capacity-warn'
                          : ''
                      }`}
                      style={{ width: `${percentUsed}%` }}
                    />
                  </div>
                </div>

                <div className="node-card-footer">
                  <span className="node-footer-timestamp">
                    Timestamp:{' '}
                    {node.lastHeartbeat ? new Date(node.lastHeartbeat).toLocaleTimeString() : 'N/A'}
                  </span>
                </div>
              </div>
            );
          })}
        </div>
      </section>

      {/* Transfer Replica Placement Inspector */}
      <section className="cluster-section" aria-label="Transfer Replica Placement">
        <div className="cluster-section-header">
          <div>
            <h2 className="cluster-section-title">Transfer Replica Placement &amp; Persistence</h2>
            <p className="cluster-section-desc">
              Inspect on-disk chunk replica assignments and failover availability across PC LAN nodes
            </p>
          </div>
          <span className="cluster-section-count">{transfers.length} Active Transfers</span>
        </div>

        {transfers.length === 0 ? (
          <div className="empty-panel">
            No active transfers in the cluster. Upload a file from the Transfers tab to inspect chunk replicas.
          </div>
        ) : (
          <div className="placement-container">
            {/* Transfer Selector List */}
            <div className="transfer-selector-list">
              <span className="selector-title">SELECT TRANSFER</span>
              {transfers.map((t) => {
                const isSelected = t.fileId === selectedFileId;
                return (
                  <button
                    key={t.fileId}
                    type="button"
                    className={`transfer-select-card ${isSelected ? 'active' : ''}`}
                    onClick={() => setSelectedFileId(t.fileId)}
                  >
                    <div className="transfer-card-top">
                      <span className="transfer-id-mono">{t.fileId.slice(0, 12)}...</span>
                      <span
                        className={`status-pill ${
                          t.status === 'READY' ? 'status-pill-success' : 'status-pill-warn'
                        }`}
                      >
                        {t.status}
                      </span>
                    </div>
                    <div className="transfer-card-meta">
                      <span>{formatBytes(t.totalSizeBytes)}</span>
                      <span>·</span>
                      <span>
                        {t.chunkCount} {t.chunkCount === 1 ? 'chunk' : 'chunks'}
                      </span>
                      <span>·</span>
                      <span>
                        DL: {t.downloadCount}/{t.maxDownloads}
                      </span>
                    </div>
                    {t.isDegraded ? (
                      <div className="degraded-badge">⚠️ Under-Replicated</div>
                    ) : (
                      <div className="healthy-badge">✓ 2x Replicated</div>
                    )}
                  </button>
                );
              })}
            </div>

            {/* Selected Transfer Details & Chunk Breakdown */}
            <div className="placement-detail-panel">
              {loadingDetail && !transferDetail ? (
                <div className="empty-panel">Loading chunk placement metadata...</div>
              ) : !transferDetail ? (
                <div className="empty-panel">
                  Select a transfer on the left to inspect its chunk replicas.
                </div>
              ) : (
                <div className="transfer-detail-content">
                  <div className="transfer-detail-header">
                    <div>
                      <div className="transfer-detail-fileid">
                        <span className="label-mono">FILE ID:</span>
                        <code className="code-id">{transferDetail.fileId}</code>
                      </div>
                      <div className="transfer-detail-sub">
                        <span>
                          Status: <strong className="color-success">{transferDetail.status}</strong>
                        </span>
                        <span>·</span>
                        <span>
                          Total: <strong>{formatBytes(transferDetail.totalSizeBytes)}</strong>
                        </span>
                        <span>·</span>
                        <span>
                          Chunks: <strong>{transferDetail.chunkCount}</strong>
                        </span>
                      </div>
                    </div>
                  </div>

                  {/* Chunks Table */}
                  <div className="chunks-table-wrapper">
                    <table className="chunks-table">
                      <thead>
                        <tr>
                          <th>INDEX</th>
                          <th>CHUNK ID</th>
                          <th>SIZE</th>
                          <th>CHECKSUM</th>
                          <th>REPLICA PLACEMENT</th>
                          <th>REPLICATION HEALTH</th>
                        </tr>
                      </thead>
                      <tbody>
                        {transferDetail.chunks.map((chk: ClusterChunkDetail) => {
                          const isFullyReplicated = chk.activeReplicaCount >= chk.expectedReplicaCount;
                          const isDegraded = chk.activeReplicaCount === 1;
                          const isCritical = chk.activeReplicaCount === 0;

                          return (
                            <tr key={chk.chunkId}>
                              <td>
                                <span className="chunk-index-badge">#{chk.chunkIndex}</span>
                              </td>
                              <td>
                                <code className="code-chunk-id">{chk.chunkId}</code>
                              </td>
                              <td>{formatBytes(chk.sizeBytes)}</td>
                              <td>
                                <code className="code-hash" title={chk.checksumSha256}>
                                  {chk.checksumSha256.slice(0, 10)}...
                                </code>
                              </td>
                              <td>
                                <div className="replica-tags-cell">
                                  {chk.replicas.map((rep) => {
                                    const nodeIsHealthy = rep.nodeStatus === 'HEALTHY';
                                    return (
                                      <span
                                        key={rep.nodeId}
                                        className={`replica-node-pill ${
                                          nodeIsHealthy
                                            ? 'replica-pill-healthy'
                                            : 'replica-pill-down'
                                        }`}
                                      >
                                        <span className="replica-node-name">{rep.nodeId}</span>
                                        <span className="replica-status-tag">
                                          ({rep.nodeStatus})
                                        </span>
                                      </span>
                                    );
                                  })}
                                </div>
                              </td>
                              <td>
                                <span
                                  className={`status-pill ${
                                    isFullyReplicated
                                      ? 'status-pill-success'
                                      : isDegraded
                                      ? 'status-pill-warn'
                                      : 'status-pill-error'
                                  }`}
                                >
                                  {isFullyReplicated
                                    ? `2/2 Replicated`
                                    : isDegraded
                                    ? `1/2 Under-replicated`
                                    : `0/2 All Replicas Down`}
                                </span>
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}
            </div>
          </div>
        )}
      </section>

      {/* Cluster Real Event Timeline */}
      <section className="cluster-section" aria-label="Cluster Event Timeline">
        <div className="cluster-section-header">
          <div>
            <h2 className="cluster-section-title">Cluster Event Timeline</h2>
            <p className="cluster-section-desc">
              Real-time cluster state transitions: heartbeat health, read failover, replication, and sweeper operations
            </p>
          </div>
          <div className="event-filter-tabs">
            <button
              type="button"
              className={`filter-tab ${eventFilter === 'ALL' ? 'active' : ''}`}
              onClick={() => setEventFilter('ALL')}
            >
              All ({events.length})
            </button>
            <button
              type="button"
              className={`filter-tab ${eventFilter === 'HEALTH' ? 'active' : ''}`}
              onClick={() => setEventFilter('HEALTH')}
            >
              Health
            </button>
            <button
              type="button"
              className={`filter-tab ${eventFilter === 'REPLICATION' ? 'active' : ''}`}
              onClick={() => setEventFilter('REPLICATION')}
            >
              Replication &amp; Failover
            </button>
            <button
              type="button"
              className={`filter-tab ${eventFilter === 'TRANSFERS' ? 'active' : ''}`}
              onClick={() => setEventFilter('TRANSFERS')}
            >
              Transfers
            </button>
          </div>
        </div>

        <div className="events-timeline-container">
          {filteredEvents.length === 0 ? (
            <div className="empty-panel">No cluster events recorded yet.</div>
          ) : (
            <div className="timeline-list">
              {filteredEvents.map((evt) => {
                const isWarn = evt.severity === 'WARN';
                const isError = evt.severity === 'ERROR';

                return (
                  <div key={evt.id} className="timeline-item">
                    <div className="timeline-badge-column">
                      <span
                        className={`timeline-dot ${
                          isError
                            ? 'timeline-dot-error'
                            : isWarn
                            ? 'timeline-dot-warn'
                            : 'timeline-dot-info'
                        }`}
                      />
                      <div className="timeline-line" />
                    </div>

                    <div className="timeline-content-card">
                      <div className="timeline-top-row">
                        <div className="timeline-event-identity">
                          <span
                            className={`status-pill ${
                              isError
                                ? 'status-pill-error'
                                : isWarn
                                ? 'status-pill-warn'
                                : 'status-pill-info'
                            }`}
                          >
                            {evt.severity}
                          </span>
                          <span className="timeline-event-type">{evt.eventType}</span>
                          {evt.nodeId && (
                            <span className="timeline-target-badge">
                              node: <strong>{evt.nodeId}</strong>
                            </span>
                          )}
                          {evt.fileId && (
                            <span className="timeline-target-badge">
                              file: <strong>{evt.fileId.slice(0, 8)}...</strong>
                            </span>
                          )}
                        </div>

                        <span className="timeline-time">
                          {new Date(evt.createdAt).toLocaleTimeString()}
                        </span>
                      </div>

                      <div className="timeline-details-text">
                        {formatEventDetails(evt)}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </section>

      {/* Demo Help & Outage Control Guidance Panel */}
      <section className="cluster-demo-guide" aria-label="3-PC LAN Demo Controls">
        <div
          className="demo-guide-header"
          role="button"
          tabIndex={0}
          onClick={() => setShowDemoGuide(!showDemoGuide)}
          onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && setShowDemoGuide(!showDemoGuide)}
        >
          <div className="demo-guide-title">
            <span>🎮 3-PC LAN Live Demo Instructions &amp; Terminal Controls</span>
            <span className="demo-guide-badge">Zero Mocking · Real Processes</span>
          </div>
          <button type="button" className="demo-guide-toggle">
            {showDemoGuide ? 'Hide Guide ▲' : 'Show Guide ▼'}
          </button>
        </div>

        {showDemoGuide && (
          <div className="demo-guide-body">
            <div className="demo-step-card">
              <div className="demo-step-number">STEP 1</div>
              <div className="demo-step-title">Upload a File (PC A)</div>
              <p className="demo-step-desc">
                From the <strong>Transfers</strong> tab, upload any file. Watch it split into chunks and dual-replicate to both PC B (<code>node-1</code>) and PC C (<code>node-2</code>) on-disk.
              </p>
            </div>

            <div className="demo-step-card">
              <div className="demo-step-number">STEP 2</div>
              <div className="demo-step-title">Simulate Storage Outage (PC B)</div>
              <p className="demo-step-desc">
                On PC B terminal, press <code>Ctrl+C</code> on the storage daemon process. Watch the dashboard update:
                status turns to <span className="color-warn">UNHEALTHY</span> after 6s and <span className="color-error">UNAVAILABLE</span> after 12s, recording a <code>HEALTH_TRANSITION</code> event.
              </p>
            </div>

            <div className="demo-step-card">
              <div className="demo-step-number">STEP 3</div>
              <div className="demo-step-title">Verify Seamless Failover Read</div>
              <p className="demo-step-desc">
                Download the file using your retrieval code. The coordinator detects PC B is offline and automatically streams the chunk replica from PC C. A <code>FAILOVER_READ</code> event appears in the timeline.
              </p>
            </div>

            <div className="demo-step-card">
              <div className="demo-step-number">STEP 4</div>
              <div className="demo-step-title">Restore Node &amp; Observe Re-sync</div>
              <p className="demo-step-desc">
                On PC B terminal, restart the daemon (<code>pnpm run dev:node</code>). Once the next heartbeat arrives, status transitions back to <span className="color-success">HEALTHY</span> and the reconciler/recovery worker triggers automatically.
              </p>
            </div>
          </div>
        )}
      </section>
    </div>
  );
}
