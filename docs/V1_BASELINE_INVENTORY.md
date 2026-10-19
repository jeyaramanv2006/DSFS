# VoidShare V1 Baseline Inventory & Runtime Map

**Date:** 2026-10-20  
**Git Branch:** `main`  
**Git Commit Baseline:** `2d47f0c`  

---

## 1. Baseline Test and Build Results

### 1.1 Automated Test Suite (`npm test`)
- **Framework:** Vitest v5.0.3
- **Result:** **PASS** (15 test files, 62 tests, 0 failures)
- **Duration:** 1.67s
- **Breakdown:**
  - `packages/api/src/replication/read-service.test.ts` (2 tests) - PASS
  - `packages/api/src/health/monitor.test.ts` (2 tests) - PASS
  - `packages/api/src/db/database.test.ts` (7 tests) - PASS
  - `packages/api/src/placement/service.test.ts` (3 tests) - PASS
  - `packages/api/src/recovery/recovery.test.ts` (3 tests) - PASS
  - `packages/api/src/placement/ring.test.ts` (4 tests) - PASS
  - `packages/api/src/cleanup/cleanup.test.ts` (3 tests) - PASS
  - `packages/shared/src/crypto.test.ts` (11 tests) - PASS
  - `packages/storage-node/src/storage.test.ts` (4 tests) - PASS
  - `packages/api/src/replication/replication.test.ts` (3 tests) - PASS
  - `packages/storage-node/src/server.test.ts` (3 tests) - PASS
  - `packages/api/src/health/routes.test.ts` (2 tests) - PASS
  - `packages/api/src/hardening/hardening.test.ts` (2 tests) - PASS
  - `packages/api/src/routes/transfers.test.ts` (11 tests) - PASS
  - `packages/cli/src/client.test.ts` (2 tests) - PASS

### 1.2 Monorepo Build (`npm run build`)
- **Command:** `npm run build --workspaces`
- **Result:** **FAIL** (Exit code 2)
- **Status per package:**
  - `@voidshare/api@0.1.0`: PASS (`tsc -p tsconfig.json`)
  - `@voidshare/cli@0.1.0`: PASS (`tsc -p tsconfig.json`)
  - `@voidshare/shared@0.1.0`: PASS (`tsc -p tsconfig.json`)
  - `@voidshare/storage-node@0.1.0`: PASS (`tsc -p tsconfig.json`)
  - `@voidshare/web@0.1.0`: **FAIL** (`tsc -p tsconfig.json && vite build`)
    - Error: `src/index.tsx(5,30): error TS2307: Cannot find module '@/components/ui/GradientBars' or its corresponding type declarations.`
    - Root cause: `packages/web/vite.config.ts` defines `@/` alias pointing to `./src`, but `packages/web/tsconfig.json` lacks `"baseUrl": "."` and `"paths": { "@/*": ["src/*"] }`.

---

## 2. Package Inventory

| Package | Role | Status / Notes |
|---------|------|----------------|
| `packages/shared` | Core crypto (`Web Crypto AES-256-GCM`, `HKDF-SHA-256`), types | Builds. Critical vulnerability: `encryptFilename` uses fixed zero IV (`FILENAME_IV`). |
| `packages/api` | Fastify coordinator, SQLite DB (`better-sqlite3`), placement ring, replication, rate limiter, health monitor | Builds. Background loops unwired in `main.ts`. Heartbeat route unauthenticated. |
| `packages/storage-node` | Fastify storage daemon, `FilesystemChunkStore` | Builds. Chunk routes unauthenticated. Missing heartbeat emitter. `healthCheck()` does sequential `stat()` on every chunk file. |
| `packages/web` | React 19 + Vite frontend (Linear UI design) | Build fails on path alias `TS2307`. Retrieval code flow not yet implemented. Cluster dashboard not yet implemented. |
| `packages/cli` | Reference CLI client for encrypted upload/download | Builds and tests pass (encrypted round trip verified). |

---

## 3. Runtime Dependency and Flow Map

### 3.1 Coordinator Initialization (`packages/api/src/main.ts`)
1. Reads `DB_PATH` (defaults to `./data/api.db`), runs migrations from `packages/api/src/db/schema.sql`.
2. Parses `STORAGE_NODES` env var (comma-separated `id=url`).
3. Registers each node directly as `status: 'HEALTHY'` in SQLite without verifying reachability.
4. Initializes `ReplicationService`, `PlacementService`, `ReplicaReadService`.
5. Starts Fastify HTTP server on `0.0.0.0:${PORT:-8080}`.
6. **Defects identified:**
   - Pre-registers unverified nodes as `HEALTHY`.
   - `HealthMonitor`, `ExpirationSweeper`, `StorageReconciler`, and `RecoveryService` background loops are never scheduled or started.

### 3.2 Storage Node Daemon (`packages/storage-node/src/server.ts`)
1. Starts Fastify server on `0.0.0.0:${PORT:-9001}` with `FilesystemChunkStore` at `DATA_DIR`.
2. Serves `PUT /chunks/:chunkId`, `GET /chunks/:chunkId`, `HEAD /chunks/:chunkId`, `DELETE /chunks/:chunkId`, `GET /chunks`, `GET /health`.
3. **Defects identified:**
   - No authentication header check on any chunk route (accepts arbitrary unauthenticated writes/reads).
   - No heartbeat emitter process running to ping the coordinator.
   - `activeOperations` is hardcoded to 0; no concurrency tracking.
   - `healthCheck()` invokes sequential filesystem `stat()` on all stored chunk files.

### 3.3 Storage Node Client & Replication Flow
1. Client initializes transfer via `POST /api/transfers`.
2. API validates parameters, calculates chunk count, inserts `transfers` record, returns upload token and chunk URLs.
3. Client encrypts each chunk (AES-256-GCM with fresh 12-byte IV and AAD `fileId || chunkIndex || totalChunks`), computes SHA-256 checksum, uploads to `PUT /api/transfers/:fileId/chunks/:index`.
4. API buffers chunk in memory, computes placement via `ConsistentHashRing` (128 virtual nodes per healthy node), fans out writes to storage nodes via `HttpStorageNodeClient`.
5. API records confirmed replicas in `chunk_replicas` and placements in `chunk_placements`.
6. Client finalizes transfer via `POST /api/transfers/:fileId/finalize`.
7. **Defects identified:**
   - Read path (`GET /api/transfers/:fileId/chunks/:index`) falls back to `readService ?? storageClient`, where `storageClient` defaults to `localhost:9001`.
   - When a node is down, durable upload acknowledgement must strictly require both replicas (RF=2) before claiming success.

### 3.4 Download Retrieval Flow
1. Recipient provides transfer link (`/download/<fileId>#<secretHex>`).
2. Browser derives `capability_hash` and requests `POST /api/transfers/:fileId/access`.
3. API checks quota and expiration, leases transfer (`DOWNLOADING`), returns `downloadToken` and chunk manifest.
4. Browser downloads each chunk from `GET /api/transfers/:fileId/chunks/:index` with `Bearer <downloadToken>`.
5. Browser decrypts chunks locally in Web Crypto and reconstructs original file.
6. Browser sends `POST /api/transfers/:fileId/complete`.

---

## 4. Database Schema State (`packages/api/src/db/schema.sql`)

- **Existing Tables:**
  - `transfers` (`file_id`, `capability_hash`, `upload_session_hash`, `download_token_hash`, `download_token_expires_at`, `original_name_encrypted`, `total_size_bytes`, `chunk_count`, `chunk_size_bytes`, `status`, `download_count`, `max_downloads`, `created_at`, `expires_at`, `download_lease_until`, `version`)
  - `chunks` (`chunk_id`, `file_id`, `chunk_index`, `size_bytes`, `checksum_sha256`, `status`)
  - `storage_nodes` (`node_id`, `endpoint_url`, `status`, `total_capacity_bytes`, `used_capacity_bytes`, `active_operations`, `last_heartbeat`)
  - `chunk_replicas` (`replica_id`, `chunk_id`, `node_id`, `status`, `created_at`)
  - `chunk_placements` (`chunk_id`, `node_id`, `placement_rank`, `created_at`)
- **Missing Elements for V1:**
  - `cluster_events` table for cluster health transitions, replication failures, and read failover logs.
  - Index on `transfers(capability_hash)` for capability token lookups (Phase 5).
