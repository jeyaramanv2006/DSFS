# VoidShare V1 Three-PC Acceptance Test Checklist

> **Scope:** Physical 3-PC Local Area Network (LAN) validation procedure for VoidShare V1.  
> **Master Plan:** `VoidShare_V1_Local_Demo_Implementation_Plan.md`  
> **Prerequisites:** PC A (Coordinator + Web), PC B (Storage Node 1), PC C (Storage Node 2) connected via Ethernet switch or Wi-Fi router.

---

## 1. Network Topology & Environment

| Node | Physical Machine | Role | Service Address | Data Directory |
|---|---|---|---|---|
| **Coordinator + Web** | PC A | API Coordinator, SQLite DB, Web Client | `http://192.168.1.100:3000` (API)<br>`http://192.168.1.100:5173` (Web) | `packages/api/data/metadata.db` |
| **Storage Node 1** | PC B | Primary Storage Node (`node-1`) | `http://192.168.1.101:4001` | `packages/storage-node/data/node-1` |
| **Storage Node 2** | PC C | Secondary Storage Node (`node-2`) | `http://192.168.1.102:4002` | `packages/storage-node/data/node-2` |

> *Note: If LAN IP addresses differ from `192.168.1.10x`, update the `.env` files accordingly using the template guide in [`docs/THREE_PC_SETUP.md`](file:///c:/Users/Gopi/Dev%20shit/Personal/void_share/DSFS/docs/THREE_PC_SETUP.md).*

---

## 2. Test Execution Checklist

### Test 1: Cluster Initialization & Topology Visibility
- [ ] **Procedure:**
  1. On PC B, start Storage Node 1: `npm run dev` in `packages/storage-node` with `NODE_ID=node-1`.
  2. On PC C, start Storage Node 2: `npm run dev` in `packages/storage-node` with `NODE_ID=node-2`.
  3. On PC A, start Coordinator API and Web: `npm run dev` in `packages/api` and `packages/web`.
  4. On PC A (or PC B/C), open browser to `http://192.168.1.100:5173/cluster`.
- [ ] **Expected Verification:**
  - Cluster status badge displays **HEALTHY (2 / 2 nodes online)**.
  - Node 1 and Node 2 cards display green `HEALTHY` pill, heartbeat age `< 3s`, active operations `0`, and accurate disk capacities.
  - Initial `cluster_events` log displays node heartbeat registration events.
- [ ] **Automated Test Reference:** [`packages/api/src/routes/cluster.test.ts`](file:///c:/Users/Gopi/Dev%20shit/Personal/void_share/DSFS/packages/api/src/routes/cluster.test.ts), [`packages/api/src/health/routes.test.ts`](file:///c:/Users/Gopi/Dev%20shit/Personal/void_share/DSFS/packages/api/src/health/routes.test.ts).

---

### Test 2: Multi-Chunk Upload & Dual-PC Replication (100MB – 1GB)
- [ ] **Procedure:**
  1. Prepare or generate a test file of 100MB to 1GB:
     ```powershell
     # Windows PowerShell 100MB dummy file generator
     $fs = [System.IO.File]::Create("test-100mb.bin"); $fs.SetLength(104857600); $fs.Close()
     ```
  2. Navigate to `http://192.168.1.100:5173` on PC A.
  3. Drag and drop `test-100mb.bin`, set Download Limit = 2, Expiration = 30 minutes, and click **Upload**.
  4. Monitor progress bar as the file is chunked (4MB chunks) and client-side encrypted via AES-256-GCM.
- [ ] **Expected Verification:**
  - Upload completes successfully and generates both:
    1. **Share Link:** `http://192.168.1.100:5173/#/t/<fileId>#<secretKey>`
    2. **43-Character Retrieval Code:** `vs1-<unpadded-base64>`
  - Navigate to `/cluster` dashboard:
    - Active Transfers lists `test-100mb.bin` with status `READY`.
    - Chunk inspection table displays each chunk replicated with status `STORED` on both `node-1` (PC B) and `node-2` (PC C).
    - Disk checks on PC B (`packages/storage-node/data/node-1`) and PC C (`packages/storage-node/data/node-2`) confirm identical chunk files present.
- [ ] **Automated Test Reference:** [`packages/cli/src/two-pc-e2e.test.ts`](file:///c:/Users/Gopi/Dev%20shit/Personal/void_share/DSFS/packages/cli/src/two-pc-e2e.test.ts#L130-L200), [`packages/api/src/replication/replication.test.ts`](file:///c:/Users/Gopi/Dev%20shit/Personal/void_share/DSFS/packages/api/src/replication/replication.test.ts).

---

### Test 3: Download & Decrypt via Retrieval Code
- [ ] **Procedure:**
  1. On PC B or PC C, open browser to `http://192.168.1.100:5173`.
  2. Click **"Enter Retrieval Code"** tab on the main page.
  3. Paste the 43-character retrieval code generated in Test 2.
  4. Verify the transfer preview card shows correct file name (`test-100mb.bin`), size (100MB), and remaining downloads (2).
  5. Click **"Download & Decrypt"**.
- [ ] **Expected Verification:**
  - Browser downloads decrypted file.
  - Verify file integrity using SHA-256 hash against original file:
    ```powershell
    Get-FileHash -Algorithm SHA256 test-100mb.bin
    Get-FileHash -Algorithm SHA256 (Get-ChildItem -Path ~/Downloads/test-100mb*.bin | Select -Last 1).FullName
    ```
  - Hashes match exactly.
  - On `/cluster` dashboard, download count advances to `1/2`, transfer remains `READY`.
- [ ] **Automated Test Reference:** [`packages/cli/src/two-pc-e2e.test.ts`](file:///c:/Users/Gopi/Dev%20shit/Personal/void_share/DSFS/packages/cli/src/two-pc-e2e.test.ts#L205-L217), [`packages/api/src/routes/transfers.test.ts`](file:///c:/Users/Gopi/Dev%20shit/Personal/void_share/DSFS/packages/api/src/routes/transfers.test.ts).

---

### Test 4: Node Failure & Seamless Replica Read Failover
- [ ] **Procedure:**
  1. Keep the `/cluster` dashboard open on PC A.
  2. On PC B, intentionally kill the Storage Node 1 process (`Ctrl+C` or terminate process).
  3. Immediately on PC C (or PC A), initiate the second download of `test-100mb.bin` using either the retrieval code or share link.
- [ ] **Expected Verification:**
  - **Download Success:** The download completes without interruption or corrupted bytes. The coordinator detects connection failure to PC B and automatically falls over to the healthy replica on PC C.
  - **Failover Logged:** `/cluster` event timeline records `READ_FAILOVER_SUCCEEDED` with `node_id: node-2`.
  - **Outage Detection:** After 5 seconds without heartbeat, PC B card turns yellow (`UNHEALTHY`). After 10 seconds, PC B turns red (`UNAVAILABLE`). Cluster banner indicates degraded state.
  - Download count reaches `2/2`, transfer status transitions to `CONSUMED`.
- [ ] **Automated Test Reference:** [`packages/cli/src/two-pc-e2e.test.ts`](file:///c:/Users/Gopi/Dev%20shit/Personal/void_share/DSFS/packages/cli/src/two-pc-e2e.test.ts#L218-L246), [`packages/api/src/health/lifecycle-failover.test.ts`](file:///c:/Users/Gopi/Dev%20shit/Personal/void_share/DSFS/packages/api/src/health/lifecycle-failover.test.ts#L270-L330).

---

### Test 5: Quota Enforcement & Outage Cleanup Resilience
- [ ] **Procedure:**
  1. Attempt a 3rd download of the same transfer while PC B is still offline.
  2. Check response from API / UI.
  3. Wait for background `ExpirationSweeper` to run on PC A (or trigger via API).
- [ ] **Expected Verification:**
  - 3rd download is rejected with **410 Gone** (`TRANSFER_CONSUMED`).
  - `ExpirationSweeper` purges chunks from PC C (`storeC.chunks.size = 0`).
  - Because PC B is offline, its replicas cannot be reached; they are marked `ORPHANED_PENDING_DELETE`.
  - The transfer status remains `DELETING` rather than premature deletion.
- [ ] **Automated Test Reference:** [`packages/cli/src/two-pc-e2e.test.ts`](file:///c:/Users/Gopi/Dev%20shit/Personal/void_share/DSFS/packages/cli/src/two-pc-e2e.test.ts#L247-L260), [`packages/api/src/cleanup/cleanup.test.ts`](file:///c:/Users/Gopi/Dev%20shit/Personal/void_share/DSFS/packages/api/src/cleanup/cleanup.test.ts).

---

### Test 6: Node Recovery & Final Storage Reconcile
- [ ] **Procedure:**
  1. On PC B, restart Storage Node 1: `npm run dev` in `packages/storage-node`.
  2. Observe `/cluster` dashboard.
  3. Allow background sweeper / reconciler to execute.
- [ ] **Expected Verification:**
  - PC B emits heartbeat; within 3 seconds, dashboard shows PC B restored to green `HEALTHY`.
  - Event log records `NODE_RECOVERED`.
  - Sweeper reaches recovered PC B, cleans up remaining orphaned replicas, and marks transfer `DELETED`.
  - Disk storage on both PC B and PC C is completely clean (zero leftover orphan chunks).
- [ ] **Automated Test Reference:** [`packages/cli/src/two-pc-e2e.test.ts`](file:///c:/Users/Gopi/Dev%20shit/Personal/void_share/DSFS/packages/cli/src/two-pc-e2e.test.ts#L261-L275), [`packages/api/src/recovery/two-node-outage.test.ts`](file:///c:/Users/Gopi/Dev%20shit/Personal/void_share/DSFS/packages/api/src/recovery/two-node-outage.test.ts).

---

## 3. Automated vs. Physical Verification Matrix

| Checklist Item | Automated Test Coverage | Status in Codebase | Physical LAN Requirement |
|---|---|:---:|---|
| Multi-chunk upload (4MB chunks) | `two-pc-e2e.test.ts`, `transfers.test.ts` | 🟢 Verified (PASS) | Validate over physical gigabit switch / Wi-Fi |
| RF=2 dual replication | `two-pc-e2e.test.ts`, `replication.test.ts` | 🟢 Verified (PASS) | Inspect files in PC B/C data directories |
| 43-character retrieval code preview | `crypto.test.ts`, `transfers.test.ts`, `client.test.ts` | 🟢 Verified (PASS) | Enter code across secondary machine browser |
| Node outage during download | `lifecycle-failover.test.ts`, `two-pc-e2e.test.ts` | 🟢 Verified (PASS) | Terminate PC B process or pull Ethernet cable |
| Automatic replica failover to PC C | `lifecycle-failover.test.ts`, `two-pc-e2e.test.ts` | 🟢 Verified (PASS) | Observe uninterrupted download stream |
| Health state transitions | `monitor.test.ts`, `routes.test.ts` | 🟢 Verified (PASS) | Observe dashboard UI indicators |
| Quota expiry & background purge | `cleanup.test.ts`, `two-pc-e2e.test.ts` | 🟢 Verified (PASS) | Confirm zero lingering chunks on disk |
| Node recovery & orphaned replica wipe | `two-node-outage.test.ts`, `two-pc-e2e.test.ts` | 🟢 Verified (PASS) | Restart PC B node and verify log and disk clean |

---

## 4. Acceptance Sign-Off

- [ ] Physical 3-PC LAN setup completed according to [`docs/THREE_PC_SETUP.md`](file:///c:/Users/Gopi/Dev%20shit/Personal/void_share/DSFS/docs/THREE_PC_SETUP.md)
- [ ] All 6 test scenarios executed and verified
- [ ] Cluster dashboard live demonstration confirmed ready
