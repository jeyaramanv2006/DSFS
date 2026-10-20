# VoidShare

<div align="center">

```
  _  _       _      _  ___  _                       
 | || | ___ (_)  __| |/ __|| |_   __ _  _ _  ___    
 | || |/ _ \| | / _` |\__ \| ' \ / _` || '_|/ -_)   
  \_/  \___/|_| \__,_||___/|_||_|\__,_||_|  \___|   
```

**Peer-Replicated, Zero-Knowledge Distributed File Storage with Transparent Read Failover, Consistent Hashing, and Autonomous Health Telemetry.**

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg?style=flat-square)](LICENSE)
[![Build & Tests](https://img.shields.io/badge/tests-108%20passed-2ea44f.svg?style=flat-square)](#2-run-test-suite)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.7-blue.svg?style=flat-square&logo=typescript)](https://www.typescriptlang.org/)
[![Fastify](https://img.shields.io/badge/Fastify-v5-000000.svg?style=flat-square&logo=fastify)](https://fastify.dev/)
[![React](https://img.shields.io/badge/React-19-61dafb.svg?style=flat-square&logo=react)](https://react.dev/)
[![Vite](https://img.shields.io/badge/Vite-v8-646cff.svg?style=flat-square&logo=vite)](https://vitejs.dev/)
[![Security](https://img.shields.io/badge/Security-AES--256--GCM%20Zero--Knowledge-critical.svg?style=flat-square)](#-security--zero-knowledge-cryptography)
[![Replication](https://img.shields.io/badge/Replication-RF%3D2%20Confirmed%20Quorum-purple.svg?style=flat-square)](#-distributed-systems--replication-quorum)

</div>

---

## 📸 Application Showcase

### 1. Real-Time Cluster Operations Console (`/cluster`)
Live topology health monitoring, storage capacity telemetry, per-chunk replica distribution, and cluster event timeline.
![Cluster Operations Console](assets/dashboard-overview.png)

### 2. Client-Side Encrypted File Ingestion
Sleek glassmorphism upload wizard with in-browser WebCrypto AES-256-GCM chunking, download quotas (1 to 100), and auto-expiration (1h to 48h).
![Send a File Wizard](assets/upload-interface.png)

### 3. Capability-Based Code Retrieval
Dual access modes: recipients can retrieve transfers using direct share links or unpadded 43-character URL-safe Base64 retrieval codes with pre-flight metadata preview.
![Retrieval Code Access](assets/retrieval-code.png)

### 4. Minimalist Dark Landing Interface
Intuitive split-intent entry mode with real-time cluster status banner and zero-knowledge privacy guarantees.
![VoidShare Landing Page](assets/landing-home.png)

---

## ⚡ Key Features

- **🔒 Client-Side Zero-Knowledge Encryption:** Files are partitioned into 4MiB blocks and encrypted client-side using AES-256-GCM with fresh 12-byte random IVs per chunk. The master secret stays exclusively in the client's URL fragment (`#secret`) or 43-character retrieval code (`vs1-...`); the coordinator and storage nodes never receive or store the encryption key.
- **🔄 Consistent Ring Placement & Confirmed Dual Writes ($RF=2$):** Chunks are mapped across storage nodes using a consistent hash ring with virtual nodes. The coordinator enforces strict ingestion consistency: writes must be confirmed by **both** storage nodes before marking a chunk `STORED` and presenting the transfer as `READY`.
- **💓 Autonomous Failure Detection:** Storage daemons emit periodic authenticated heartbeats (every 3000ms). The coordinator's autonomous `HealthMonitor` loop continuously audits nodes:
  - `HEALTHY`: Heartbeat age $\le 5000\text{ms}$.
  - `UNHEALTHY`: Heartbeat age between $5000\text{ms}$ and $10000\text{ms}$.
  - `UNAVAILABLE`: Heartbeat age $> 10000\text{ms}$.
- **🛡️ Transparent Replica Read Failover:** If a primary storage node crashes or network partition occurs mid-download, `ReplicaReadService` catches the connection refusal and automatically fails over to the surviving replica node. Recipients experience uninterrupted, non-corrupted file streaming.
- **🔑 Dual Access Capabilities (Links & Codes):** Senders receive both direct URLs and 43-character URL-safe Base64 capability codes. Recipients can preview file size, MIME type, and expiration before initiating downloads without consuming quota.
- **🧹 Automated Expiration & Orphan Resilience:** Background workers enforce download limits and TTL expiration. When nodes are offline during a deletion sweep, lingering chunks are marked `ORPHANED_PENDING_DELETE` and purged automatically once the node recovers.
- **📊 Real-Time Observability:** Dedicated `/cluster` dashboard displays active nodes, disk capacity utilization, per-chunk replica placement, and a persisted SQLite event stream (`cluster_events`).

---

## 🏗️ System Architecture

```mermaid
flowchart TD
    subgraph Client["Sender & Receiver Browsers"]
        UI["React 19 + Vite UI"]
        Crypto["WebCrypto AES-256-GCM<br/>(4MB Chunks + Random IV)"]
        Code["43-Char Retrieval Code<br/>(Capability Hash)"]
    end

    subgraph Coordinator["Coordinator Service (:8080)"]
        API["Fastify API Server"]
        DB[(SQLite Metadata<br/>Ring + Replicas + Events)]
        Ring["Consistent Hash Ring (RF=2)"]
        Health["Autonomous HealthMonitor"]
        Failover["ReplicaReadService"]
        Sweeper["ExpirationSweeper & Reconciler"]
    end

    subgraph StorageNodes["Independent Storage Daemons (:9001, :9002)"]
        Node1["Storage Node 1<br/>- Encrypted Chunks<br/>- Heartbeat Emitter"]
        Node2["Storage Node 2<br/>- Encrypted Chunks<br/>- Heartbeat Emitter"]
    end

    UI -->|1. Encrypt Chunks Locally| Crypto
    Crypto -->|2. POST /api/transfers| API
    API -->|3. Consistent Hashing| Ring
    API -->|4. Replicate Chunk (Bearer Auth)| Node1
    API -->|4. Replicate Chunk (Bearer Auth)| Node2
    Node1 -.->|Heartbeats (3000ms)| Health
    Node2 -.->|Heartbeats (3000ms)| Health
    Health -->|State Transitions| DB
    Failover -->|Failover Read on Outage| Node2
```

---

## 📦 Monorepo Package Layout

VoidShare is organized as an npm workspaces monorepo:

| Package | Path | Responsibility |
|---|---|---|
| **`@voidshare/shared`** | [`packages/shared`](packages/shared) | AES-256-GCM cryptography, 43-char capability token encoding/decoding, Zod validation schemas, and common types. |
| **`@voidshare/storage-node`** | [`packages/storage-node`](packages/storage-node) | Lightweight encrypted chunk daemon, constant-time bearer token auth, incremental capacity accounting, and periodic heartbeat emitter. |
| **`@voidshare/api`** | [`packages/api`](packages/api) | Fastify coordinator, SQLite metadata engine, consistent hash ring placement, autonomous health monitor, replica read failover, and background workers. |
| **`@voidshare/web`** | [`packages/web`](packages/web) | React 19 frontend with glassmorphism UI, client-side streaming encryption/decryption, and `/cluster` operations console. |
| **`@voidshare/cli`** | [`packages/cli`](packages/cli) | Programmatic client for uploading, retrieving, and executing multi-machine integration tests. |

---

## 🛡️ Security & Zero-Knowledge Cryptography

VoidShare implements an absolute zero-knowledge security boundary:

1. **Client-Side Key Generation:**
   - The browser generates a cryptographically secure 32-byte master key using `window.crypto.getRandomValues()`.
   - The key is encoded into an unpadded 43-character URL-safe Base64 token (`vs1-...`) or stored in the URL fragment (`#<hex>`). URL fragments are never transmitted over HTTP requests to the coordinator.
2. **Chunk Partitioning & Encryption:**
   - Files are sliced into 4MiB blocks.
   - Each chunk is encrypted client-side using **AES-256-GCM** with a distinct 12-byte cryptographically random Initialization Vector (IV) and produces a 16-byte authentication tag.
   - Even if multiple chunks have identical plaintext, their ciphertexts are completely distinct.
3. **Capability Authentication:**
   - The client derives a capability token hash via `SHA-256(secret)`.
   - The coordinator only verifies the SHA-256 capability hash to grant download permission. Neither the coordinator nor the storage daemons ever possess the decryption key.
4. **Internal Cluster Authentication:**
   - Communication between the Coordinator and Storage Daemons requires a pre-shared 32-byte hexadecimal secret (`STORAGE_CLUSTER_SECRET`).
   - All internal HTTP requests validate this bearer token using constant-time comparison (`crypto.timingSafeEqual`) to prevent timing attacks.

---

## 🌐 Distributed Systems & Replication Quorum

1. **Consistent Hash Ring ($RF=2$):**
   - The coordinator maintains an in-memory hash ring with 100 virtual nodes per storage daemon.
   - For every chunk, its SHA-256 digest determines its primary position on the ring. The primary replica and secondary replica are assigned to distinct physical storage daemons.
2. **Confirmed Dual-Write Consistency:**
   - During file ingestion, chunks are concurrently uploaded to both designated replica storage nodes.
   - The coordinator requires HTTP 200 confirmations from **both** storage nodes before marking a chunk `STORED`.
   - A transfer only transitions to `READY` once 100% of chunks achieve confirmed dual replication.
3. **Autonomous Health Telemetry:**
   - Storage nodes emit authenticated heartbeats (`POST /api/nodes/heartbeat`) every `3000ms`, reporting total capacity, used capacity, and active operations.
   - The coordinator's `HealthMonitor` loop audits nodes every `2000ms`:
     - **`HEALTHY`**: Last heartbeat $\le 5\text{s}$.
     - **`UNHEALTHY`**: Last heartbeat between $5\text{s}$ and $10\text{s}$.
     - **`UNAVAILABLE`**: Last heartbeat $> 10\text{s}$.
4. **Transparent Replica Read Failover:**
   - When a recipient downloads a chunk, `ReplicaReadService` routes the read request to the healthiest replica node.
   - If that node terminates or suffers a network partition, the coordinator intercepts the socket error, records a `READ_FAILOVER_SUCCEEDED` event in the audit log, and immediately fetches the chunk from the surviving replica node.
   - Client downloads stream continuously without dropped bytes or decipher errors.
5. **Garbage Collection & Orphan Resilience:**
   - When download limits are exhausted or transfer TTL expires, the transfer enters `CONSUMED`.
   - The background `ExpirationSweeper` sends chunk purge commands to both nodes.
   - If a node is unreachable during a sweep, its chunks are flagged `ORPHANED_PENDING_DELETE`. When the node recovers and heartbeats, the background reconciler purges the orphaned chunks.

---

## 📡 Core API Reference

### Coordinator API (`:8080`)

| Method | Endpoint | Description |
|---|---|---|
| `POST` | `/api/transfers` | Initialize transfer, create session token, derive capability hash |
| `PUT` | `/api/transfers/:fileId/chunks/:chunkIndex` | Upload encrypted chunk; coordinates dual replication to storage nodes |
| `POST` | `/api/transfers/:fileId/complete` | Finalize transfer after all chunks confirmed |
| `POST` | `/api/transfers/resolve` | Verify capability token/hash and return file metadata preview |
| `GET` | `/api/transfers/:fileId/chunks/:chunkIndex` | Stream chunk with automatic replica read failover |
| `GET` | `/api/cluster/overview` | Cluster statistics, aggregate storage capacity, chunk counts |
| `GET` | `/api/cluster/nodes` | Live status, health telemetry, and heartbeat ages for all nodes |
| `GET` | `/api/cluster/transfers` | Transfer list with per-chunk replica distribution |
| `GET` | `/api/cluster/events` | Chronological event stream (`cluster_events`) |
| `POST` | `/api/nodes/heartbeat` | Ingest heartbeat telemetry from storage daemons (Bearer auth) |

### Storage Daemon Protocol (`:9001`, `:9002`)

| Method | Endpoint | Description |
|---|---|---|
| `PUT` | `/chunks/:chunkId` | Store raw encrypted chunk blob with SHA-256 integrity validation |
| `GET` | `/chunks/:chunkId` | Stream raw encrypted chunk blob back to coordinator |
| `DELETE` | `/chunks/:chunkId` | Delete chunk blob and reclaim allocated capacity |
| `GET` | `/health` | Daemon status, capacity accounting, and active operation count |

---

## 🚀 Getting Started

### Prerequisites
- **Node.js:** v20.0.0 or higher (v24 recommended)
- **npm:** v10.0.0 or higher
- **Git**

### 1. Installation
Clone the repository and install all workspace dependencies:
```bash
git clone https://github.com/jeyaramanv2006/DSFS.git
cd DSFS
npm install
```

### 2. Run Test Suite
Run the full automated test suite across all packages (21 test files, 108 tests):
```bash
npm test
```

### 3. Production Build
Compile TypeScript across all workspaces and bundle the web client:
```bash
npm run build
```

### 4. Running Locally (Single Machine Cluster)
You can spin up a complete multi-node cluster on a single development machine:

```bash
# Terminal 1: Start 2 Storage Daemons on ports 9001 and 9002
npm run dev:nodes

# Terminal 2: Start Coordinator API on port 8080
npm run dev -w packages/api

# Terminal 3: Start React Web UI on port 5173
npm run dev -w packages/web
```
- Open **`http://localhost:5173`** to access the web application.
- Open **`http://localhost:5173/cluster`** to inspect the real-time cluster operations console.

---

## 🌐 Multi-Node Distributed LAN Deployment

VoidShare can be deployed across multiple physical computers on a local Wi-Fi or Ethernet network:

```
+--------------------------------------------------------------+
| COORDINATOR & WEB HOST (Host 1)                             |
| - Fastify API Server (:8080)                                 |
| - Vite Web Dashboard (:5173)                                 |
+--------------------------------------------------------------+
         |                                             |
         | Chunk Writes & Reads                        | Chunk Writes & Reads
         v                                             v
+-------------------------------+             +-------------------------------+
| STORAGE NODE 1 (Host 2)       |             | STORAGE NODE 2 (Host 3)       |
| - Storage Daemon (:9001)      |             | - Storage Daemon (:9001)      |
| - Data: ./data/node-1         |             | - Data: ./data/node-2         |
+-------------------------------+             +-------------------------------+
```

### Windows Firewall Configuration (PowerShell as Administrator)
If running on Windows machines, allow the respective ports through Windows Defender:

```powershell
# On Host 1 (Coordinator & Web UI):
New-NetFirewallRule -DisplayName "VoidShare API" -Direction Inbound -LocalPort 8080 -Protocol TCP -Action Allow
New-NetFirewallRule -DisplayName "VoidShare Web" -Direction Inbound -LocalPort 5173 -Protocol TCP -Action Allow

# On Host 2 & Host 3 (Storage Nodes):
New-NetFirewallRule -DisplayName "VoidShare Storage" -Direction Inbound -LocalPort 9001 -Protocol TCP -Action Allow
```

### Step-by-Step Multi-Machine Startup

1. **Host 2 (Storage Node 1):**
   ```powershell
   $env:NODE_ID="node-1"; $env:PORT="9001"; $env:COORDINATOR_URL="http://<HOST_1_IP>:8080"; $env:STORAGE_CLUSTER_SECRET="<SHARED_SECRET>"; npm run dev -w packages/storage-node
   ```
2. **Host 3 (Storage Node 2):**
   ```powershell
   $env:NODE_ID="node-2"; $env:PORT="9001"; $env:COORDINATOR_URL="http://<HOST_1_IP>:8080"; $env:STORAGE_CLUSTER_SECRET="<SHARED_SECRET>"; npm run dev -w packages/storage-node
   ```
3. **Host 1 (Coordinator API):**
   ```powershell
   $env:STORAGE_NODES="node-1=http://<HOST_2_IP>:9001,node-2=http://<HOST_3_IP>:9001"; $env:STORAGE_CLUSTER_SECRET="<SHARED_SECRET>"; npm run dev -w packages/api
   ```
4. **Host 1 (Web Dashboard):**
   ```powershell
   npm run dev -w packages/web
   ```

---

## ⚙️ Configuration & Environment Variables

### Coordinator API (`packages/api/.env`)

| Variable | Default | Description |
|---|---|---|
| `HOST` | `0.0.0.0` | Host interface to bind API server |
| `PORT` | `8080` | Port for the Coordinator Fastify API |
| `DB_PATH` | `./data/metadata.db` | Path to SQLite metadata database |
| `STORAGE_NODES` | `node-1=http://localhost:9001,node-2=http://localhost:9002` | Comma-separated list of storage node endpoints |
| `STORAGE_CLUSTER_SECRET` | *(required)* | Pre-shared 32-byte hex secret for internal service auth |
| `HEALTH_MONITOR_INTERVAL_MS` | `2000` | Frequency of node health evaluation loop |
| `HEARTBEAT_UNHEALTHY_MS` | `5000` | Heartbeat latency threshold to mark node `UNHEALTHY` |
| `HEARTBEAT_UNAVAILABLE_MS` | `10000` | Heartbeat latency threshold to mark node `UNAVAILABLE` |

### Storage Node (`packages/storage-node/.env`)

| Variable | Default | Description |
|---|---|---|
| `NODE_ID` | `node-1` | Unique identifier for this storage daemon |
| `HOST` | `0.0.0.0` | Host interface to bind chunk server |
| `PORT` | `9001` | Storage daemon HTTP port |
| `DATA_DIR` | `./data/node-1` | Local directory for storing encrypted chunks |
| `COORDINATOR_URL` | `http://localhost:8080` | URL of the central Coordinator API |
| `STORAGE_CLUSTER_SECRET` | *(required)* | Must match Coordinator's `STORAGE_CLUSTER_SECRET` |
| `TOTAL_CAPACITY_BYTES` | `10737418240` | Total disk quota allocated for this node (10 GB) |
| `HEARTBEAT_INTERVAL_MS` | `3000` | Frequency of heartbeat pings to Coordinator |

---

## 📄 License

This project is licensed under the MIT License. See [LICENSE](LICENSE) for details.
