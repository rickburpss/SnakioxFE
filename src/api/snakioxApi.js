const API_BASE_URL =
  import.meta.env.VITE_API_BASE_URL?.replace(/\/$/, "") || "http://localhost:3000";

async function request(path, options = {}) {
  const { idempotencyKey, ...fetchOptions } = options;
  const response = await fetch(`${API_BASE_URL}${path}`, {
    headers: {
      "Content-Type": "application/json",
      // Lets the server dedupe retries/double-submits of the same logical action
      // instead of returning a 409 Conflict.
      ...(idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {}),
      ...fetchOptions.headers
    },
    ...fetchOptions
  });

  const payload = await response.json().catch(() => ({}));

  if (!response.ok) {
    const error = new Error(
      payload.message || payload.error || "Snakiox backend request failed"
    );
    // Preserve the status so callers can tell a retryable overload (503/429)
    // from a terminal 4xx, and honor a server-suggested backoff if present.
    error.status = response.status;
    error.retryAfterMs = parseRetryAfter(response.headers.get("Retry-After"));
    throw error;
  }

  return payload;
}

function parseRetryAfter(header) {
  const seconds = Number(header);
  return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : null;
}

// Retries idempotent calls when the backend sheds load (503) or rate-limits
// (429). Uses exponential backoff with jitter so a herd of shed clients doesn't
// resync and re-create the spike. Terminal errors (4xx) bubble up immediately.
async function requestWithRetry(path, options = {}, { retries = 4, onRetry } = {}) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await request(path, options);
    } catch (error) {
      const retryable = error.status === 503 || error.status === 429;
      if (!retryable || attempt >= retries) throw error;

      const base = error.retryAfterMs ?? 400 * 2 ** attempt;
      const delay = base + Math.random() * base * 0.5;
      // Let the UI surface a "busy — retrying" state for the backoff window.
      onRetry?.({ attempt: attempt + 1, retries, delayMs: delay });
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
}

export function getRegistrationMessage(wallet) {
  return request(`/auth/message/${wallet}`);
}

export function registerWallet(wallet, signature) {
  return request("/auth/register", {
    method: "POST",
    body: JSON.stringify({ wallet, signature })
  });
}

export function getGameStatus(wallet) {
  return request(`/game/status/${wallet}`);
}

export function startGame(wallet, { onRetry } = {}) {
  return requestWithRetry(
    "/game/start",
    {
      method: "POST",
      body: JSON.stringify({ wallet }),
      idempotencyKey: `start:${wallet}`
    },
    { onRetry }
  );
}

export function completeGame(result, { onRetry } = {}) {
  return requestWithRetry(
    "/game/complete",
    {
      method: "POST",
      body: JSON.stringify(result),
      // One completion per session — retries dedupe to the same locked result.
      idempotencyKey: `complete:${result.sessionId}`
    },
    { onRetry }
  );
}

// Generates a locked random-score result (no play) ready to mint.
export function generateRandomMint(wallet, { onRetry } = {}) {
  return requestWithRetry(
    "/game/random",
    {
      method: "POST",
      body: JSON.stringify({ wallet }),
      idempotencyKey: `random:${wallet}`
    },
    { onRetry }
  );
}

export function getLockedResult(wallet) {
  return request(`/game/result/${wallet}`);
}

export function getLockedResults(wallet) {
  return request(`/game/results/${wallet}`);
}

export function saveReplay(wallet, sessionId, replayURI) {
  return request("/replay/save", {
    method: "POST",
    body: JSON.stringify({ wallet, sessionId, replayURI })
  });
}

// Public URL where the backend serves a locked run's replay. Used as the
// on-chain replayURI for the "store on the backend" choice.
export function replayUrl(sessionId) {
  return `${API_BASE_URL}/replay/${sessionId}`;
}

export function recordMint(wallet, sessionId, tokenId, txHash, { onRetry } = {}) {
  return requestWithRetry(
    "/game/mint-record",
    {
      method: "POST",
      body: JSON.stringify({ wallet, sessionId, tokenId, txHash }),
      // One mint record per session — guards against double submits.
      idempotencyKey: `mint-record:${sessionId}`
    },
    { onRetry }
  );
}

export function getInviteRedeemMessage(wallet, code) {
  return request(`/invite/redeem/message/${wallet}/${code}`);
}

export function redeemInvite(wallet, code, signature) {
  return request("/invite/redeem", {
    method: "POST",
    body: JSON.stringify({ wallet, code, signature }),
    idempotencyKey: `redeem:${wallet}:${code}`
  });
}

export function getInviteAdminMessage(wallet) {
  return request(`/invite/admin/message/${wallet}`);
}

export function generateInviteCodes(wallet, signature, count) {
  return request("/invite/admin/generate", {
    method: "POST",
    body: JSON.stringify({ wallet, signature, count })
  });
}

export function listInviteCodes(wallet, signature) {
  return request("/invite/admin/list", {
    method: "POST",
    body: JSON.stringify({ wallet, signature })
  });
}

export function clearInviteCodes(wallet, signature) {
  return request("/invite/admin/clear", {
    method: "POST",
    body: JSON.stringify({ wallet, signature })
  });
}

export function readInviteSettings(wallet, signature) {
  return request("/invite/admin/settings/read", {
    method: "POST",
    body: JSON.stringify({ wallet, signature })
  });
}

export function updateInviteSettings(wallet, signature, inviteRequired) {
  return request("/invite/admin/settings", {
    method: "POST",
    body: JSON.stringify({ wallet, signature, inviteRequired })
  });
}

export function listAllowlist(wallet, signature) {
  return request("/invite/admin/allowlist/list", {
    method: "POST",
    body: JSON.stringify({ wallet, signature })
  });
}

export function addAllowlistWallets(wallet, signature, wallets) {
  return request("/invite/admin/allowlist/add", {
    method: "POST",
    body: JSON.stringify({ wallet, signature, wallets })
  });
}

export function removeAllowlistWallet(wallet, signature, targetWallet) {
  return request("/invite/admin/allowlist/remove", {
    method: "POST",
    body: JSON.stringify({ wallet, signature, targetWallet })
  });
}

export function clearAllowlist(wallet, signature) {
  return request("/invite/admin/allowlist/clear", {
    method: "POST",
    body: JSON.stringify({ wallet, signature })
  });
}

// Admin: expire a wallet's locked-but-unminted run so it can play again.
export function abandonPendingSession(wallet, signature, targetWallet) {
  return request("/invite/admin/session/abandon", {
    method: "POST",
    body: JSON.stringify({ wallet, signature, targetWallet })
  });
}

export { API_BASE_URL };
