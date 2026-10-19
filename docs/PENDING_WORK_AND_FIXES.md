# VoidShare: Unimplemented Features, Gaps, and Required Fixes

> **Status Update (v1.0.1 Review):** This document has been updated following the integration of the Linear-inspired frontend redesign (commit `55be5b2`). It catalogs all **resolved features**, **newly introduced build issues**, **remaining gaps between standalone classes and live runtime**, and **critical security/performance fixes**.
>
> Source code is authoritative. File paths refer to the monorepo root at [`DSFS/`](file:///c:/Users/Gopi/Dev%20shit/Personal/void_share/DSFS).

---

## Table of Contents
1. [Executive Summary & Recent Progress](#1-executive-summary--recent-progress)
2. [Frontend Audit: What Was Added vs. What Remains](#2-frontend-audit-what-was-added-vs-what-remains)
   - [2.1 Resolved Frontend Items](#21-resolved-frontend-items)
   - [2.2 Active Frontend Bugs & Immediate Fixes](#22-active-frontend-bugs--immediate-fixes)
   - [2.3 Remaining Frontend Functional Gaps](#23-remaining-frontend-functional-gaps)
3. [Distributed Backend Gaps: What Is Not Done (Unwired Components)](#3-distributed-backend-gaps-what-is-not-done-unwired-components)
   - [3.1 Background Worker Orchestration & Scheduling](#31-background-worker-orchestration--scheduling)
   - [3.2 Storage Node Heartbeat Emitter](#32-storage-node-heartbeat-emitter)
   - [3.3 Node Health Monitoring Background Loop](#33-node-health-monitoring-background-loop)
   - [3.4 Storage Node Control Plane Authentication](#34-storage-node-control-plane-authentication)
   - [3.5 CLI Command-Line Executable](#35-cli-command-line-executable)
   - [3.6 Containerization & Docker Compose Topology](#36-containerization--docker-compose-topology)
4. [Security, Performance & Architectural Issues to Fix](#4-security-performance--architectural-issues-to-fix)
   - [4.1 Critical Security: Static Zero IV on Filename Encryption](#41-critical-security-static-zero-iv-on-filename-encryption)
   - [4.2 Memory Leak: In-Memory Rate Limiter Map](#42-memory-leak-in-memory-rate-limiter-map)
   - [4.3 Disk I/O Bottleneck: Sequential Stat in Storage Node `healthCheck()`](#43-disk-io-bottleneck-sequential-stat-in-storage-node-healthcheck)
   - [4.4 Heap Memory Pressure: API Buffering Whole Chunks During Replication](#44-heap-memory-pressure-api-buffering-whole-chunks-during-replication)
   - [4.5 Browser Memory Crash: In-Memory Blob Assembly for Downloads](#45-browser-memory-crash-in-memory-blob-assembly-for-downloads)
   - [4.6 Unauthenticated Internal Health & Heartbeat Endpoints](#46-unauthenticated-internal-health--heartbeat-endpoints)
   - [4.7 Single Points of Failure: SQLite & Single Fastify Instance](#47-single-points-of-failure-sqlite--single-fastify-instance)
5. [Updated Prioritized Implementation Backlog](#5-updated-prioritized-implementation-backlog)

---

## 1. Executive Summary & Recent Progress

With the latest frontend update, the user experience has progressed significantly:
- A modern, dark-mode **Linear UI design** with animated WebGL gradient bars ([`GradientBars.tsx`](file:///c:/Users/Gopi/Dev%20shit/Personal/void_share/DSFS/packages/web/src/components/ui/GradientBars.tsx)), precision typography, and multi-step transfer wizards.
- **Configurable TTLs** (1h, 6h, 12h, 24h, 48h) matched with expanded backend API validation (`ALLOWED_TTLS` in [`transfers.ts`](file:///c:/Users/Gopi/Dev%20shit/Personal/void_share/DSFS/packages/api/src/routes/transfers.ts#L13)).
- **Configurable download quotas** (1, 5, 10, 25, 100).
- **Live upload and download progress bars** with chunk counters and percentage feedback.
- **Transfer cancellation** powered by `AbortController` and `AbortSignal`.
- **Zero-byte empty file prevention** in the dropzone handler.

However:
1. **The frontend build is currently broken:** `npm run build` fails with `TS2307: Cannot find module '@/components/ui/GradientBars'` due to a missing path alias configuration in `packages/web/tsconfig.json`.
2. **The distributed engine is still dormant:** The self-healing background workers ([`ExpirationSweeper`](file:///c:/Users/Gopi/Dev%20shit/Personal/void_share/DSFS/packages/api/src/cleanup/cleanup.ts#L15), [`RecoveryService`](file:///c:/Users/Gopi/Dev%20shit/Personal/void_share/DSFS/packages/api/src/recovery/recovery.ts#L16), [`StorageReconciler`](file:///c:/Users/Gopi/Dev%20shit/Personal/void_share/DSFS/packages/api/src/cleanup/cleanup.ts#L70)) are still **not instantiated or scheduled** in [`packages/api/src/main.ts`](file:///c:/Users/Gopi/Dev%20shit/Personal/void_share/DSFS/packages/api/src/main.ts).
3. **Storage nodes are still silent and unprotected:** Storage nodes do not send heartbeats, and storage endpoints on ports 9001–9003 have zero authentication.
4. **Cryptographic vulnerability remains:** Filename encryption still uses an all-zero static IV.

---

## 2. Frontend Audit: What Was Added vs. What Remains

### 2.1 Resolved Frontend Items
| Feature | Resolution Details | Files |
| :--- | :--- | :--- |
| **TTL Selection** | Options for 1h, 6h, 12h, 24h, 48h with descriptive subtext. Backend updated to allow up to 48h (`MAX_TTL_SECONDS`). | [`packages/web/src/index.tsx:14-20`](file:///c:/Users/Gopi/Dev%20shit/Personal/void_share/DSFS/packages/web/src/index.tsx#L14-L20), [`packages/api/src/routes/transfers.ts:12-13`](file:///c:/Users/Gopi/Dev%20shit/Personal/void_share/DSFS/packages/api/src/routes/transfers.ts#L12-L13) |
| **Download Quota Selector** | Options for 1 (atomic single-use), 5, 10, 25, 100 downloads. | [`packages/web/src/index.tsx:22-28`](file:///c:/Users/Gopi/Dev%20shit/Personal/void_share/DSFS/packages/web/src/index.tsx#L22-L28) |
| **Progress Tracking** | Progress bar showing percentage, stage (`preparing`, `uploading`, `finalizing`), and chunk counts. | [`packages/web/src/transfer.ts:15-21`](file:///c:/Users/Gopi/Dev%20shit/Personal/void_share/DSFS/packages/web/src/transfer.ts#L15-L21), [`packages/web/src/index.tsx:670-683`](file:///c:/Users/Gopi/Dev%20shit/Personal/void_share/DSFS/packages/web/src/index.tsx#L670-L683) |
| **0-Byte Empty File Guard** | Guard added to `handleFileSelect` displaying an alert card if `file.size === 0`. | [`packages/web/src/index.tsx:316-324`](file:///c:/Users/Gopi/Dev%20shit/Personal/void_share/DSFS/packages/web/src/index.tsx#L316-L324) |
| **Transfer Cancellation** | `AbortController` wired to chunk fetch calls, allowing graceful upload/download cancellation. | [`packages/web/src/transfer.ts:110`](file:///c:/Users/Gopi/Dev%20shit/Personal/void_share/DSFS/packages/web/src/transfer.ts#L110), [`packages/web/src/index.tsx:375-381`](file:///c:/Users/Gopi/Dev%20shit/Personal/void_share/DSFS/packages/web/src/index.tsx#L375-L381) |
| **Direct & Manual Link Download** | Dedicated "Enter Sharing Link" input tab that extracts `fileId` and `#secret` from any URL or string. | [`packages/web/src/index.tsx:835-853`](file:///c:/Users/Gopi/Dev%20shit/Personal/void_share/DSFS/packages/web/src/index.tsx#L835-L853) |
| **Native Web Share API** | Triggers `navigator.share` on mobile devices with clipboard copy fallback. | [`packages/web/src/index.tsx:734-748`](file:///c:/Users/Gopi/Dev%20shit/Personal/void_share/DSFS/packages/web/src/index.tsx#L734-L748) |

---

### 2.2 Active Frontend Bugs & Immediate Fixes

#### A. Build Break: Missing TypeScript Path Alias (`TS2307`)
- **Location:** [`packages/web/src/index.tsx:5`](file:///c:/Users/Gopi/Dev%20shit/Personal/void_share/DSFS/packages/web/src/index.tsx#L5)
  ```typescript
  import { GradientBars } from '@/components/ui/GradientBars';
  ```
- **Error:**
  ```text
  src/index.tsx(5,30): error TS2307: Cannot find module '@/components/ui/GradientBars' or its corresponding type declarations.
  ```
- **Root Cause:**
  [`packages/web/vite.config.ts`](file:///c:/Users/Gopi/Dev%20shit/Personal/void_share/DSFS/packages/web/vite.config.ts#L12) defines the alias `'@': path.resolve(__dirname, './src')`, but [`packages/web/tsconfig.json`](file:///c:/Users/Gopi/Dev%20shit/Personal/void_share/DSFS/packages/web/tsconfig.json) does not specify `"baseUrl"` or `"paths"`. When `npm run build` runs `tsc -p tsconfig.json`, compilation fails.
- **The Fix:**
  Add path mapping to [`packages/web/tsconfig.json`](file:///c:/Users/Gopi/Dev%20shit/Personal/void_share/DSFS/packages/web/tsconfig.json):
  ```json
  {
    "extends": "../../tsconfig.base.json",
    "compilerOptions": {
      "jsx": "react-jsx",
      "outDir": "dist",
      "baseUrl": ".",
      "paths": {
        "@/*": ["./src/*"]
      }
    },
    "include": ["src/**/*.ts", "src/**/*.tsx"]
  }
  ```
  *(Or change the import in `index.tsx` to relative: `import { GradientBars } from './components/ui/GradientBars';`)*

---

### 2.3 Remaining Frontend Functional Gaps

#### A. Pre-Download File Name & Size Preview
- **Issue:** When a recipient navigates to `/download/:fileId#secret`, the UI shows `Transfer ID` and `256-bit Master Key Verified`, but **does not display the file name or total file size** before downloading. The user must click "Download File" blind.
- **Root Cause:** The encrypted file name and chunk manifest are only returned in `POST /api/transfers/:fileId/access`. However, calling `/access` immediately acquires a 60-second download lease and consumes quota.
- **Solution:** Provide an unauthenticated metadata preview endpoint (or allow capability-authenticated manifest inspection without leasing), so the recipient can decrypt the filename and view the file size prior to initiating chunk downloads.

#### B. True Resumable Uploads (Pause & Resume)
- **Issue:** While cancel/abort is now supported, if a 150 MiB upload fails on chunk 35 of 38, the entire transfer is aborted and discarded.
- **Solution:** The coordinator already provides [`GET /api/transfers/:fileId/status`](file:///c:/Users/Gopi/Dev%20shit/Personal/void_share/DSFS/packages/api/src/routes/transfers.ts#L200) reporting `uploadedChunkIndices` and `missingChunkIndices`. Store active session state (`fileId`, `uploadToken`, `secret`) in `localStorage` or `sessionStorage` so users can resume dropped uploads without re-uploading completed chunks.

#### C. Browser Memory Overhead on Downloads (Monolithic Blob)
- **Issue:** [`packages/web/src/transfer.ts:338-344`](file:///c:/Users/Gopi/Dev%20shit/Personal/void_share/DSFS/packages/web/src/transfer.ts#L338-L344) concatenates all decrypted chunks into a single `Uint8Array` in memory and creates a `Blob`. For 200 MiB files, this consumes 400–600 MiB of browser heap, risking tab crashes on mobile browsers.
- **Solution:** Use the **File System Access API** (`showSaveFilePicker()` and `writable.write()`) to stream decrypted chunks directly to disk. Fall back to memory Blob only when the API is unavailable.

#### D. Browser History & Routing Integration
- **Issue:** The UI wizard maintains internal step state (`select` $\rightarrow$ `configure` $\rightarrow$ `review`). Clicking the browser Back button navigates away from the page rather than stepping back in the wizard.
- **Solution:** Hook wizard step transitions into the HTML5 History API (`window.history.pushState` and `window.addEventListener('popstate', ...)`).

---

## 3. Distributed Backend Gaps: What Is Not Done (Unwired Components)

### 3.1 Background Worker Orchestration & Scheduling
- **Affected Files:**
  - [`packages/api/src/cleanup/cleanup.ts`](file:///c:/Users/Gopi/Dev%20shit/Personal/void_share/DSFS/packages/api/src/cleanup/cleanup.ts)
  - [`packages/api/src/recovery/recovery.ts`](file:///c:/Users/Gopi/Dev%20shit/Personal/void_share/DSFS/packages/api/src/recovery/recovery.ts)
  - [`packages/api/src/main.ts`](file:///c:/Users/Gopi/Dev%20shit/Personal/void_share/DSFS/packages/api/src/main.ts)
- **Current State:**
  - [`ExpirationSweeper`](file:///c:/Users/Gopi/Dev%20shit/Personal/void_share/DSFS/packages/api/src/cleanup/cleanup.ts#L15), [`StorageReconciler`](file:///c:/Users/Gopi/Dev%20shit/Personal/void_share/DSFS/packages/api/src/cleanup/cleanup.ts#L70), and [`RecoveryService`](file:///c:/Users/Gopi/Dev%20shit/Personal/void_share/DSFS/packages/api/src/recovery/recovery.ts#L16) are fully tested in unit tests, but **are never scheduled in `main.ts`**.
- **Consequences:**
  - Expired transfers, consumed single-use transfers, and abandoned uploads **are never purged from storage nodes**.
  - If a storage node crashes, under-replicated chunks are never re-replicated automatically.
- **What Needs to Be Done:**
  - Wire background intervals in [`packages/api/src/main.ts`](file:///c:/Users/Gopi/Dev%20shit/Personal/void_share/DSFS/packages/api/src/main.ts):
    ```typescript
    const sweeper = new ExpirationSweeper(database, cleanupTargets);
    const recovery = new RecoveryService(database, nodeTargets);
    const reconciler = new StorageReconciler(database, reconciliationTargets);

    setInterval(async () => {
      try { await sweeper.sweep(); } catch (err) { app.log.error(err); }
    }, 30_000).unref();

    setInterval(async () => {
      try { await recovery.recoverUnderReplicated(); } catch (err) { app.log.error(err); }
    }, 60_000).unref();
    ```

---

### 3.2 Storage Node Heartbeat Emitter
- **Affected Files:**
  - [`packages/storage-node/src/server.ts`](file:///c:/Users/Gopi/Dev%20shit/Personal/void_share/DSFS/packages/storage-node/src/server.ts)
  - [`packages/api/src/health/routes.ts`](file:///c:/Users/Gopi/Dev%20shit/Personal/void_share/DSFS/packages/api/src/health/routes.ts)
- **Current State:**
  - Storage node instances do not send heartbeat pings. The API's `/api/nodes/heartbeat` endpoint remains untouched by storage nodes.
- **What Needs to Be Done:**
  - Add a 10-second timer to [`packages/storage-node/src/server.ts`](file:///c:/Users/Gopi/Dev%20shit/Personal/void_share/DSFS/packages/storage-node/src/server.ts) that reports `{ nodeId, endpointUrl, totalCapacityBytes, usedCapacityBytes, activeOperations, healthStatus }` to the API coordinator.

---

### 3.3 Node Health Monitoring Background Loop
- **Affected Files:**
  - [`packages/api/src/health/monitor.ts`](file:///c:/Users/Gopi/Dev%20shit/Personal/void_share/DSFS/packages/api/src/health/monitor.ts)
  - [`packages/api/src/main.ts`](file:///c:/Users/Gopi/Dev%20shit/Personal/void_share/DSFS/packages/api/src/main.ts)
- **Current State:**
  - [`HealthMonitor.refresh()`](file:///c:/Users/Gopi/Dev%20shit/Personal/void_share/DSFS/packages/api/src/health/monitor.ts#L38) only runs when manually triggered via `GET /api/nodes/health`.
- **What Needs to Be Done:**
  - Run `monitor.refresh()` every 5–10 seconds in [`main.ts`](file:///c:/Users/Gopi/Dev%20shit/Personal/void_share/DSFS/packages/api/src/main.ts). When a node transitions to `UNAVAILABLE`, trigger an immediate `recovery.recoverUnderReplicated()` run.

---

### 3.4 Storage Node Control Plane Authentication
- **Affected Files:**
  - [`packages/storage-node/src/server.ts`](file:///c:/Users/Gopi/Dev%20shit/Personal/void_share/DSFS/packages/storage-node/src/server.ts)
  - [`packages/api/src/services/storage-client.ts`](file:///c:/Users/Gopi/Dev%20shit/Personal/void_share/DSFS/packages/api/src/services/storage-client.ts)
- **Current State:**
  - Storage node routes (`/chunks/:id`, `/chunks`, `/health`) accept unauthenticated requests on ports 9001–9003. Anyone on the network can enumerate or delete stored chunks.
- **What Needs to Be Done:**
  - Enforce an internal cluster secret header (`Authorization: Bearer <STORAGE_CLUSTER_SECRET>` or mutual TLS) on all storage node HTTP endpoints.

---

### 3.5 CLI Command-Line Executable
- **Affected Files:**
  - [`packages/cli/package.json`](file:///c:/Users/Gopi/Dev%20shit/Personal/void_share/DSFS/packages/cli/package.json)
  - [`packages/cli/src/client.ts`](file:///c:/Users/Gopi/Dev%20shit/Personal/void_share/DSFS/packages/cli/src/client.ts)
- **Current State:**
  - `packages/cli` is only a programmatic Node library. It does not provide a terminal executable command or CLI argument parser.
- **What Needs to Be Done:**
  - Add a `bin` entry in `packages/cli/package.json` with a command-line script (`voidshare upload <path>`, `voidshare download <link>`).

---

### 3.6 Containerization & Docker Compose Topology
- **Affected Files:**
  - Monorepo root / `DSFS/`
- **Current State:**
  - Local nodes are run using `scripts/run-storage-nodes.mjs` on the host machine. There is no `docker-compose.yml` to simulate isolated container networks and storage volumes.
- **What Needs to Be Done:**
  - Create a `docker-compose.yml` defining the API and 3 storage node containers with isolated network bridges and named volumes.

---

## 4. Security, Performance & Architectural Issues to Fix

### 4.1 Critical Security: Static Zero IV on Filename Encryption
- **Location:** [`packages/shared/src/crypto.ts:5`](file:///c:/Users/Gopi/Dev%20shit/Personal/void_share/DSFS/packages/shared/src/crypto.ts#L5)
  ```typescript
  const FILENAME_IV = new Uint8Array(CHUNK_IV_BYTES); // All 12 bytes are 0x00
  ```
- **The Vulnerability:**
  - AES-GCM requires a unique IV for every encryption under a given key. Static IV reuse completely breaks GCM authentication and confidentiality.
- **The Fix:**
  - Generate a random 12-byte IV for filename encryption and prepend it to the ciphertext output: `payload = IV (12 bytes) || ciphertext || tag (16 bytes)`. Update `decryptFilename` to read the first 12 bytes as IV.

---

### 4.2 Memory Leak: In-Memory Rate Limiter Map
- **Location:** [`packages/api/src/hardening/rate-limit.ts:7-29`](file:///c:/Users/Gopi/Dev%20shit/Personal/void_share/DSFS/packages/api/src/hardening/rate-limit.ts#L7-L29)
  ```typescript
  export class RouteRateLimiter {
    private readonly counters = new Map<string, Counter>();
    ...
  }
  ```
- **The Issue:**
  - Counters for IP addresses are added to `this.counters` on check, but expired keys are **never pruned**. Over time, the map grows indefinitely.
- **The Fix:**
  - Add periodic eviction of keys where `counter.resetAt <= Date.now()`, or use a fixed-capacity LRU cache.

---

### 4.3 Disk I/O Bottleneck: Sequential Stat in Storage Node `healthCheck()`
- **Location:** [`packages/storage-node/src/storage.ts:126-132`](file:///c:/Users/Gopi/Dev%20shit/Personal/void_share/DSFS/packages/storage-node/src/storage.ts#L126-L132)
  ```typescript
  const entries = await readdir(this.root, { withFileTypes: true });
  let usedCapacityBytes = 0;
  for (const entry of entries) {
    if (!entry.isFile() || entry.name.endsWith('.tmp')) continue;
    usedCapacityBytes += (await stat(this.chunkPath(entry.name))).size;
  }
  ```
- **The Issue:**
  - Every health check performs an individual `stat()` on every file in the storage directory sequentially. With tens of thousands of chunks, this locks disk I/O.
- **The Fix:**
  - Track `usedCapacityBytes` in memory: increment on `putChunk()`, decrement on `deleteChunk()`. Only scan the directory on initial server boot.

---

### 4.4 Heap Memory Pressure: API Buffering Whole Chunks During Replication
- **Location:** [`packages/api/src/routes/transfers.ts:150-154`](file:///c:/Users/Gopi/Dev%20shit/Personal/void_share/DSFS/packages/api/src/routes/transfers.ts#L150-L154)
- **The Issue:**
  - The API coordinator concatenates incoming chunk streams into a monolithic `Buffer` before dispatching to replica nodes.
- **The Fix:**
  - Fan out chunk bytes to both storage nodes using a streaming `PassThrough` pipeline with backpressure.

---

### 4.5 Browser Memory Crash: In-Memory Blob Assembly for Downloads
- **Location:** [`packages/web/src/transfer.ts:338-344`](file:///c:/Users/Gopi/Dev%20shit/Personal/void_share/DSFS/packages/web/src/transfer.ts#L338-L344)
- **The Issue:**
  - Large downloads build a monolithic 200 MiB `Uint8Array` in tab memory, consuming over 400 MiB of browser heap.
- **The Fix:**
  - Stream chunks to disk via the File System Access API where supported.

---

### 4.6 Unauthenticated Internal Health & Heartbeat Endpoints
- **Location:** [`packages/api/src/health/routes.ts:17-29`](file:///c:/Users/Gopi/Dev%20shit/Personal/void_share/DSFS/packages/api/src/health/routes.ts#L17-L29)
- **The Risk:**
  - Anyone can query `/api/nodes/health` to view internal storage infrastructure, or POST rogue heartbeat data to `/api/nodes/heartbeat`.
- **The Fix:**
  - Require internal cluster bearer token authorization or bind to private loopback interface (`127.0.0.1`).

---

### 4.7 Single Points of Failure: SQLite & Single Fastify Instance
- **Location:** [`packages/api/src/main.ts:12`](file:///c:/Users/Gopi/Dev%20shit/Personal/void_share/DSFS/packages/api/src/main.ts#L12)
- **The Limitation:**
  - `better-sqlite3` runs on a single host. Horizontal scaling of the API is impossible without migrating metadata to PostgreSQL with advisory row-locks and Redis for shared rate limiting.

---

## 5. Updated Prioritized Implementation Backlog

| Priority | Task | Affected Files | Expected Outcome |
| :---: | :--- | :--- | :--- |
| **P0** | **Fix TypeScript build error in Web client** | [`packages/web/tsconfig.json`](file:///c:/Users/Gopi/Dev%20shit/Personal/void_share/DSFS/packages/web/tsconfig.json) | Restores passing `npm run build` by mapping `@/*` path alias |
| **P0** | **Fix static zero IV on filename encryption** | [`packages/shared/src/crypto.ts`](file:///c:/Users/Gopi/Dev%20shit/Personal/void_share/DSFS/packages/shared/src/crypto.ts) | Prevents cryptographic vulnerability in AES-GCM filename cipher |
| **P0** | **Schedule Expiration Sweeper in API** | [`packages/api/src/main.ts`](file:///c:/Users/Gopi/Dev%20shit/Personal/void_share/DSFS/packages/api/src/main.ts) | Automates actual deletion of expired and consumed files |
| **P0** | **Add storage node heartbeat emitter** | [`packages/storage-node/src/server.ts`](file:///c:/Users/Gopi/Dev%20shit/Personal/void_share/DSFS/packages/storage-node/src/server.ts) | Storage nodes periodically report live status and capacity to API |
| **P1** | **Schedule node health monitor & recovery worker** | [`packages/api/src/main.ts`](file:///c:/Users/Gopi/Dev%20shit/Personal/void_share/DSFS/packages/api/src/main.ts) | Enables automated cluster failure detection and chunk healing |
| **P1** | **Authenticate storage node endpoints** | [`packages/storage-node/src/server.ts`](file:///c:/Users/Gopi/Dev%20shit/Personal/void_share/DSFS/packages/storage-node/src/server.ts), [`packages/api/src/services/storage-client.ts`](file:///c:/Users/Gopi/Dev%20shit/Personal/void_share/DSFS/packages/api/src/services/storage-client.ts) | Protects direct storage node chunk access on ports 9001–9003 |
| **P1** | **Fix in-memory rate limiter leak** | [`packages/api/src/hardening/rate-limit.ts`](file:///c:/Users/Gopi/Dev%20shit/Personal/void_share/DSFS/packages/api/src/hardening/rate-limit.ts) | Prevents unbounded memory growth in API rate limiter |
| **P2** | **Fix storage node `healthCheck()` disk stat loop** | [`packages/storage-node/src/storage.ts`](file:///c:/Users/Gopi/Dev%20shit/Personal/void_share/DSFS/packages/storage-node/src/storage.ts) | Eliminates disk I/O lockup on storage nodes |
| **P2** | **Pre-download metadata inspection in Web UI** | [`packages/web/src/index.tsx`](file:///c:/Users/Gopi/Dev%20shit/Personal/void_share/DSFS/packages/web/src/index.tsx), [`packages/api/src/routes/transfers.ts`](file:///c:/Users/Gopi/Dev%20shit/Personal/void_share/DSFS/packages/api/src/routes/transfers.ts) | Displays file name and size before user initiates chunk download |
| **P2** | **Implement terminal executable for CLI package** | [`packages/cli/`](file:///c:/Users/Gopi/Dev%20shit/Personal/void_share/DSFS/packages/cli/) | Delivers terminal command-line binary for headless transfers |
| **P3** | **Streaming upload fan-out & streaming disk download** | [`packages/api/src/routes/transfers.ts`](file:///c:/Users/Gopi/Dev%20shit/Personal/void_share/DSFS/packages/api/src/routes/transfers.ts), [`packages/web/src/transfer.ts`](file:///c:/Users/Gopi/Dev%20shit/Personal/void_share/DSFS/packages/web/src/transfer.ts) | Removes in-memory RAM buffering bottlenecks on large transfers |
| **P3** | **Add Docker Compose cluster simulation** | Monorepo root | Provides isolated container environment for nodes and API |
