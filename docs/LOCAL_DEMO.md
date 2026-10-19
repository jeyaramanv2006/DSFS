# VoidShare V1 Local Demo: 3-PC Startup & Operations Runbook

> **Target Environment:** Trusted 3-PC Local Area Network (LAN).  
> **Security Notice:** HTTP transmission and pre-shared cluster secrets are designed specifically for physical local demonstration. Public deployment requires TLS/HTTPS, mutual authentication, and isolated private storage subnets.

---

## 1. Network Topology & Port Map

The VoidShare V1 demonstration runs across three independent physical machines on a local gigabit switch or Wi-Fi router:

```
                          +----------------------------------------------+
                          |                   PC A                       |
                          |  Coordinator API (:8080) + Web UI (:5173)   |
                          |  IP: 192.168.1.100 (Bound to 0.0.0.0)        |
                          +----------------------------------------------+
                                         |              |
                    PUT / GET Chunks     |              |  PUT / GET Chunks
                    Bearer Auth          |              |  Bearer Auth
                                         v              v
            +---------------------------------+    +---------------------------------+
            |              PC B               |    |              PC C               |
            |     Storage Node 1 (:9001)      |    |     Storage Node 2 (:9001)      |
            |     IP: 192.168.1.101           |    |     IP: 192.168.1.102           |
            |     Data: ./data/node-1         |    |     Data: ./data/node-2         |
            +---------------------------------+    +---------------------------------+
                     |                                      |
                     +------------ Heartbeats ------------->+
                                  (to PC A :8080)
```

### Port Allocation & Traffic Flow

| Machine | Service | Port | Protocol | Inbound From | Outbound To | Purpose |
|---|---|---|---|---|---|---|
| **PC A** | Fastify API | `8080` | TCP | PC B, PC C, Clients | PC B, PC C | Client metadata, chunk routing, heartbeat receiver |
| **PC A** | Vite Web UI | `5173` | TCP | LAN Browsers | None | Client application frontend |
| **PC B** | Storage Node 1 | `9001` | TCP | PC A only | PC A:8080 | Encrypted chunk store (`node-1`), emits heartbeats |
| **PC C** | Storage Node 2 | `9001` | TCP | PC A only | PC A:8080 | Encrypted chunk store (`node-2`), emits heartbeats |

---

## 2. Firewall Configuration (Windows Defender)

Run Windows PowerShell as **Administrator** on each respective machine:

### On PC A (Coordinator & Web):
```powershell
New-NetFirewallRule -DisplayName "VoidShare API (8080)" -Direction Inbound -LocalPort 8080 -Protocol TCP -Action Allow
New-NetFirewallRule -DisplayName "VoidShare Web (5173)" -Direction Inbound -LocalPort 5173 -Protocol TCP -Action Allow
```

### On PC B (Storage Node 1):
```powershell
New-NetFirewallRule -DisplayName "VoidShare Node 1 (9001)" -Direction Inbound -LocalPort 9001 -Protocol TCP -RemoteAddress 192.168.1.100 -Action Allow
```

### On PC C (Storage Node 2):
```powershell
New-NetFirewallRule -DisplayName "VoidShare Node 2 (9001)" -Direction Inbound -LocalPort 9001 -Protocol TCP -RemoteAddress 192.168.1.100 -Action Allow
```

---

## 3. Environment Configuration

### Step 1: Shared Cluster Secret
All 3 machines must share the exact same `STORAGE_CLUSTER_SECRET`. Generate one on PC A:
```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```
*Example generated secret:* `c7f938d4e21a0845bc971203de67198a2e105847391bcedf08924157ba342018`

---

### Step 2: PC B Configuration (`packages/storage-node/.env`)
Create or edit `.env` on PC B:
```env
NODE_ID=node-1
HOST=0.0.0.0
PORT=9001
DATA_DIR=./data/node-1
COORDINATOR_URL=http://192.168.1.100:8080
STORAGE_CLUSTER_SECRET=c7f938d4e21a0845bc971203de67198a2e105847391bcedf08924157ba342018
TOTAL_CAPACITY_BYTES=10737418240
HEARTBEAT_INTERVAL_MS=3000
```

---

### Step 3: PC C Configuration (`packages/storage-node/.env`)
Create or edit `.env` on PC C:
```env
NODE_ID=node-2
HOST=0.0.0.0
PORT=9001
DATA_DIR=./data/node-2
COORDINATOR_URL=http://192.168.1.100:8080
STORAGE_CLUSTER_SECRET=c7f938d4e21a0845bc971203de67198a2e105847391bcedf08924157ba342018
TOTAL_CAPACITY_BYTES=10737418240
HEARTBEAT_INTERVAL_MS=3000
```

---

### Step 4: PC A Configuration (`packages/api/.env`)
Create or edit `.env` on PC A:
```env
HOST=0.0.0.0
PORT=8080
DB_PATH=./data/metadata.db
STORAGE_NODES=node-1=http://192.168.1.101:9001,node-2=http://192.168.1.102:9001
STORAGE_CLUSTER_SECRET=c7f938d4e21a0845bc971203de67198a2e105847391bcedf08924157ba342018
HEALTH_CHECK_INTERVAL_MS=2000
NODE_UNHEALTHY_THRESHOLD_MS=5000
NODE_UNAVAILABLE_THRESHOLD_MS=10000
```

---

## 4. Machine Startup Commands

To ensure clean initial health detection, start the storage nodes first, followed by the coordinator.

### Terminal 1: PC B (Storage Node 1)
```bash
cd void_share/DSFS
npm run build
npm run dev -w packages/storage-node
```
*Expected log output:*
```
[storage-node] listening on http://0.0.0.0:9001
[storage-node] node-1 initialized (10.00 GB total, 0 B used)
[heartbeat] sent to http://192.168.1.100:8080 (retry backoff active until coordinator online)
```

### Terminal 2: PC C (Storage Node 2)
```bash
cd void_share/DSFS
npm run build
npm run dev -w packages/storage-node
```
*Expected log output:*
```
[storage-node] listening on http://0.0.0.0:9001
[storage-node] node-2 initialized (10.00 GB total, 0 B used)
[heartbeat] sent to http://192.168.1.100:8080 (retry backoff active until coordinator online)
```

### Terminal 3: PC A (Coordinator API)
```bash
cd void_share/DSFS
npm run build
npm run dev -w packages/api
```
*Expected log output:*
```
[api] listening on http://0.0.0.0:8080
[database] SQLite initialized at ./data/metadata.db
[monitor] health monitor started (poll: 2000ms, unhealthy: 5000ms, unavailable: 10000ms)
[workers] background workers started (sweeper: 10000ms, reconciler: 30000ms)
[heartbeat] received from node-1 (HEALTHY)
[heartbeat] received from node-2 (HEALTHY)
```

### Terminal 4: PC A (Web UI)
```bash
cd void_share/DSFS
npm run dev -w packages/web -- --host 0.0.0.0 --port 5173
```
*Expected log output:*
```
  VITE v8.3.3  ready in 180 ms

  ➜  Local:   http://localhost:5173/
  ➜  Network: http://192.168.1.100:5173/
```

---

## 5. Connectivity & Health Verification

From PC A, test endpoints using `curl` or PowerShell `Invoke-RestMethod`:

```bash
# 1. Verify Coordinator Health
curl http://192.168.1.100:8080/health

# 2. Verify Storage Node Authentication (Unauthenticated request must return 401)
curl -i http://192.168.1.101:9001/chunks

# 3. Verify Storage Node Authentication (Authenticated request must return 200)
curl -i -H "Authorization: Bearer c7f938d4e21a0845bc971203de67198a2e105847391bcedf08924157ba342018" http://192.168.1.101:9001/health

# 4. Verify Cluster Observability API
curl http://192.168.1.100:8080/api/cluster/overview
```

---

## 6. Troubleshooting & Recovery Matrix

| Symptom | Probable Cause | Diagnostic Command & Fix |
|---|---|---|
| **Node remains `UNAVAILABLE` on Dashboard** | Windows Firewall blocking port `8080` (heartbeat) or `9001` (chunks) | Run `Test-NetConnection -ComputerName 192.168.1.100 -Port 8080` from PC B. Check inbound firewall rules. |
| **HTTP 401 Unauthorized on Heartbeat or Chunks** | `STORAGE_CLUSTER_SECRET` mismatch across `.env` files | Inspect `.env` on PC A, PC B, PC C. Re-copy the exact 32-byte hex string to all nodes. |
| **Port Collision (`EADDRINUSE: 8080` or `9001`)** | Zombie process from previous run | Run: `Get-Process -Id (Get-NetTCPConnection -LocalPort 9001).OwningProcess \| Stop-Process -Force` |
| **Frontend Cannot Reach API (`Network Error`)** | Browser connecting via `localhost` instead of LAN IP | In browser, load `http://192.168.1.100:5173` rather than `localhost:5173`. Ensure API binds to `0.0.0.0`. |
| **Stale Storage Data Across Runs** | Prior demo files retained in data directories | Stop all services, then delete `./data/metadata.db` on PC A and `./data/node-1`, `./data/node-2` directories on PC B and PC C. |

---

## 7. Distributed Systems Architecture & Data Flow

VoidShare V1 implements a distributed, peer-replicated blob store with client-side zero-knowledge encryption:

```
+-----------------------------------------------------------------------------------------+
|                                    CLIENT BROWSER                                       |
|  1. Generate 32-byte master secret                                                      |
|  2. Split file into 4MB chunks                                                          |
|  3. Encrypt each chunk locally using AES-256-GCM (12-byte random IV + 16-byte auth tag) |
|  4. Derive capability hash for API transfer registration (master secret never leaves)   |
|  5. Format 43-character retrieval code (vs1-<unpadded-base64url>)                       |
+-----------------------------------------------------------------------------------------+
                                             |
                                POST /api/transfers
                       PUT /api/transfers/:id/chunks/:index
                                             v
+-----------------------------------------------------------------------------------------+
|                                 PC A: COORDINATOR API                                   |
|  - Consistent Hash Ring placement selects 2 replica nodes for each chunk (RF=2)         |
|  - Concurrently pushes chunk to PC B (node-1) and PC C (node-2) with cluster auth       |
|  - Awaits 200 OK from BOTH nodes before committing chunk status = 'STORED'              |
|  - Finalizes transfer status = 'READY' only when 100% of chunks have 2 confirmed acks   |
|  - Autonomous HealthMonitor evaluates node heartbeats every 2 seconds                   |
|  - ReplicaReadService handles client downloads: fails over to surviving replica on drop |
+-----------------------------------------------------------------------------------------+
                         |                                       |
                 PUT /chunks/:chunkId                    PUT /chunks/:chunkId
                         v                                       v
+----------------------------------+                   +----------------------------------+
|      PC B: STORAGE NODE 1        |                   |      PC C: STORAGE NODE 2        |
|  - Verifies STORAGE_CLUSTER_SECRET |                   |  - Verifies STORAGE_CLUSTER_SECRET |
|  - Writes raw encrypted chunk to |                   |  - Writes raw encrypted chunk to |
|    ./data/node-1/<chunkId>       |                   |    ./data/node-2/<chunkId>       |
|  - Increments local disk metrics |                   |  - Increments local disk metrics |
|  - Emits heartbeat every 3000ms  |                   |  - Emits heartbeat every 3000ms  |
+----------------------------------+                   +----------------------------------+
```

### Key Subsystems & Lifecycle Parameters

1. **Client-Side Zero-Knowledge Encryption:**
   - Plaintext files are chunked into 4MiB blocks.
   - Each chunk is encrypted using AES-256-GCM with a freshly generated 12-byte cryptographically secure random IV and 16-byte GCM authentication tag.
   - The master secret is a 32-byte random key encoded into an unpadded 43-character URL-safe Base64 string (`vs1-<token>`).
   - The client derives a capability authentication token via SHA-256 (`capability_hash = SHA256(secret)`). The API and storage nodes never see the plaintext, master key, or encryption keys.

2. **Replication Factor ($RF=2$) & Strict Consistency at Ingestion:**
   - Consistent hashing with virtual nodes maps chunks to `node-1` and `node-2`.
   - The coordinator requires confirmed writes from **both** storage nodes before marking a chunk `STORED`.
   - The transfer is presented as `READY` only after all chunks achieve confirmed dual replication.

3. **Autonomous Heartbeat Detection & Thresholds:**
   - Storage nodes emit authenticated heartbeats (`POST /api/nodes/heartbeat`) every `3000ms`, reporting disk capacity and active operations.
   - The coordinator's `HealthMonitor` runs every `2000ms` against SQLite:
     - **`HEALTHY`**: Heartbeat age $\le 5000\text{ms}$.
     - **`UNHEALTHY`**: Heartbeat age between $5000\text{ms}$ and $10000\text{ms}$.
     - **`UNAVAILABLE`**: Heartbeat age $> 10000\text{ms}$.
   - All state transitions are committed to `cluster_events` table and surfaced on the `/cluster` dashboard.

4. **Transparent Replica Read Failover:**
   - During download, `ReplicaReadService` prioritizes healthy nodes (`HEALTH_ORDER: HEALTHY > RECOVERING > UNHEALTHY > UNAVAILABLE`).
   - If a connection to the primary node fails (e.g. process termination, network partition), the coordinator catches the error, logs a `READ_FAILOVER_SUCCEEDED` event, and immediately retrieves the replica from the surviving storage node.
   - The recipient browser streams and decrypts the file without encountering an error.

5. **Garbage Collection & Orphan Resilience:**
   - Transfers reaching expiration TTL or download quota (`download_count >= max_downloads`) transition to `CONSUMED`.
   - Background `ExpirationSweeper` purges chunks across all replica nodes.
   - If a node is down during cleanup, its replicas are marked `ORPHANED_PENDING_DELETE` and the transfer remains `DELETING`. When the node recovers, subsequent sweeps clean the remaining chunks and finalize the transfer deletion.

---

## 8. Four-to-Six-Minute Live Presentation Walkthrough

This presentation sequence is designed for a live technical demonstration showcasing real distributed systems resilience.

```
+---------------------------------------------------------------------------------------------+
| Presentation Timeline (Total: ~5:00)                                                        |
| [0:00 - 0:45] Intro & Topology Check  --> Verify 2/2 Healthy Nodes on Dashboard            |
| [0:45 - 1:45] Upload & Chunking       --> 50-100MB File Encrypted & Replicated to 2 Nodes    |
| [1:45 - 2:30] Distribution & Codes    --> Inspect Chunk Placement & Dual Retrieval Outputs   |
| [2:30 - 3:15] Retrieve by Code        --> Download & Decrypt on Secondary Machine Browser    |
| [3:15 - 4:15] Physical Outage & Read  --> Terminate Node 1 Terminal; Download Continues Live |
| [4:15 - 5:00] Recovery & Quota Wipe   --> Restart Node 1; Observe Heartbeat & Quota Purge    |
+---------------------------------------------------------------------------------------------+
```

### Detailed Script & Speaker Notes

#### Step 1: Initial Cluster State & Topology (0:00 – 0:45)
- **Action:** Open browser on PC A to `http://192.168.1.100:5173/cluster`.
- **Speaker Notes:**
  > *"Welcome to VoidShare. Here we have a live 3-machine distributed storage cluster running across our local network. PC A is coordinating metadata and serving the web client, while PC B and PC C are independent storage daemons running on ports 9001. As you can see on the dashboard, both nodes are currently reporting green HEALTHY status, with active heartbeats received within the last 2 seconds and zero active operations. All health transitions are backed by an autonomous coordinator health loop, not UI mocks."*

#### Step 2: Multi-Chunk Client-Side Upload (0:45 – 1:45)
- **Action:** Navigate to `http://192.168.1.100:5173/`. Select a 50MB to 100MB test file. Set Download Limit = `2`, Expiry = `30m`. Click **Upload**.
- **Speaker Notes:**
  > *"We're uploading an 80-megabyte binary. Notice the progress bar: before any bytes leave the browser, the client splits the file into 4-megabyte chunks and encrypts each one with AES-256-GCM using a locally generated 256-bit key. The coordinator routes each chunk across our consistent hash ring to both PC B and PC C with replication factor 2. Crucially, the coordinator requires confirmed write acknowledgments from both physical nodes before committing the chunk status."*

#### Step 3: Distribution Verification & Retrieval Codes (1:45 – 2:30)
- **Action:** On upload completion, display the Share Link and the 43-character Retrieval Code. Switch back to `/cluster` dashboard. Click the active transfer in the table.
- **Speaker Notes:**
  > *"The upload is complete. The sender receives two options: a direct URL with the decryption key in the hash fragment, and a clean 43-character alphanumeric retrieval code. Looking at our cluster dashboard, we can inspect every chunk of this file. Chunk 0, 1, 2, and so on are stored redundantly on both `node-1` on PC B and `node-2` on PC C. If we check the physical terminal on PC B, the raw encrypted chunk blobs are sitting right on its disk."*

#### Step 4: Retrieval by Code on Secondary Machine (2:30 – 3:15)
- **Action:** On PC C (or PC B), open `http://192.168.1.100:5173/`. Click **"Enter Retrieval Code"**. Paste the 43-character code. Click **"Download & Decrypt"**.
- **Speaker Notes:**
  > *"Now we're on a separate machine. We choose 'Enter Retrieval Code', paste the code, and immediately see a pre-flight preview showing the filename and file size without consuming our download quota. Clicking download streams the encrypted chunks through the coordinator, and the browser decrypts the stream on the fly. The downloaded file matches the original SHA-256 hash byte-for-byte. Looking at the dashboard, our download count has incremented to 1 of 2."*

#### Step 5: Physical Node Crash & Seamless Read Failover (3:15 – 4:15)
- **Action:** 
  1. Keep `/cluster` dashboard visible on PC A.
  2. On PC B, terminate the storage node process with `Ctrl+C`.
  3. Immediately on PC C, initiate the second download of the file.
- **Speaker Notes:**
  > *"Now for the distributed systems stress test. I am terminating the storage daemon on PC B with Ctrl+C. The primary replica node is dead. Immediately, from PC C, we start our second download. Look at the download progress: it completes smoothly without a single dropped packet or error! The coordinator detected connection refusal on PC B and instantly redirected chunk reads to the healthy replica on PC C. On the dashboard event log, you see `READ_FAILOVER_SUCCEEDED` recorded. Within 5 seconds, the failure detector flags PC B as UNHEALTHY, and at 10 seconds, UNAVAILABLE."*

#### Step 6: Recovery, Quota Enforcement & Garbage Collection (4:15 – 5:00)
- **Action:**
  1. Restart PC B: `npm run dev -w packages/storage-node`.
  2. Attempt a 3rd download in the browser.
- **Speaker Notes:**
  > *"We restart PC B. Within 3 seconds, a fresh heartbeat registers with the coordinator, and the dashboard transitions PC B back to green HEALTHY status, logging `NODE_RECOVERED`. Finally, because this file had a download quota of 2, the transfer status is now CONSUMED. Any subsequent download attempt is rejected with HTTP 410 Gone. The background expiration sweeper activates, purging all chunk replicas from both PC B and PC C disks, freeing our cluster storage. This concludes the VoidShare V1 demonstration."*

---

## 9. Explicit V1 Distributed Systems Limitations & Known Trade-offs

To maintain complete architectural integrity, the following limitations in VoidShare V1 are documented and should be acknowledged during evaluation:

### 1. Two-Node Cluster Outage & Degraded Mode
- **Limitation:** In a 2-node cluster with Replication Factor $RF=2$, if one storage node fails, the cluster **cannot re-replicate** the surviving chunks because there is no 3rd storage node available in the topology.
- **System Behavior:** The cluster enters a degraded single-replica mode. All read operations remain available via failover to the surviving node, but new uploads requiring $RF=2$ will be rejected until the offline node recovers. Re-replication to an alternate node requires a cluster topology of $N \ge 3$ nodes.

### 2. Trusted LAN Threat Model (Plaintext HTTP Internal Traffic)
- **Limitation:** Storage node chunk operations and heartbeats communicate over unencrypted HTTP using a shared symmetric bearer token (`STORAGE_CLUSTER_SECRET`).
- **Production Requirement:** Suitable exclusively for trusted local subnets. Public deployment requires mutual TLS (mTLS) with distinct X.509 client/server certificates, private VPC networking, and API gateway rate-limiting.

### 3. Coordinator as a Single Point of Failure (SPOF)
- **Limitation:** PC A hosts both the SQLite metadata database (`metadata.db`) and the Fastify API. If PC A crashes, client requests and health monitoring halt.
- **Future Architecture (V2):** Migration to a distributed consensus coordinator layer (e.g., Raft consensus, SQLite distributed replication via LiteFS/rqlite, or an etcd cluster).

### 4. Static LAN Latency Assumptions
- **Limitation:** Heartbeat interval (`3000ms`), unhealthy threshold (`5000ms`), and unavailable threshold (`10000ms`) assume a low-jitter local Ethernet/Wi-Fi connection (< 5ms RTT).
- **Production Requirement:** Wide Area Networks (WAN) or public cloud deployments require adaptive failure detectors (such as the $\varphi$-accrual failure detector) to prevent false-positive failovers under network congestion.

