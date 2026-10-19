export interface ClusterOverview {
  totalNodes: number;
  healthyNodes: number;
  unhealthyNodes: number;
  unavailableNodes: number;
  totalCapacityBytes: number;
  usedCapacityBytes: number;
  storedChunkCount: number;
  activeReplicaCount: number;
  underReplicatedChunkCount: number;
}

export interface ClusterNodeInfo {
  nodeId: string;
  status: 'HEALTHY' | 'UNHEALTHY' | 'UNAVAILABLE' | string;
  lastHeartbeat: string;
  lastHeartbeatAgeMs: number;
  totalCapacityBytes: number;
  usedCapacityBytes: number;
  activeOperations: number;
  storedChunkCount: number;
  replicaCount: number;
}

export interface ClusterTransferSummary {
  fileId: string;
  status: string;
  chunkCount: number;
  chunkSizeBytes: number;
  totalSizeBytes: number;
  downloadCount: number;
  maxDownloads: number;
  createdAt: string;
  expiresAt: string;
  isDegraded: boolean;
}

export interface ClusterChunkReplicaInfo {
  nodeId: string;
  status: string;
  nodeStatus: string;
}

export interface ClusterChunkDetail {
  chunkId: string;
  chunkIndex: number;
  sizeBytes: number;
  checksumSha256: string;
  status: string;
  expectedReplicaCount: number;
  activeReplicaCount: number;
  replicas: ClusterChunkReplicaInfo[];
}

export interface ClusterTransferDetail {
  fileId: string;
  status: string;
  totalSizeBytes: number;
  chunkCount: number;
  createdAt: string;
  expiresAt: string;
  chunks: ClusterChunkDetail[];
}

export interface ClusterEvent {
  id: string;
  eventType: string;
  severity: 'INFO' | 'WARN' | 'ERROR';
  nodeId: string | null;
  fileId: string | null;
  details: Record<string, unknown> | string | null;
  createdAt: string;
}

export async function fetchClusterOverview(signal?: AbortSignal): Promise<ClusterOverview> {
  const res = await fetch('/api/cluster/overview', { signal });
  if (!res.ok) throw new Error(`Overview fetch failed: ${res.status}`);
  return res.json();
}

export async function fetchClusterNodes(signal?: AbortSignal): Promise<ClusterNodeInfo[]> {
  const res = await fetch('/api/cluster/nodes', { signal });
  if (!res.ok) throw new Error(`Nodes fetch failed: ${res.status}`);
  const data = await res.json();
  return data.nodes;
}

export async function fetchClusterTransfers(limit = 20, signal?: AbortSignal): Promise<ClusterTransferSummary[]> {
  const res = await fetch(`/api/cluster/transfers?limit=${limit}`, { signal });
  if (!res.ok) throw new Error(`Transfers fetch failed: ${res.status}`);
  const data = await res.json();
  return data.transfers;
}

export async function fetchTransferChunks(fileId: string, signal?: AbortSignal): Promise<ClusterTransferDetail> {
  const res = await fetch(`/api/cluster/transfers/${encodeURIComponent(fileId)}/chunks`, { signal });
  if (!res.ok) throw new Error(`Transfer chunks fetch failed: ${res.status}`);
  return res.json();
}

export async function fetchClusterEvents(
  options?: { limit?: number; afterId?: string },
  signal?: AbortSignal,
): Promise<ClusterEvent[]> {
  const params = new URLSearchParams();
  if (options?.limit) params.set('limit', String(options.limit));
  if (options?.afterId) params.set('afterId', options.afterId);
  const res = await fetch(`/api/cluster/events?${params.toString()}`, { signal });
  if (!res.ok) throw new Error(`Events fetch failed: ${res.status}`);
  const data = await res.json();
  return data.events;
}
