import React, { useEffect, useRef, useState } from 'react';
import {
  fetchClusterNodes,
  fetchClusterOverview,
  type ClusterNodeInfo,
  type ClusterOverview,
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

export function ClusterDashboard() {
  const [overview, setOverview] = useState<ClusterOverview | null>(null);
  const [nodes, setNodes] = useState<ClusterNodeInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const isFetchingRef = useRef(false);

  const pollData = async (signal?: AbortSignal) => {
    if (isFetchingRef.current) return;
    isFetchingRef.current = true;
    try {
      const [overviewData, nodesData] = await Promise.all([
        fetchClusterOverview(signal),
        fetchClusterNodes(signal),
      ]);
      setOverview(overviewData);
      setNodes(nodesData);
      setLastUpdated(new Date());
      setError(null);
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') return;
      setError(err instanceof Error ? err.message : 'Failed to connect to cluster API');
    } finally {
      isFetchingRef.current = false;
      setLoading(false);
    }
  };

  useEffect(() => {
    const controller = new AbortController();
    void pollData(controller.signal);

    const intervalId = setInterval(() => {
      void pollData(controller.signal);
    }, 2000);

    return () => {
      controller.abort();
      clearInterval(intervalId);
    };
  }, []);

  return (
    <div className="cluster-view">
      <header className="cluster-header">
        <div className="cluster-header-main">
          <div className="cluster-header-title-row">
            <span className="cluster-badge-tag">TOPOLOGY OBSERVABILITY</span>
            <div className="cluster-live-indicator">
              <span className={`live-dot ${error ? 'live-dot-error' : 'live-dot-pulse'}`} />
              <span className="live-label">
                {error ? 'CONNECTION DEGRADED' : 'LIVE TELEMETRY (2s)'}
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
              Updated: {lastUpdated.toLocaleTimeString()}
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

      {error && (
        <div className="cluster-alert cluster-alert-error" role="alert">
          <div className="cluster-alert-icon">⚠️</div>
          <div className="cluster-alert-content">
            <strong>Coordinator API Unreachable:</strong> {error}. Showing last known state.
          </div>
        </div>
      )}

      {/* Cluster Overview Metrics */}
      <section className="cluster-metrics-grid" aria-label="Cluster Metrics Overview">
        {/* Card 1: Node Health */}
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

        {/* Card 2: Cluster Capacity */}
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
                width: overview && overview.totalCapacityBytes > 0
                  ? `${Math.min(100, (overview.usedCapacityBytes / overview.totalCapacityBytes) * 100)}%`
                  : '0%',
              }}
            />
          </div>
        </div>

        {/* Card 3: Chunks & Replicas */}
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

        {/* Card 4: Under-replicated chunks */}
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
                  isHealthy ? 'node-card-healthy' : isUnhealthy ? 'node-card-unhealthy' : 'node-card-unavailable'
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
                      {formatBytes(node.usedCapacityBytes)} / {formatBytes(node.totalCapacityBytes)} ({percentUsed.toFixed(1)}%)
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
                    Timestamp: {node.lastHeartbeat ? new Date(node.lastHeartbeat).toLocaleTimeString() : 'N/A'}
                  </span>
                </div>
              </div>
            );
          })}
        </div>
      </section>
    </div>
  );
}
