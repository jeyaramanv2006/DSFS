# VoidShare (DSFS)

<div align="center">

```
  _  _       _      _  ___  _                       
 | || | ___ (_)  __| |/ __|| |_   __ _  _ _  ___    
 | || |/ _ \| | / _` |\__ \| ' \ / _` || '_|/ -_)   
  \_/  \___/|_| \__,_||___/|_||_|\__,_||_|  \___|   
```

**Peer-Replicated, Zero-Knowledge Distributed File Storage with Transparent Read Failover, Consistent Hashing, and Autonomous Health Telemetry.**

[![Build & Tests](https://img.shields.io/badge/tests-108%20passed-2ea44f.svg?style=flat-square)](docs/V1_IMPLEMENTATION_STATUS.md)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.7-blue.svg?style=flat-square&logo=typescript)](https://www.typescriptlang.org/)
[![Fastify](https://img.shields.io/badge/Fastify-v5-000000.svg?style=flat-square&logo=fastify)](https://fastify.dev/)
[![React](https://img.shields.io/badge/React-19-61dafb.svg?style=flat-square&logo=react)](https://react.dev/)
[![Vite](https://img.shields.io/badge/Vite-v8-646cff.svg?style=flat-square&logo=vite)](https://vitejs.dev/)
[![Security](https://img.shields.io/badge/Security-AES--256--GCM%20Zero--Knowledge-critical.svg?style=flat-square)](docs/SECURITY.md)
[![Replication](https://img.shields.io/badge/Replication-RF%3D2%20Confirmed%20Quorum-purple.svg?style=flat-square)](docs/DISTRIBUTED_SYSTEMS.md)

</div>

---

## 📸 Application Showcase

### 1. Real-Time Cluster Operations Console (`/cluster`)
Live topology health monitoring, storage capacity telemetry, per-chunk replica distribution, and cluster event timeline.
![Cluster Operations Console](docs/assets/dashboard-overview.png)

### 2. Client-Side Encrypted File Ingestion
Sleek glassmorphism upload wizard with in-browser WebCrypto AES-256-GCM chunking, download quotas (1 to 100), and auto-expiration (1h to 48h).
![Send a File Wizard](docs/assets/upload-interface.png)

### 3. Capability-Based Code Retrieval
Dual access modes: recipient can retrieve transfers using direct share links or unpadded 43-character URL-safe Base64 retrieval codes with pre-flight metadata preview.
![Retrieval Code Access](docs/assets/retrieval-code.png)

### 4. Minimalist Dark Landing Interface
Intuitive split-intent entry mode with real-time cluster status banner and zero-knowledge privacy guarantees.
![VoidShare Landing Page](docs/assets/landing-home.png)

---

## ⚡ Core Distributed Systems Highlights

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

    subgraph Coordinator["PC A: Coordinator (:8080)"]
        API["Fastify API Server"]
        DB[(SQLite Metadata<br/>Ring + Replicas + Events)]
        Ring["Consistent Hash Ring (RF=2)"]
        Health["Autonomous HealthMonitor"]
        Failover["ReplicaReadService"]
        Sweeper["ExpirationSweeper & Reconciler"]
    end

    subgraph StorageNodes["Independent Storage Daemons (:9001)"]
        Node1["PC B: Storage Node 1<br/>- Encrypted Chunks<br/>- Heartbeat Emitter"]
        Node2["PC C: Storage Node 2<br/>- Encrypted Chunks<br/>- Heartbeat Emitter"]
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

VoidShare is structured as an npm workspaces monorepo:

| Package | Path | Responsibility |
|---|---|---|
| **`@voidshare/shared`** | [`packages/shared`](packages/shared) | AES-256-GCM cryptography, 43-char capability token encoding/decoding, Zod validation schemas, and common types. |
| **`@voidshare/storage-node`** | [`packages/storage-node`](packages/storage-node) | Lightweight encrypted chunk daemon, constant-time bearer token auth, incremental capacity accounting, and periodic heartbeat emitter. |
| **`@voidshare/api`** | [`packages/api`](packages/api) | Fastify coordinator, SQLite metadata engine, consistent hash ring placement, autonomous health monitor, replica read failover, and background workers. |
| **`@voidshare/web`** | [`packages/web`](packages/web) | React 19 frontend with glassmorphism UI, client-side streaming encryption/decryption, and `/cluster` operations console. |
| **`@voidshare/cli`** | [`packages/cli`](packages/cli) | Programmatic client for uploading, retrieving, and executing multi-machine integration tests. |

---

## 🚀 Quickstart & Local Development

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
Run the full test suite across all packages (21 test files, 108 tests):
```bash
npm test
```

### 3. Production Build
Compile TypeScript across all workspaces and bundle the web client:
```bash
npm run build
```

### 4. Running a Local 3-Process Cluster (Single Machine)
You can run a complete multi-node cluster on a single development machine:

```bash
# Terminal 1: Run 2 Storage Daemons on ports 9001 and 9002
npm run dev:nodes

# Terminal 2: Run Coordinator API on port 8080
npm run dev -w packages/api

# Terminal 3: Run React Web UI on port 5173
npm run dev -w packages/web
```
Open **`http://localhost:5173`** in your browser to upload files, and **`http://localhost:5173/cluster`** to monitor cluster telemetry!

---

## 🌐 Three-PC Physical LAN Deployment

For live distributed demonstrations across three separate physical computers:

```
+--------------------------------------------------------------+
| PC A: COORDINATOR & WEB HOST                                 |
| IP: 192.168.1.100                                            |
| - Fastify API (:8080)                                        |
| - Vite Web UI (:5173)                                        |
+--------------------------------------------------------------+
         |                                             |
         | Chunk Writes & Reads                        | Chunk Writes & Reads
         v                                             v
+-------------------------------+             +-------------------------------+
| PC B: STORAGE NODE 1          |             | PC C: STORAGE NODE 2          |
| IP: 192.168.1.101             |             | IP: 192.168.1.102             |
| - Storage Daemon (:9001)      |             | - Storage Daemon (:9001)      |
| - Data: ./data/node-1         |             | - Data: ./data/node-2         |
+-------------------------------+             +-------------------------------+
```

### Firewall Port Configuration (Windows PowerShell as Admin)

```powershell
# On PC A (Coordinator & Web):
New-NetFirewallRule -DisplayName "VoidShare API (8080)" -Direction Inbound -LocalPort 8080 -Protocol TCP -Action Allow
New-NetFirewallRule -DisplayName "VoidShare Web (5173)" -Direction Inbound -LocalPort 5173 -Protocol TCP -Action Allow

# On PC B & PC C (Storage Nodes):
New-NetFirewallRule -DisplayName "VoidShare Storage (9001)" -Direction Inbound -LocalPort 9001 -Protocol TCP -RemoteAddress 192.168.1.100 -Action Allow
```

👉 **Full Step-by-Step Setup Runbook:** See [`docs/LOCAL_DEMO.md`](docs/LOCAL_DEMO.md)  
👉 **Physical Acceptance Checklist:** See [`docs/THREE_PC_ACCEPTANCE_CHECKLIST.md`](docs/THREE_PC_ACCEPTANCE_CHECKLIST.md)

---

## 🎬 5-Minute Live Presentation Walkthrough

Follow the structured demonstration runbook documented in [`docs/LOCAL_DEMO.md#section-8`](docs/LOCAL_DEMO.md#8-four-to-six-minute-live-presentation-walkthrough):

1. **Initial Cluster Health (0:00 - 0:45):** Open `/cluster` on PC A. Show 2/2 nodes `HEALTHY`, fresh heartbeats < 2s, zero active operations.
2. **Encrypted Ingestion (0:45 - 1:45):** Upload an 80MB file. Observe client-side chunking and dual replication writes to PC B and PC C.
3. **Distribution Audit (1:45 - 2:30):** Inspect the transfer in `/cluster`. Verify chunks stored on both `node-1` and `node-2`. Show raw encrypted chunk files on storage disks.
4. **Code Retrieval on Second PC (2:30 - 3:15):** On PC C, open web UI, enter the 43-character retrieval code, preview metadata, and download. Validate SHA-256 integrity matches original file.
5. **Physical Node Crash & Seamless Failover (3:15 - 4:15):** Terminate storage process on PC B (`Ctrl+C`). Trigger a second download. Observe zero client errors as the coordinator fails over to PC C. Dashboard logs `READ_FAILOVER_SUCCEEDED` and flags PC B as `UNAVAILABLE`.
6. **Recovery & Quota Cleanup (4:15 - 5:00):** Restart PC B. Heartbeat restores status to `HEALTHY`. Download quota exhausted transitions transfer to `CONSUMED`. Background sweeper purges chunks from all disks.

---

## ⚠️ Known V1 Limitations & Trade-offs

To maintain complete architectural honesty, the following constraints are documented for V1:

1. **Two-Node Topology Constraint:** In a 2-node cluster with $RF=2$, if one node fails, the system **cannot re-replicate** the surviving chunk to another node because there is no third storage node available. The cluster operates in a degraded single-replica mode until the failed node recovers.
2. **Trusted LAN Security Boundary:** Storage node chunk operations and heartbeats communicate over unencrypted HTTP using a shared symmetric bearer token (`STORAGE_CLUSTER_SECRET`). Production cloud deployment requires mutual TLS (mTLS) with X.509 certificates and private VPC networking.
3. **Coordinator SPOF:** PC A hosts the Fastify API and SQLite database (`metadata.db`). Coordinator high availability (e.g. Raft consensus / LiteFS replication) is planned for V2.

---

## 📚 Documentation Index

- 📋 [V1 Implementation Status Tracker](docs/V1_IMPLEMENTATION_STATUS.md) — Comprehensive commit-by-commit verification log across all 9 phases.
- 🚀 [3-PC Local Demo Runbook](docs/LOCAL_DEMO.md) — Full hardware setup instructions, firewall rules, and presentation speaker notes.
- ✅ [3-PC Physical Acceptance Test Checklist](docs/THREE_PC_ACCEPTANCE_CHECKLIST.md) — Manual vs automated verification matrix.
- 🛡️ [Security Specification](docs/SECURITY.md) — Threat model, cryptographic primitives, and credential boundaries.
- 📐 [Architecture Reference](docs/ARCHITECTURE.md) — Storage layouts, API routes, and database schema documentation.

---

## 📄 License

This project is licensed under the MIT License. See [LICENSE](LICENSE) for details.
