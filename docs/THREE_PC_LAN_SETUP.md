# Three-PC Local Demonstration Setup & Firewall Guide

> **Scope:** Trusted local area network (LAN) demonstration only. Not for public or untrusted deployment.  
> **Security Model:** PC A coordinates metadata and API requests. Storage nodes on PC B and PC C store encrypted chunks and authenticate internal traffic using `STORAGE_CLUSTER_SECRET`.

---

## 1. Network Topology

```
+-------------------------------------------------------------+
| PC A: COORDINATOR / WEB HOST                                |
| LAN IP: <PC_A_LAN_IP> (e.g. 192.168.1.10)                   |
| - React + Vite Frontend (Port 5173, bound to 0.0.0.0)       |
| - Fastify API + SQLite (Port 8080, bound to 0.0.0.0)         |
+-------------------------------------------------------------+
             |                                    ^
             | PUT/GET chunks                     | Heartbeats
             v                                    |
+---------------------------+       +---------------------------+
| PC B: STORAGE NODE 1      |       | PC C: STORAGE NODE 2      |
| LAN IP: <PC_B_LAN_IP>     |       | LAN IP: <PC_C_LAN_IP>     |
| - Storage Daemon          |       | - Storage Daemon          |
|   (Port 9001)             |       |   (Port 9001)             |
| - Data: ./data/node-1     |       | - Data: ./data/node-2     |
+---------------------------+       +---------------------------+
```

---

## 2. Firewall Port Requirements

| Host | Port | Direction | Source | Destination | Purpose |
|------|------|-----------|--------|-------------|---------|
| **PC A** | `5173/tcp` | Inbound | LAN Clients | PC A | Vite React Web UI |
| **PC A** | `8080/tcp` | Inbound | PC B, PC C, Clients | PC A | API, client transfers, storage node heartbeats |
| **PC B** | `9001/tcp` | Inbound | PC A | PC B | Internal chunk read/write operations |
| **PC C** | `9001/tcp` | Inbound | PC A | PC C | Internal chunk read/write operations |

> [!WARNING]
> Do NOT forward these ports on your internet router. Keep all ports restricted to the trusted local subnet.

### 2.1 Firewall Configuration (Windows PowerShell as Administrator)

**On PC A (Coordinator):**
```powershell
New-NetFirewallRule -DisplayName "VoidShare API (8080)" -Direction Inbound -LocalPort 8080 -Protocol TCP -Action Allow
New-NetFirewallRule -DisplayName "VoidShare Web (5173)" -Direction Inbound -LocalPort 5173 -Protocol TCP -Action Allow
```

**On PC B (Storage Node 1) — Allow inbound from PC A only:**
```powershell
New-NetFirewallRule -DisplayName "VoidShare Node 1 (9001)" -Direction Inbound -LocalPort 9001 -Protocol TCP -RemoteAddress <PC_A_LAN_IP> -Action Allow
```

**On PC C (Storage Node 2) — Allow inbound from PC A only:**
```powershell
New-NetFirewallRule -DisplayName "VoidShare Node 2 (9001)" -Direction Inbound -LocalPort 9001 -Protocol TCP -RemoteAddress <PC_A_LAN_IP> -Action Allow
```

---

## 3. Machine-by-Machine Setup Procedure

### Step 1: Generate Shared Cluster Secret
On PC A, generate a random 32-byte hexadecimal secret:
```bash
# In Node.js or bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```
Copy this value. It must be identical across PC A, PC B, and PC C in the `STORAGE_CLUSTER_SECRET` variable.

---

### Step 2: Configure PC B (Storage Node 1)
1. Clone the repository and install dependencies:
   ```bash
   npm install
   npm run build
   ```
2. Copy configuration template:
   ```bash
   cp config/pc-b-storage-node-1.env.example .env
   ```
3. Edit `.env` with actual values:
   ```env
   NODE_ID=node-1
   HOST=0.0.0.0
   PORT=9001
   DATA_DIR=./data/node-1
   COORDINATOR_URL=http://<PC_A_LAN_IP>:8080
   STORAGE_CLUSTER_SECRET=<SHARED_CLUSTER_SECRET>
   TOTAL_CAPACITY_BYTES=10737418240
   ```
4. Start Storage Node 1:
   ```bash
   npm run dev -w packages/storage-node
   ```

---

### Step 3: Configure PC C (Storage Node 2)
1. Clone the repository and install dependencies:
   ```bash
   npm install
   npm run build
   ```
2. Copy configuration template:
   ```bash
   cp config/pc-c-storage-node-2.env.example .env
   ```
3. Edit `.env` with actual values:
   ```env
   NODE_ID=node-2
   HOST=0.0.0.0
   PORT=9001
   DATA_DIR=./data/node-2
   COORDINATOR_URL=http://<PC_A_LAN_IP>:8080
   STORAGE_CLUSTER_SECRET=<SHARED_CLUSTER_SECRET>
   TOTAL_CAPACITY_BYTES=10737418240
   ```
4. Start Storage Node 2:
   ```bash
   npm run dev -w packages/storage-node
   ```

---

### Step 4: Configure PC A (Coordinator & Web)
1. Copy configuration template:
   ```bash
   cp config/pc-a-coordinator.env.example .env
   ```
2. Edit `.env`:
   ```env
   HOST=0.0.0.0
   PORT=8080
   DB_PATH=./data/api.db
   STORAGE_NODES=node-1=http://<PC_B_LAN_IP>:9001,node-2=http://<PC_C_LAN_IP>:9001
   STORAGE_CLUSTER_SECRET=<SHARED_CLUSTER_SECRET>
   ```
3. Start the API coordinator:
   ```bash
   npm run dev -w packages/api
   ```
4. In another terminal on PC A, start the web frontend:
   ```bash
   npm run dev -w packages/web
   ```

---

## 4. Verification Checklist

1. **Verify Storage Node Authentication:**
   ```bash
   # From PC A, unauthenticated request must return 401:
   curl -i http://<PC_B_LAN_IP>:9001/chunks

   # Authenticated request must return 200:
   curl -i -H "Authorization: Bearer <SHARED_CLUSTER_SECRET>" http://<PC_B_LAN_IP>:9001/chunks
   ```

2. **Verify Frontend Access Across LAN:**
   Open a web browser on PC B or PC C and navigate to:
   ```
   http://<PC_A_LAN_IP>:5173
   ```
   The VoidShare application should load, and upload/download requests will route through PC A's API.
