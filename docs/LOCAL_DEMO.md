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
