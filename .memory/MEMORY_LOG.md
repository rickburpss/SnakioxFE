# 🧠 Memory Log
> Append-only. Never delete or edit previous entries.
> Initialized: 2026-06-25

---

## [2026-06-25] — Mint flow rework: hash-only mint, replay choice, commit-reveal, random mint, 40-min auto-end

### Project Status & Decisions
- The frontend was updated alongside the Snakiox contract (in `../SnakioxDOTSOL`) and backend (`../SnakioxBE`). All changes serve the new mint flow. Stack: Vite + React, ethers v6, backend at `VITE_API_BASE_URL`, contract at `VITE_MINT_CONTRACT_ADDRESS` (Sepolia by default).
- **NFTs are fully on-chain**: `loadMintedToken` reads `tokenURI`/`svgForToken` from the contract; the FE only displays them.

### What was added/changed (by file)
- **`src/web3/mintContract.js`**
  - Mint ABI evolved to `mintWithGameResult(bytes32 snakeDataHash, uint256 score, uint256 snakeLength, bytes32 sessionHash, bool random, uint256 revealBlock, bytes signature)`. The replay **blob no longer goes on-chain** — only its hash.
  - `mintCompletedRun` now: pays `mintPriceFor(wallet)` (positional pricing), **waits for the commit-reveal block** (`waitForBlock`) so traits are fixed and the tx can't revert as "too early", then mints with `random` + `revealBlock`.
  - New helpers: `saveReplayOnchainTx(tokenId, finalSnakeCells)` (encodes bytes, calls `saveReplayOnchain` via SSTORE2), `saveReplayUriTx(tokenId, uri)`, `waitForBlock(provider, target)`.
  - ABI also exposes `mintPriceFor`, `saveReplayOnchain`, `saveReplayURI`, `replayData`.
  - `normalizeMintPayload` now carries `random` + `revealBlock` and prefers the backend-provided `snakeDataHash` (needed for random mints whose hash is a sentinel, not derived from cells).
- **`src/api/snakioxApi.js`**
  - `replayUrl(sessionId)` → `${API}/replay/:sessionId` (the "store on backend" pointer used as the on-chain replayURI).
  - `generateRandomMint(wallet)` → `POST /game/random` (locked random-score result).
- **`src/state/GameContext.jsx`**
  - New `TIMEOUT` reducer action → sets the game `dead` with `deathReason:"timeout"` (used by the 40-min cap).
- **`src/App.jsx`**
  - `useDialog` gained a `choose(message, options)` mode; `CustomDialog` renders option buttons.
  - **Post-mint replay choice**: after a played mint, a 3-way dialog (ON-CHAIN / BACKEND / DON'T SAVE) wires `saveReplayOnchainTx` / `saveReplayUriTx`. **Skipped for random mints** (no replay).
  - Refactored mint into reusable `mintFromPayload(payload)`; `mintRun` = played, `generateRandomAndMint` = calls `generateRandomMint` then mints the returned payload.
  - **"GENERATE RANDOM & MINT"** button in `ControlPanel` (enabled when `status.canPlay`) — skip playing, get a random score, mint it.
  - `resolveFinalCells` helper (tolerates JSON-string or array) for building the on-chain replay blob.
  - **40-min auto-end**: `MAX_GAME_MS = 40*60*1000` + a `setTimeout` effect that dispatches `TIMEOUT` 40 min after `startedAt`.

### Problems Solved / Lessons Learned
- The mint signature changed several times (added `bool random`, then `uint256 revealBlock`) — keep `mintContract.js` ABI + `mintCompletedRun` args + `normalizeMintPayload` in lockstep with the contract.
- A reloaded locked result (played OR random) must still be mintable, so the FE relies on the backend result response carrying `snakeDataHash`/`revealBlock`/`random` (it does now).
- Random results have no `finalSnakeCells`; their `snakeDataHash` is a backend sentinel — never recompute it on the FE, use the stored value.

### Verified
- `npx vite build` succeeds after every change (final bundle ~460 kB / ~158 kB gzip). Plain JS modules pass `node --check`.

### Goals & Next Steps
- Set `VITE_MINT_CONTRACT_ADDRESS` to the redeployed contract (mint signature changed) and `VITE_API_BASE_URL` to the backend.
- Optional: a distinct "Random" result card (the random result's board preview is empty since nothing was played).

---
