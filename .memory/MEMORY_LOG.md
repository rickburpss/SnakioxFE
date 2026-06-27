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

## [2026-06-27] — UX pass, round/mint-spot gating, idempotency + Redis, "off-chain" + snake eyes

### Project Status & Decisions
- Work spanned 3 repos: FE (`SnakioxFE`), backend (`../SnakioxBE`), contract (`../SnakioxDOTSOL`, read-only this session — `mintVault` already existed, no contract change). Storage driver supports json|postgres; **Redis** is now optional shared state.
- Player-facing wording: "backend" → "off-chain" (general UI only; admin UI keeps "backend"/"Backend wallet").
- Invite rule changed to **one code, three chances**: a redeemed code stays valid across all 3 of the wallet's mints (the per-wallet cap of 3 is the real limiter).

### What was added/changed (by file)
- **`src/App.jsx`**
  - **Connect + Sign In merged** into one `CONNECT` (connect → register → load status/results); added `DISCONNECT`. New `DISCONNECT` reducer case in `GameContext.jsx` resets to `initialState`.
  - **`useActionGuard`**: concurrency control + double-submit protection. `run(key, fn)` drops a call while any guarded action is in flight (sync ref check) and exposes `busy` to disable buttons.
  - **Round gating** `isRoundPending(state)`: true from start (playing/dead/locked) until minted (lockedResult has txHash). Locks START + GENERATE so you can't restart or re-generate mid-round.
  - **Mint-spot gating** `mintSpotsLeft(status, supply)` + `canStartRound(state, supply)`: START/GENERATE enabled only while wallet has a spot (not 3/3) AND not mid-round; `mintedOut` shows "All 3 mint spots used." Prefers on-chain `supply.mintedByWallet`, falls back to backend `remainingMints`.
  - Removed hardcoded "ONE CODE. ONE NFT." status line (now only shows backend `reason` when present).
  - **Redeem locked** (input + button disabled) when `isAllowlisted || hasInvite || inviteRequired === false` (OPEN ACCESS counts).
  - **Responsive (640px)**: START/RANDOM/LOAD hidden on small screens via `.desktop-only`; RANDOM+LOAD moved under MINT NFT in RUN OUTPUT via `.mobile-only`. New `MobileActionsPanel` (ACTIONS) renders Replay + Minted strips after RUN OUTPUT since the desktop console is hidden on mobile.
  - **Admin owner actions** added: `mintVault` (owner mint to wallet), `setMintTierPrices`, transfer-validator + auto-approve, delete default royalty.
  - **Snake eyes**: head cell gets `data-dir` (from `game.direction` live, `headDirection(frame)` in replay); CSS draws directional eyes. Replay modal got a playback progress bar.
- **`src/game/snakeEngine.js`**: new `headDirection(snake, fallback)`.
- **`src/api/snakioxApi.js`**: `request()` supports `idempotencyKey` → `Idempotency-Key` header; keys added to start/complete/random/mint-record/redeem.
- **`src/web3/mintContract.js`**: ABI + helpers for `mintVault`, `setMintTierPrices`, `setTransferValidator`, `setAutomaticApprovalOfTransfersFromValidator`, `deleteDefaultRoyalty`. (Also has live-edited `getRevealStatus` + `onStatus` countdown in `mintCompletedRun` — user's change, kept.)
- **`eslint.config.js`**: added `setTimeout` to globals (pre-existing `waitForBlock` use).
- **Backend (`../SnakioxBE`)**
  - `findInviteByWallet` (jsonStore + postgresStore) no longer filters out minted invites → three chances.
  - **Idempotency middleware** `src/middleware/idempotency.js`: dedupes mutating POSTs (replays first response instead of 409). Redis-backed when configured (`SET NX PX` lock at `idemp:lock:<key>`, cached response at `idemp:done:<key>`, concurrent dupes poll then replay), in-memory fallback otherwise. Mounted on `/game` and `/invite`.
  - **Redis** `src/config/redis.js`: lazy shared `rediss://`-capable client, returns null (graceful fallback) if `REDIS_URL` unset or connect fails. `REDIS_URL` added to `env.js`/`.env`/`.env.example`.
  - **Rate limiting** now uses a shared `RedisStore` (pinned `rate-limit-redis@^4`; v5 needs express-rate-limit v8, project is on v7) wrapped in a **fail-open** store (Redis outage → allow request, not 500). Rate limits 300 global / 120 game / 60 admin per IP per 60s — fine (per-IP; doesn't throttle distinct users).

### Problems Solved / Lessons Learned
- START/GENERATE were sticking disabled because they hung off backend `canPlay` (only refreshes on status fetch); fixed by driving them off local round state + on-chain mint count.
- `rate-limit-redis@5` peer-conflicts with express-rate-limit v7 → use v4.
- express-rate-limit v7 has no built-in fail-open → wrap the store and catch in `increment`.

### Verified
- FE `npm run lint` + `npm run build` pass (bundle ~474 kB / ~161 kB gzip).
- BE `npm run lint` (node --check) passes.
- **Redis live-tested against Upstash**: PING→PONG, SET/GET with NX+PX + TTL ok; and idempotency end-to-end — 2nd request with same `Idempotency-Key` replayed the cached body (`Idempotent-Replay: true`) and the handler did NOT run.

### Goals & Next Steps
- Ensure `.env` (now holds a real Upstash `REDIS_URL` with password) is gitignored.
- Multi-instance is now safe (shared idempotency + rate limits) once `REDIS_URL` is set; use Postgres (not json store) in prod.
- Optional: surface the Snakiox Arcade games dApp (`../snakio-games`, "Snakiox Arcade") — wallet-gated, uses the NFT skin to play/earn.

---
