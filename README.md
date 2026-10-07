# VoidShare

VoidShare is an ephemeral, end-to-end encrypted file-sharing service. Files are encrypted and chunked in the browser or CLI before the API sees them. The server stores ciphertext, token hashes, placement metadata, and lifecycle state; it never receives the decryption key.

## Quick start

Requirements: Node.js 20+ and npm.

```powershell
npm ci
npm test -- --run
npm run build
```

For a local three-node topology, use separate terminals:

```powershell
npm run dev:nodes
npm --workspace @voidshare/api run dev
npm --workspace @voidshare/web run dev
```

Open `http://localhost:5173`. Upload a file, copy the generated link, and open it in a private browser window. The browser keeps the secret in the URL fragment, so it is not sent to the API. The API defaults to `http://localhost:8080` and storage nodes to ports `9001`–`9003`.

## Verification and demo

The clean-clone verification is deliberately reproducible:

```powershell
git clone <repository-url> voidshare
Set-Location voidshare/DSFS
npm ci
npm test -- --run
npm run build
```

The automated suite covers encrypted round trips, tamper detection, resumable uploads, replica failover, lease races, expiry deletion, orphan reconciliation, rate limits, and logging redaction. `scripts/run-storage-nodes.mjs` starts the three-node development topology.

## Security notes

- Keep the entire share link private. Possession of the fragment secret is the download capability.
- The API accepts only derived authorization tokens and stores SHA-256 token hashes.
- Authorization headers and token-shaped request/response fields are redacted from Pino logs.
- Rate limits are process-local for development. A multi-instance deployment must move counters to a shared store.
- Run `npm audit` against the committed `package-lock.json` before release.

See [`docs/SECURITY.md`](docs/SECURITY.md), [`docs/API.md`](docs/API.md), and [`docs/DECISIONS.md`](docs/DECISIONS.md) for the complete contract and threat model.
