# Risk Log & Mitigations - VoidShare

This document logs identified technical, security, operational, and architectural risks along with their mitigation strategies.

---

## 1. Distributed Systems Risks

| Risk ID | Description & Impact | Probability | Severity | Mitigation Strategy |
| :--- | :--- | :--- | :--- | :--- |
| **RSK-DS-01** | **Race Condition on Single-Use File Expiration**<br>Simultaneous download request arrives exactly as the expiration worker begins deleting chunks. | Medium | High | Atomic database state transition (`READY` → `DOWNLOADING` / `DELETING`). Expiration worker checks for in-flight download locks before initiating chunk deletion. |
| **RSK-DS-02** | **Stale Chunk Resurfacing from Reconnected Node**<br>A storage node goes offline, transfers expire, and the node reconnects with expired chunk files. | Medium | Medium | Storage nodes entering `RECOVERING` status must synchronize their local chunk index against the active metadata database and purge orphaned/expired chunks. |
| **RSK-DS-03** | **Cascade Under-Replication on Multi-Node Failure**<br>Simultaneous failure of multiple storage nodes reduces chunk copies below recovery threshold. | Low | Critical | Implement configurable replication factor ($N \ge 2$) with rack/node-diversity placement. Recovery worker proactively re-replicates chunks upon single-node heartbeat loss. |
| **RSK-DS-04** | **Replication Interruptions & Partial Uploads**<br>Client disconnects mid-upload, leaving partial chunks scattered across nodes. | High | Low | Incomplete transfers remain in `CREATING` state with a short TTL (e.g., 30 minutes). Orphan cleanup sweeper automatically purges unfinalized chunks. |

---

## 2. Security & Cryptographic Risks

| Risk ID | Description & Impact | Probability | Severity | Mitigation Strategy |
| :--- | :--- | :--- | :--- | :--- |
| **RSK-SEC-01** | **Storage Node Chunk Tampering / Bit-Rot**<br>A compromised or malfunctioning storage node corrupts encrypted chunk payloads. | Low | High | Mandatory AES-GCM 128-bit authentication tags combined with SHA-256 ciphertext checksums verified by the client prior to reassembly. Corrupt chunks trigger replica failover. |
| **RSK-SEC-02** | **Secret / Key Leakage in Server Logs**<br>Application loggers inadvertently record decryption keys or URL parameters. | Medium | Critical | Secrets reside in URL hash fragments (`#secret`) which are never sent over HTTP headers. Loggers enforce strict sanitization rules prohibiting secret fields. |
| **RSK-SEC-03** | **File ID Guessing & Metadata Enumeration**<br>Attackers script brute-force requests to discover active transfer files. | Low | Medium | High-entropy 128-bit random IDs. The API returns generic `404 Not Found` without disclosing file existence until a valid capability token is presented. |
| **RSK-SEC-04** | **Browser Memory Exhaustion on Large Files**<br>Encrypting multi-gigabyte files in-memory crashes browser tabs. | Medium | Medium | Stream-based chunking (`File.slice()`) processes 4MB blocks sequentially/concurrently without loading entire files into memory. |

---

## 3. Operational & Resource Risks

| Risk ID | Description & Impact | Probability | Severity | Mitigation Strategy |
| :--- | :--- | :--- | :--- | :--- |
| **RSK-OPS-01** | **Temporary Storage Spikes**<br>High concurrent upload volume exhausts node disk capacity before expiration triggers. | Medium | High | Capacity-aware placement engine skips nodes with $<10\%$ free space. Expiration worker runs at high frequency (e.g. every 60s) to reclaim storage rapidly. |
| **RSK-OPS-02** | **Orphaned Storage Chunks**<br>Network dropouts during chunk deletion leave isolated chunk files on disk. | Medium | Low | Periodic background reconciliation worker compares physical disk files against the active database chunk catalog to purge orphans. |

---

## 4. Engineering & Architectural Risks

| Risk ID | Description & Impact | Probability | Severity | Mitigation Strategy |
| :--- | :--- | :--- | :--- | :--- |
| **RSK-ENG-01** | **"Buzzword Architecture" Overhead**<br>Implementing complex distributed algorithms (Raft, Paxos) that add maintenance burden without practical application need. | Medium | Medium | Adhere to Section 44/88: Every mechanism must directly solve an identified application requirement (placement, failover, TTL cleanup, concurrency). |
| **RSK-ENG-02** | **Regression of Existing Frontend/Backend**<br>Rewriting functional code while attempting to add distributed features. | Medium | High | Follow Section 62/63: Map existing routes and UI first; build distributed node abstractions incrementally around existing modules. |

## 5. Phase 13 Release Risks

| Risk ID | Description & Impact | Probability | Severity | Mitigation Strategy |
| :--- | :--- | :--- | :--- | :--- |
| **RSK-SEC-05** | **Credential leakage through structured request logs**<br>Authorization headers or one-time tokens could be copied into operational logs. | Low | Critical | Pino redaction removes authorization and token-shaped request/response fields; regression tests lock the redaction paths. |
| **RSK-OPS-03** | **Rate-limit divergence across API instances**<br>Process-local counters permit multiplied request budgets when horizontally scaled. | Medium | Medium | Document the limitation and require a shared limiter store before multi-instance deployment. |
| **RSK-OPS-04** | **Release dependency drift**<br>Installing from an uncommitted or changing dependency graph can reintroduce vulnerable packages. | Low | High | Release from `package-lock.json` with `npm ci`, run native `npm audit`, and review audit exceptions before shipping. |
