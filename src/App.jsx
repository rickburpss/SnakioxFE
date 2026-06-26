import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Activity,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  CircleStop,
  Copy,
  ExternalLink,
  Gamepad2,
  Image,
  LayoutDashboard,
  RefreshCw,
  RotateCcw,
  ShieldCheck,
  Ticket,
  Trash2,
  Trophy,
  Upload,
  Users,
  Wallet
} from "lucide-react";
import {
  addAllowlistWallets,
  clearAllowlist,
  clearInviteCodes,
  completeGame,
  generateInviteCodes,
  getGameStatus,
  getInviteAdminMessage,
  getInviteRedeemMessage,
  getLockedResults,
  getRegistrationMessage,
  listInviteCodes,
  listAllowlist,
  generateRandomMint,
  recordMint,
  readInviteSettings,
  removeAllowlistWallet,
  redeemInvite,
  registerWallet,
  replayUrl,
  startGame,
  updateInviteSettings
} from "./api/snakioxApi";
import {
  BOARD_SIZE,
  DIRECTIONS,
  START_SNAKE,
  getLevel,
  getSpeed,
  headDirection,
  makeCellKey
} from "./game/snakeEngine";
import { useGame } from "./state/GameContext";
import {
  deleteContractDefaultRoyalty,
  loadContractAdminSnapshot,
  loadMintSupplySnapshot,
  loadMintedToken,
  mintCompletedRun,
  mintVaultToWallet,
  saveReplayOnchainTx,
  saveReplayUriTx,
  setContractAutoApproveTransfers,
  setContractDefaultRoyalty,
  setContractGameSigner,
  setContractMintPrice,
  setContractMintTierPrices,
  setContractTransferValidator,
  transferContractOwnership,
  withdrawContract
} from "./web3/mintContract";

const DIRECTION_KEYS = {
  ArrowUp: "UP",
  w: "UP",
  W: "UP",
  ArrowDown: "DOWN",
  s: "DOWN",
  S: "DOWN",
  ArrowLeft: "LEFT",
  a: "LEFT",
  A: "LEFT",
  ArrowRight: "RIGHT",
  d: "RIGHT",
  D: "RIGHT"
};

const CONTRACT_ADDRESS = import.meta.env.VITE_MINT_CONTRACT_ADDRESS || "";
const OPENSEA_BASE_URL =
  import.meta.env.VITE_OPENSEA_BASE_URL || "https://testnets.opensea.io/assets/sepolia";
const SEPOLIA_ETHERSCAN_BASE_URL = "https://sepolia.etherscan.io";

// Games auto-end after 40 minutes; the score at that moment becomes final.
const MAX_GAME_MS = 40 * 60 * 1000;

function buildOpenSeaAssetUrl(tokenId) {
  if (!CONTRACT_ADDRESS || !tokenId) return "";
  return `${OPENSEA_BASE_URL.replace(/\/$/, "")}/${CONTRACT_ADDRESS}/${tokenId}`;
}

// Best-available final snake cells for the on-chain replay blob, tolerating a
// JSON-string field (as stored on a locked session) or a live array.
function resolveFinalCells(mintPayload, game) {
  const raw =
    mintPayload?.finalSnakeCells ?? game?.lockedResult?.finalSnakeCells ?? game?.snake ?? [];
  if (typeof raw === "string") {
    try {
      return JSON.parse(raw);
    } catch {
      return [];
    }
  }
  return Array.isArray(raw) ? raw : [];
}

function buildEtherscanTxUrl(txHash) {
  if (!txHash) return "";
  return `${SEPOLIA_ETHERSCAN_BASE_URL}/tx/${txHash}`;
}

function App() {
  const { state, dispatch } = useGame();
  const { game } = state;
  const [inviteCode, setInviteCode] = useState("");
  const [supply, setSupply] = useState(null);
  const [isGameModalOpen, setIsGameModalOpen] = useState(false);
  const dialog = useDialog();
  // Concurrency control + double-submit protection: a keyed action started while
  // it (or any other guarded action) is in flight is dropped, and `pending`
  // drives the disabled state of the buttons so rapid clicks can't re-fire.
  const { run, busy } = useActionGuard();
  const level = getLevel(game.score);
  const speed = getSpeed(game.score);
  const completedSessionRef = useRef(null);
  const isAdminPath = window.location.pathname.startsWith("/sekioadmini");

  useEffect(() => {
    const handleKeyDown = (event) => {
      const direction = DIRECTION_KEYS[event.key];
      if (!direction) return;
      event.preventDefault();
      dispatch({ type: "QUEUE_DIRECTION", direction });
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [dispatch]);

  useEffect(() => {
    let cancelled = false;

    loadMintSupplySnapshot(state.wallet || "")
      .then((nextSupply) => {
        if (!cancelled) setSupply(nextSupply);
      })
      .catch(() => {
        if (!cancelled) setSupply(null);
      });

    return () => {
      cancelled = true;
    };
  }, [state.wallet]);

  useEffect(() => {
    if (game.phase !== "playing") return undefined;

    const timer = window.setInterval(() => {
      dispatch({ type: "STEP" });
    }, speed);

    return () => window.clearInterval(timer);
  }, [dispatch, game.phase, speed]);

  // Auto-end the run 40 minutes after it started (keeps the whole play→mint
  // flow well inside the chain's reveal window).
  useEffect(() => {
    if (game.phase !== "playing" || !game.startedAt) return undefined;
    const remaining = MAX_GAME_MS - (Date.now() - game.startedAt);
    const timer = window.setTimeout(() => dispatch({ type: "TIMEOUT" }), Math.max(remaining, 0));
    return () => window.clearTimeout(timer);
  }, [dispatch, game.phase, game.startedAt]);

  useEffect(() => {
    if (game.phase !== "dead" || !state.wallet || !game.sessionId) return;
    if (completedSessionRef.current === game.sessionId) return;

    completedSessionRef.current = game.sessionId;
    dispatch({ type: "SET_LOADING", label: "Locking run" });

    completeGame({
      sessionId: game.sessionId,
      wallet: state.wallet,
      score: game.score,
      snakeLength: game.snake.length,
      finalSnakeCells: game.snake,
      moves: game.moves,
      deathReason: game.deathReason
    })
      .then((result) => {
        dispatch({ type: "LOCKED", session: result.session, mint: result.mint });
      })
      .catch((error) => {
        dispatch({ type: "SET_ERROR", message: error.message });
      });
  }, [
    dispatch,
    game.deathReason,
    game.moves,
    game.phase,
    game.score,
    game.sessionId,
    game.snake,
    state.wallet
  ]);

  const handleWalletInput = (event) => {
    dispatch({ type: "SET_WALLET", wallet: event.target.value.trim() });
  };

  // One button now connects the wallet AND signs in (registers) in a single
  // flow, so the user never has to click two separate buttons.
  const connectAndSignIn = () =>
    run("connect", async () => {
      if (!window.ethereum) {
        dispatch({ type: "SET_ERROR", message: "Install a browser wallet to connect." });
        return;
      }

      try {
        dispatch({ type: "SET_LOADING", label: "Connecting" });
        const [wallet] = await window.ethereum.request({ method: "eth_requestAccounts" });
        dispatch({ type: "SET_WALLET", wallet });

        dispatch({ type: "SET_LOADING", label: "Signing in" });
        const { message } = await getRegistrationMessage(wallet);
        const signature = await window.ethereum.request({
          method: "personal_sign",
          params: [message, wallet]
        });
        const registered = await registerWallet(wallet, signature);
        const [status, results] = await Promise.all([
          getGameStatus(wallet),
          getLockedResults(wallet).catch(() => ({ sessions: [] }))
        ]);
        dispatch({ type: "REGISTERED", user: registered.user, status });
        dispatch({ type: "RESULTS_LOADED", sessions: results.sessions || [] });
      } catch (error) {
        dispatch({ type: "SET_ERROR", message: error.message });
      }
    });

  // Clears the session locally. (Browser wallets stay "connected" at the
  // extension level; this resets the app so a different wallet can sign in.)
  const disconnect = () => {
    dispatch({ type: "DISCONNECT" });
    setInviteCode("");
    setSupply(null);
    completedSessionRef.current = null;
  };

  const loadStatus = async (wallet = state.wallet) => {
    if (!wallet) return;
    try {
      dispatch({ type: "SET_LOADING", label: "Checking" });
      const [status, results] = await Promise.all([
        getGameStatus(wallet),
        getLockedResults(wallet).catch(() => ({ sessions: [] }))
      ]);
      dispatch({ type: "STATUS_LOADED", status });
      dispatch({ type: "RESULTS_LOADED", sessions: results.sessions || [] });
    } catch (error) {
      dispatch({ type: "SET_ERROR", message: error.message });
    }
  };

  const scanStatus = () => run("status", () => loadStatus());

  const play = () =>
    run("play", async () => {
      if (!state.wallet) {
        dispatch({ type: "SET_ERROR", message: "Connect a wallet before playing." });
        return;
      }

      try {
        completedSessionRef.current = null;
        dispatch({ type: "SET_LOADING", label: "Starting" });
        const session = await startGame(state.wallet);
        dispatch({ type: "STARTED", sessionId: session.sessionId });
      } catch (error) {
        dispatch({ type: "SET_ERROR", message: error.message });
      }
    });

  const redeemCode = () =>
    run("redeem", async () => {
      if (!state.wallet || !inviteCode) {
        dispatch({ type: "SET_ERROR", message: "Connect wallet and enter invite code first." });
        return;
      }

      if (!window.ethereum) {
        dispatch({ type: "SET_ERROR", message: "A browser wallet is required to redeem code." });
        return;
      }

      try {
        dispatch({ type: "SET_LOADING", label: "Redeeming code" });
        const { message, code } = await getInviteRedeemMessage(state.wallet, inviteCode);
        const signature = await window.ethereum.request({
          method: "personal_sign",
          params: [message, state.wallet]
        });
        await redeemInvite(state.wallet, code, signature);
        const status = await getGameStatus(state.wallet);
        dispatch({ type: "STATUS_LOADED", status });
        dialog.notify("Invite code redeemed. This wallet can now play and mint.");
      } catch (error) {
        dispatch({ type: "SET_ERROR", message: error.message });
      }
    });

  const fetchResult = () =>
    run("result", async () => {
      if (!state.wallet) return;
      try {
        dispatch({ type: "SET_LOADING", label: "Loading result" });
        const result = await getLockedResults(state.wallet);
        dispatch({ type: "RESULTS_LOADED", sessions: result.sessions || [] });
      } catch (error) {
        dispatch({ type: "SET_ERROR", message: error.message });
      }
    });

  const mintRun = () => run("mint", () => mintFromPayload(state.mint || state.game.lockedResult));

  // Generate a locked random-score result (no play) and mint it immediately.
  const generateRandomAndMint = () =>
    run("mint", async () => {
      try {
        dispatch({ type: "SET_LOADING", label: "Generating random score" });
        const result = await generateRandomMint(state.wallet);
        dispatch({ type: "LOCKED", session: result.session, mint: result.mint });
        await mintFromPayload(result.mint);
      } catch (error) {
        dispatch({ type: "SET_ERROR", message: error.shortMessage || error.message });
      }
    });

  const mintFromPayload = async (mintPayload) => {
    if (!mintPayload) {
      dispatch({ type: "SET_ERROR", message: "Complete or load a locked run before minting." });
      return;
    }

    try {
      dispatch({ type: "SET_LOADING", label: "Minting" });
      const minted = await mintCompletedRun(mintPayload);
      const sessionId = mintPayload.sessionId || mintPayload.id;
      await recordMint(state.wallet || mintPayload.wallet, sessionId, minted.tokenId, minted.txHash);
      dispatch({ type: "MINTED", tokenId: minted.tokenId, txHash: minted.txHash });
      const [status, nextSupply] = await Promise.all([
        getGameStatus(state.wallet),
        loadMintSupplySnapshot(state.wallet)
      ]);
      dispatch({ type: "STATUS_LOADED", status });
      setSupply(nextSupply);

      // Player chooses where the replay lives: on-chain, backend, or nowhere.
      // Random-score mints never played, so there is no replay to save.
      let replayNote = "Replay not saved.";
      if (mintPayload.random) {
        dialog.notify(`Token #${minted.tokenId} minted. Random score — no replay to save.`);
        return;
      }
      try {
        const choice = await dialog.choose(
          "Where should your game replay live? On-chain is permanent but costs extra gas; Snakiox off-chain storage is free for now.",
          [
            { key: "onchain", label: "ON-CHAIN" },
            { key: "backend", label: "OFF-CHAIN" },
            { key: "none", label: "DON'T SAVE" }
          ],
          "SAVE REPLAY"
        );
        if (choice === "onchain") {
          dispatch({ type: "SET_LOADING", label: "Storing replay on-chain" });
          await saveReplayOnchainTx(minted.tokenId, resolveFinalCells(mintPayload, state.game));
          dispatch({ type: "SET_LOADING", label: "" });
          replayNote = "Replay stored on-chain.";
        } else if (choice === "backend") {
          dispatch({ type: "SET_LOADING", label: "Linking backend replay" });
          await saveReplayUriTx(minted.tokenId, replayUrl(sessionId));
          dispatch({ type: "SET_LOADING", label: "" });
          replayNote = "Replay saved off-chain.";
        }
      } catch (replayError) {
        dispatch({ type: "SET_LOADING", label: "" });
        replayNote = `Replay not saved (${replayError.shortMessage || replayError.message}).`;
      }

      dialog.notify(`Token #${minted.tokenId} minted. ${replayNote}`);
    } catch (error) {
      dispatch({ type: "SET_ERROR", message: error.shortMessage || error.message });
    }
  };

  if (isAdminPath) {
    return (
      <>
        <AdminPage dialog={dialog} />
        <CustomDialog dialog={dialog} />
      </>
    );
  }

  return (
    <>
      <main className="app-shell h-screen max-h-screen overflow-hidden bg-[#142018] text-[#172611] font-arcade">
        <div className="app-layout mx-auto grid h-full max-h-screen w-full max-w-7xl gap-5 px-4 py-4 lg:grid-cols-[330px_minmax(0,1fr)_330px] lg:px-6">
          <ControlPanel
            state={state}
            busy={busy}
            onWalletInput={handleWalletInput}
            onConnect={connectAndSignIn}
            onDisconnect={disconnect}
            inviteCode={inviteCode}
            onInviteCodeChange={setInviteCode}
            onRedeemCode={redeemCode}
            onStatus={scanStatus}
            onStart={play}
            onResult={fetchResult}
            onGenerateRandom={generateRandomAndMint}
          />
          <MobileGameLauncher
            game={game}
            level={level}
            onOpen={() => setIsGameModalOpen(true)}
            speed={speed}
            supply={supply}
          />
          <section className="console-shell desktop-console flex min-h-0 flex-col">
            <div className="brand-strip">
              <span>SNAKIOX</span>
              <span>MODEL XERIA-09</span>
            </div>
            <GameSurface
              dispatch={dispatch}
              game={game}
              level={level}
              sessions={state.lockedResults}
              speed={speed}
              supply={supply}
            />
          </section>
          <ResultPanel
            state={state}
            busy={busy}
            level={level}
            speed={speed}
            onMint={mintRun}
            onGenerateRandom={generateRandomAndMint}
            onResult={fetchResult}
          />
          <MobileActionsPanel sessions={state.lockedResults} />
        </div>
      </main>
      {isGameModalOpen && (
        <MobileGameModal onClose={() => setIsGameModalOpen(false)}>
          <GameSurface
            canStart={Boolean(state.status?.canPlay || state.status?.activeSessionId)}
            dispatch={dispatch}
            game={game}
            isMobile
            level={level}
            onStart={play}
            sessions={state.lockedResults}
            speed={speed}
            supply={supply}
          />
        </MobileGameModal>
      )}
      <CustomDialog dialog={dialog} />
    </>
  );
}

function GameSurface({
  canStart = false,
  dispatch,
  game,
  isMobile = false,
  level,
  onStart,
  sessions,
  speed,
  supply
}) {
  return (
    <div className={["screen-bezel", "flex", "flex-1", "flex-col", isMobile ? "mobile-game-surface" : ""].join(" ")}>
      {isMobile ? null : <MintSupplyTracker supply={supply} />}
      <ScoreLine score={game.score} level={level} speed={speed} phase={game.phase} />
      <div className="mobile-play-layout">
        <SnakeBoard game={game} />
        {isMobile ? (
          <MobileDirectionPad
            canStart={canStart}
            dispatch={dispatch}
            gamePhase={game.phase}
            onStart={onStart}
          />
        ) : null}
      </div>
      {isMobile ? null : <TouchControls dispatch={dispatch} />}
      <ReplayPanel sessions={sessions} />
      <MintedTokensPanel sessions={sessions} />
    </div>
  );
}

function MobileGameLauncher({ game, level, onOpen, speed, supply }) {
  return (
    <section className="mobile-game-card">
      <div className="panel-title">
        <Gamepad2 size={18} />
        SNAKIOX GAME
      </div>
      <MintSupplyTracker supply={supply} />
      <div className="metric-row">
        <span>SCORE</span>
        <strong>{String(game.score).padStart(5, "0")}</strong>
      </div>
      <div className="metric-row">
        <span>LEVEL</span>
        <strong>{level}</strong>
      </div>
      <div className="metric-row">
        <span>SPEED</span>
        <strong>{speed}ms</strong>
      </div>
      <button className="start-button wide" onClick={onOpen} type="button">
        <Gamepad2 size={18} />
        OPEN GAME
      </button>
    </section>
  );
}

function MobileGameModal({ children, onClose }) {
  return (
    <div className="mobile-game-backdrop" role="presentation">
      <section className="mobile-game-modal" role="dialog">
        <div className="brand-strip">
          <span>SNAKIOX PLAYFIELD</span>
          <button className="modal-close" onClick={onClose} type="button">
            CLOSE
          </button>
        </div>
        {children}
      </section>
    </div>
  );
}

function MintSupplyTracker({ supply }) {
  const totalMinted = supply?.totalMinted ?? 0;
  const maxSupply = supply?.maxSupply ?? 6666;
  const percentage = maxSupply > 0 ? Math.min((totalMinted / maxSupply) * 100, 100) : 0;

  return (
    <section className="mint-tracker" aria-label="Mint progress">
      <div className="mint-tracker-top">
        <span>SNAKIOX SUPPLY</span>
        <strong>
          {totalMinted.toLocaleString()} / {maxSupply.toLocaleString()}
        </strong>
      </div>
      <div className="mint-track">
        <div className="mint-track-fill" style={{ width: `${percentage}%` }} />
      </div>
      <div className="mint-tracker-bottom">
        <span>{percentage.toFixed(1)}% minted</span>
        <span>
          Wallet {supply?.mintedByWallet ?? 0}/{supply?.maxMintsPerWallet ?? 3}
        </span>
      </div>
    </section>
  );
}

const ADMIN_ROUTES = {
  overview: "/sekioadmini",
  allowlist: "/sekioadmini/allowlist",
  invites: "/sekioadmini/invites"
};

// Matches an EVM address anywhere in a string (a CSV cell, a line, etc.).
const WALLET_RE = /0x[a-fA-F0-9]{40}/g;

// Pulls every wallet address out of free-form text (pasted list OR a CSV with a
// header row and extra columns) and removes duplicates case-insensitively.
// Because we match by pattern, header text and non-wallet columns are ignored.
function extractWallets(text) {
  const matches = String(text || "").match(WALLET_RE) || [];
  const seen = new Set();
  const wallets = [];
  let duplicates = 0;
  for (const raw of matches) {
    const key = raw.toLowerCase();
    if (seen.has(key)) {
      duplicates += 1;
      continue;
    }
    seen.add(key);
    wallets.push(raw);
  }
  return { wallets, duplicates, total: matches.length };
}

function resolveAdminView() {
  const path = window.location.pathname.replace(/\/+$/, "");
  if (path === ADMIN_ROUTES.allowlist) return "allowlist";
  if (path === ADMIN_ROUTES.invites) return "invites";
  return "overview";
}

function AdminPage({ dialog }) {
  const [snapshot, setSnapshot] = useState(null);
  const [loadingLabel, setLoadingLabel] = useState("");
  const [message, setMessage] = useState("");
  const [view, setView] = useState(resolveAdminView);
  const [allowlistStats, setAllowlistStats] = useState(null);
  const [form, setForm] = useState({
    adminWallet: "",
    allowlistInput: "",
    codeCount: "1000",
    inviteRequired: true,
    mintPriceEth: "",
    gameSigner: "",
    royaltyReceiver: "",
    royaltyBps: "500",
    withdrawRecipient: "",
    newOwner: "",
    vaultRecipient: "",
    vaultCount: "1",
    tierPrices: "",
    transferValidator: "",
    autoApprove: true
  });
  const [inviteCodes, setInviteCodes] = useState([]);
  const [allowlistEntries, setAllowlistEntries] = useState([]);

  useEffect(() => {
    const syncView = () => setView(resolveAdminView());
    window.addEventListener("popstate", syncView);
    return () => window.removeEventListener("popstate", syncView);
  }, []);

  const navigate = (nextView) => {
    const target = ADMIN_ROUTES[nextView] || ADMIN_ROUTES.overview;
    if (window.location.pathname !== target) {
      window.history.pushState({}, "", target);
    }
    setMessage("");
    setView(nextView);
  };

  const loadSnapshot = async () => {
    try {
      setLoadingLabel("Reading contract");
      setMessage("");
      const nextSnapshot = await loadContractAdminSnapshot();
      setSnapshot(nextSnapshot);
      setForm((current) => ({
        ...current,
        mintPriceEth: nextSnapshot.mintPriceEth,
        gameSigner: nextSnapshot.gameSigner,
        royaltyReceiver: nextSnapshot.owner,
        withdrawRecipient: nextSnapshot.owner,
        newOwner: nextSnapshot.owner,
        vaultRecipient: current.vaultRecipient || nextSnapshot.owner
      }));
    } catch (error) {
      setMessage(error.shortMessage || error.message);
    } finally {
      setLoadingLabel("");
    }
  };

  const updateForm = (event) => {
    const value =
      event.target.type === "checkbox" ? event.target.checked : event.target.value.trim();
    setForm({ ...form, [event.target.name]: value });
  };

  const connectAdminWallet = async () => {
    try {
      setLoadingLabel("Connecting wallet");
      const [wallet] = await window.ethereum.request({ method: "eth_requestAccounts" });
      setForm((current) => ({ ...current, adminWallet: wallet }));
    } catch (error) {
      setMessage(error.shortMessage || error.message);
    } finally {
      setLoadingLabel("");
    }
  };

  const signAdminMessage = async () => {
    if (!form.adminWallet) throw new Error("Connect admin wallet first");
    const { message } = await getInviteAdminMessage(form.adminWallet);
    return window.ethereum.request({
      method: "personal_sign",
      params: [message, form.adminWallet]
    });
  };

  const generateCodes = async () => {
    try {
      setLoadingLabel("Generating codes");
      setMessage("");
      const signature = await signAdminMessage();
      const result = await generateInviteCodes(
        form.adminWallet,
        signature,
        Number(form.codeCount || 1)
      );
      setInviteCodes(result.codes);
      setMessage(`Generated ${result.codes.length} invite code(s)`);
    } catch (error) {
      setMessage(error.shortMessage || error.message);
    } finally {
      setLoadingLabel("");
    }
  };

  const loadCodes = async () => {
    try {
      setLoadingLabel("Loading codes");
      setMessage("");
      const signature = await signAdminMessage();
      const [codesResult, settingsResult] = await Promise.all([
        listInviteCodes(form.adminWallet, signature),
        readInviteSettings(form.adminWallet, signature)
      ]);
      const result = codesResult;
      setInviteCodes(result.codes);
      setForm((current) => ({
        ...current,
        inviteRequired: settingsResult.settings.inviteRequired
      }));
    } catch (error) {
      setMessage(error.shortMessage || error.message);
    } finally {
      setLoadingLabel("");
    }
  };

  const copyCode = async (code) => {
    await window.navigator.clipboard.writeText(code);
    dialog.notify(`Copied ${code}`);
  };

  const copyAllCodes = async () => {
    const codes = inviteCodes.map((invite) => invite.code).join("\n");
    if (!codes) {
      dialog.notify("No invite codes loaded.");
      return;
    }
    await window.navigator.clipboard.writeText(codes);
    dialog.notify(`Copied ${inviteCodes.length} invite code(s).`);
  };

  const clearCodes = async () => {
    const confirmed = await dialog.confirm("Clear every invite code from the backend?");
    if (!confirmed) return;

    try {
      setLoadingLabel("Clearing codes");
      setMessage("");
      const signature = await signAdminMessage();
      await clearInviteCodes(form.adminWallet, signature);
      setInviteCodes([]);
      setMessage("Invite codes cleared");
    } catch (error) {
      setMessage(error.shortMessage || error.message);
    } finally {
      setLoadingLabel("");
    }
  };

  const saveInviteRequirement = async () => {
    try {
      setLoadingLabel("Saving invite mode");
      setMessage("");
      const signature = await signAdminMessage();
      const result = await updateInviteSettings(
        form.adminWallet,
        signature,
        Boolean(form.inviteRequired)
      );
      setForm((current) => ({
        ...current,
        inviteRequired: result.settings.inviteRequired
      }));
      setMessage(result.settings.inviteRequired ? "Invite codes are required" : "Invite codes are off");
    } catch (error) {
      setMessage(error.shortMessage || error.message);
    } finally {
      setLoadingLabel("");
    }
  };

  const loadAllowlistEntries = async () => {
    try {
      setLoadingLabel("Loading allowlist");
      setMessage("");
      const signature = await signAdminMessage();
      const result = await listAllowlist(form.adminWallet, signature);
      setAllowlistEntries(result.entries || []);
    } catch (error) {
      setMessage(error.shortMessage || error.message);
    } finally {
      setLoadingLabel("");
    }
  };

  // Reads an uploaded CSV/TXT, extracts wallet addresses (ignoring header rows
  // and any other columns) and merges them into the textarea with duplicates
  // already removed. Never throws on a bad file — it just reports.
  const handleAllowlistFile = async (event) => {
    const file = event.target.files?.[0];
    event.target.value = ""; // allow re-uploading the same file
    if (!file) return;

    try {
      const text = await file.text();
      const fromFile = extractWallets(text);
      if (!fromFile.wallets.length) {
        setAllowlistStats(null);
        dialog.notify("No wallet addresses found in that file.");
        return;
      }

      const merged = extractWallets(`${form.allowlistInput}\n${fromFile.wallets.join("\n")}`);
      setForm((current) => ({ ...current, allowlistInput: merged.wallets.join("\n") }));
      setAllowlistStats({
        source: file.name,
        found: fromFile.wallets.length,
        removed: fromFile.duplicates,
        ready: merged.wallets.length
      });
    } catch (error) {
      dialog.notify(`Could not read file: ${error.message}`);
    }
  };

  const dedupeAllowlistInput = () => {
    const { wallets, duplicates } = extractWallets(form.allowlistInput);
    setForm((current) => ({ ...current, allowlistInput: wallets.join("\n") }));
    setAllowlistStats({ source: "manual", found: wallets.length, removed: duplicates, ready: wallets.length });
  };

  const addAllowlistEntries = async () => {
    const { wallets, duplicates } = extractWallets(form.allowlistInput);

    if (!wallets.length) {
      dialog.notify("Add at least one valid 0x wallet address.");
      return;
    }

    try {
      setLoadingLabel("Adding allowlist");
      setMessage("");
      const signature = await signAdminMessage();
      await addAllowlistWallets(form.adminWallet, signature, wallets);
      const result = await listAllowlist(form.adminWallet, signature);
      setAllowlistEntries(result.entries || []);
      setForm((current) => ({ ...current, allowlistInput: "" }));
      setAllowlistStats(null);
      const dupNote = duplicates ? ` (${duplicates} duplicate${duplicates === 1 ? "" : "s"} skipped)` : "";
      setMessage(`Added ${wallets.length} wallet${wallets.length === 1 ? "" : "s"} to the allowlist${dupNote}.`);
    } catch (error) {
      setMessage(error.shortMessage || error.message);
    } finally {
      setLoadingLabel("");
    }
  };

  const removeAllowlistEntry = async (targetWallet) => {
    try {
      setLoadingLabel("Removing wallet");
      const signature = await signAdminMessage();
      await removeAllowlistWallet(form.adminWallet, signature, targetWallet);
      setAllowlistEntries((entries) =>
        entries.filter((entry) => entry.walletAddress !== targetWallet)
      );
    } catch (error) {
      setMessage(error.shortMessage || error.message);
    } finally {
      setLoadingLabel("");
    }
  };

  const clearAllowlistEntries = async () => {
    const confirmed = await dialog.confirm("Clear every wallet from the allowlist?");
    if (!confirmed) return;

    try {
      setLoadingLabel("Clearing allowlist");
      const signature = await signAdminMessage();
      await clearAllowlist(form.adminWallet, signature);
      setAllowlistEntries([]);
      setMessage("Allowlist cleared");
    } catch (error) {
      setMessage(error.shortMessage || error.message);
    } finally {
      setLoadingLabel("");
    }
  };

  const copyAllowlist = async () => {
    if (!allowlistEntries.length) {
      dialog.notify("No allowlisted wallets loaded.");
      return;
    }

    await window.navigator.clipboard.writeText(
      allowlistEntries.map((entry) => entry.walletAddress).join("\n")
    );
    dialog.notify(`Copied ${allowlistEntries.length} allowlisted wallet(s).`);
  };

  const runAdminAction = async (label, action) => {
    try {
      setLoadingLabel(label);
      setMessage("");
      const receipt = await action();
      setMessage(`Confirmed ${receipt.hash}`);
      await loadSnapshot();
    } catch (error) {
      setMessage(error.shortMessage || error.message);
    } finally {
      setLoadingLabel("");
    }
  };

  const walletConnected = Boolean(form.adminWallet);
  const shortWallet = walletConnected
    ? `${form.adminWallet.slice(0, 6)}…${form.adminWallet.slice(-4)}`
    : "NOT CONNECTED";

  return (
    <main className="admin-page">
      <section className="admin-shell console-shell">
        <div className="brand-strip">
          <span>SNAKIOX ADMIN</span>
          <span>/SEKIOADMINI</span>
        </div>

        <nav className="admin-nav" aria-label="Admin sections">
          <button
            className={`admin-tab ${view === "overview" ? "active" : ""}`}
            onClick={() => navigate("overview")}
            type="button"
          >
            <LayoutDashboard size={16} />
            OVERVIEW
          </button>
          <button
            className={`admin-tab ${view === "allowlist" ? "active" : ""}`}
            onClick={() => navigate("allowlist")}
            type="button"
          >
            <Users size={16} />
            ALLOWLIST
          </button>
          <button
            className={`admin-tab ${view === "invites" ? "active" : ""}`}
            onClick={() => navigate("invites")}
            type="button"
          >
            <Ticket size={16} />
            INVITE CODES
          </button>
        </nav>

        <div className="admin-authbar">
          <button className="press-key" onClick={connectAdminWallet} type="button">
            <Wallet size={15} />
            {walletConnected ? "RECONNECT" : "CONNECT ADMIN WALLET"}
          </button>
          <input
            className="terminal-input"
            name="adminWallet"
            onChange={updateForm}
            placeholder="admin wallet"
            value={form.adminWallet}
          />
          <span className={`admin-badge ${walletConnected ? "online" : ""}`}>{shortWallet}</span>
        </div>

        {loadingLabel && <div className="pulse-note">{loadingLabel}...</div>}
        {message && <div className="status-tape">{message}</div>}

        {view === "overview" && (
          <div className="admin-overview">
            <aside className="panel admin-status-panel">
              <div className="panel-title">
                <ShieldCheck size={18} />
                CONTRACT STATUS
              </div>
              <button className="start-button wide" onClick={loadSnapshot} type="button">
                <RefreshCw size={16} />
                LOAD CONTRACT
              </button>
              {snapshot ? (
                <>
                  <div className="metric-row">
                    <span>CHAIN</span>
                    <strong>{snapshot.chainId}</strong>
                  </div>
                  <div className="metric-row">
                    <span>MINTED</span>
                    <strong>
                      {snapshot.totalMinted}/{snapshot.maxSupply}
                    </strong>
                  </div>
                  <div className="metric-row">
                    <span>PRICE</span>
                    <strong>{snapshot.mintPriceEth} ETH</strong>
                  </div>
                  <div className="metric-row">
                    <span>PER WALLET</span>
                    <strong>{snapshot.maxMintsPerWallet}</strong>
                  </div>
                  <div className="output-window">
                    <p>Contract</p>
                    <code>{snapshot.contractAddress}</code>
                    <p>Owner</p>
                    <code>{snapshot.owner}</code>
                    <p>Game signer</p>
                    <code>{snapshot.gameSigner}</code>
                  </div>
                </>
              ) : (
                <div className="status-tape">Load the contract to read live on-chain state.</div>
              )}
            </aside>

            <section className="panel admin-actions-panel">
              <div className="panel-title">
                <Wallet size={18} />
                OWNER ACTIONS
              </div>
              <div className="admin-actions-grid">
                <AdminAction
                  buttonLabel="SET MINT PRICE"
                  hint="Update the public mint price."
                  inputName="mintPriceEth"
                  label="Mint price (ETH)"
                  onChange={updateForm}
                  onClick={() =>
                    runAdminAction("Setting price", () => setContractMintPrice(form.mintPriceEth))
                  }
                  placeholder="0.01"
                  value={form.mintPriceEth}
                />
                <AdminAction
                  buttonLabel="SET GAME SIGNER"
                  hint="Backend wallet that signs mints."
                  inputName="gameSigner"
                  label="Game signer"
                  onChange={updateForm}
                  onClick={() =>
                    runAdminAction("Setting signer", () => setContractGameSigner(form.gameSigner))
                  }
                  placeholder="0x…"
                  value={form.gameSigner}
                />
                <div className="action-card">
                  <div className="mini-title">DEFAULT ROYALTY</div>
                  <p className="action-hint">Receiver + basis points (500 = 5%).</p>
                  <input
                    className="terminal-input"
                    name="royaltyReceiver"
                    onChange={updateForm}
                    placeholder="receiver 0x…"
                    value={form.royaltyReceiver}
                  />
                  <input
                    className="terminal-input mt-2"
                    name="royaltyBps"
                    onChange={updateForm}
                    placeholder="bps e.g. 500"
                    value={form.royaltyBps}
                  />
                  <button
                    className="press-key wide mt-2"
                    onClick={() =>
                      runAdminAction("Setting royalty", () =>
                        setContractDefaultRoyalty(form.royaltyReceiver, form.royaltyBps)
                      )
                    }
                    type="button"
                  >
                    SET ROYALTY
                  </button>
                  <button
                    className="press-key wide danger mt-2"
                    onClick={() =>
                      runAdminAction("Deleting royalty", () => deleteContractDefaultRoyalty())
                    }
                    type="button"
                  >
                    <Trash2 size={15} />
                    DELETE ROYALTY
                  </button>
                </div>
                <AdminAction
                  buttonLabel="WITHDRAW"
                  hint="Send contract balance to a wallet."
                  inputName="withdrawRecipient"
                  label="Withdraw recipient"
                  onChange={updateForm}
                  onClick={() =>
                    runAdminAction("Withdrawing", () => withdrawContract(form.withdrawRecipient))
                  }
                  placeholder="0x…"
                  value={form.withdrawRecipient}
                />
                <AdminAction
                  buttonLabel="TRANSFER OWNER"
                  danger
                  hint="Hands the contract to a new owner."
                  inputName="newOwner"
                  label="New owner"
                  onChange={updateForm}
                  onClick={() =>
                    runAdminAction("Transferring owner", () =>
                      transferContractOwnership(form.newOwner)
                    )
                  }
                  placeholder="0x…"
                  value={form.newOwner}
                />
                <div className="action-card">
                  <div className="mini-title">MINT VAULT</div>
                  <p className="action-hint">
                    Free owner mint to a wallet. Bypasses the per-wallet cap; mint in small
                    batches (e.g. 10).
                  </p>
                  <input
                    className="terminal-input"
                    name="vaultRecipient"
                    onChange={updateForm}
                    placeholder="recipient 0x…"
                    value={form.vaultRecipient}
                  />
                  <input
                    className="terminal-input mt-2"
                    name="vaultCount"
                    onChange={updateForm}
                    placeholder="count e.g. 10"
                    value={form.vaultCount}
                  />
                  <button
                    className="press-key wide mt-2"
                    onClick={() =>
                      runAdminAction("Minting vault", () =>
                        mintVaultToWallet(form.vaultRecipient, form.vaultCount)
                      )
                    }
                    type="button"
                  >
                    MINT TO WALLET
                  </button>
                </div>
                <AdminAction
                  buttonLabel="SET TIER PRICES"
                  hint="Per-mint prices in ETH, comma-separated (1st, 2nd, 3rd)."
                  inputName="tierPrices"
                  label="Mint tier prices"
                  onChange={updateForm}
                  onClick={() =>
                    runAdminAction("Setting tier prices", () =>
                      setContractMintTierPrices(form.tierPrices)
                    )
                  }
                  placeholder="0.01, 0.02, 0.03"
                  value={form.tierPrices}
                />
                <div className="action-card">
                  <div className="mini-title">TRANSFER VALIDATOR</div>
                  <p className="action-hint">Royalty-enforcement validator + auto-approve.</p>
                  <input
                    className="terminal-input"
                    name="transferValidator"
                    onChange={updateForm}
                    placeholder="validator 0x…"
                    value={form.transferValidator}
                  />
                  <button
                    className="press-key wide mt-2"
                    onClick={() =>
                      runAdminAction("Setting validator", () =>
                        setContractTransferValidator(form.transferValidator)
                      )
                    }
                    type="button"
                  >
                    SET VALIDATOR
                  </button>
                  <label className="toggle-row mt-2">
                    <input
                      checked={form.autoApprove}
                      name="autoApprove"
                      onChange={updateForm}
                      type="checkbox"
                    />
                    <span>Auto-approve transfers from validator</span>
                  </label>
                  <button
                    className="press-key wide mt-2"
                    onClick={() =>
                      runAdminAction("Updating auto-approve", () =>
                        setContractAutoApproveTransfers(form.autoApprove)
                      )
                    }
                    type="button"
                  >
                    SAVE AUTO-APPROVE
                  </button>
                </div>
              </div>
            </section>
          </div>
        )}

        {view === "allowlist" && (
          <section className="panel admin-feature-panel">
            <div className="panel-title">
              <Users size={18} />
              ALLOWLIST ACCESS
            </div>
            <p className="action-hint">
              Upload a CSV (with or without a header) or paste addresses. Wallets are extracted
              automatically and duplicates are removed before adding.
            </p>

            <div className="csv-tools">
              <label className="press-key csv-upload" htmlFor="allowlist-csv">
                <Upload size={15} />
                UPLOAD CSV / TXT
                <input
                  accept=".csv,.txt,text/csv,text/plain"
                  hidden
                  id="allowlist-csv"
                  onChange={handleAllowlistFile}
                  type="file"
                />
              </label>
              <button className="press-key" onClick={dedupeAllowlistInput} type="button">
                <RefreshCw size={15} />
                DEDUPE
              </button>
            </div>

            {allowlistStats && (
              <div className="csv-stats">
                <span className="csv-chip">Source: {allowlistStats.source}</span>
                <span className="csv-chip">Found: {allowlistStats.found}</span>
                <span className="csv-chip warn">Duplicates removed: {allowlistStats.removed}</span>
                <span className="csv-chip ok">Ready: {allowlistStats.ready}</span>
              </div>
            )}

            <textarea
              className="terminal-input allowlist-input"
              name="allowlistInput"
              onChange={updateForm}
              placeholder={"0xWallet1\n0xWallet2\n0xWallet3"}
              value={form.allowlistInput}
            />

            <div className="allowlist-tools">
              <button className="press-key" onClick={addAllowlistEntries} type="button">
                ADD TO ALLOWLIST
              </button>
              <button className="press-key" onClick={loadAllowlistEntries} type="button">
                LOAD
              </button>
              <button className="press-key" onClick={copyAllowlist} type="button">
                COPY ALL
              </button>
              <button className="press-key danger" onClick={clearAllowlistEntries} type="button">
                <Trash2 size={15} />
                CLEAR ALL
              </button>
            </div>

            <div className="list-count">
              {allowlistEntries.length} wallet{allowlistEntries.length === 1 ? "" : "s"} on the allowlist
            </div>
            <div className="allowlist-list scrolled">
              {allowlistEntries.length === 0 && (
                <div className="status-tape">No allowlisted wallets loaded.</div>
              )}
              {allowlistEntries.map((entry) => (
                <div className="allowlist-row" key={entry.walletAddress}>
                  <code>{entry.walletAddress}</code>
                  <button
                    aria-label={`Copy ${entry.walletAddress}`}
                    className="icon-copy"
                    onClick={() => copyCode(entry.walletAddress)}
                    type="button"
                  >
                    <Copy size={15} />
                  </button>
                  <button
                    aria-label={`Remove ${entry.walletAddress}`}
                    className="icon-remove"
                    onClick={() => removeAllowlistEntry(entry.walletAddress)}
                    type="button"
                  >
                    ×
                  </button>
                </div>
              ))}
            </div>
          </section>
        )}

        {view === "invites" && (
          <section className="panel admin-feature-panel">
            <div className="panel-title">
              <Ticket size={18} />
              INVITE CODES
            </div>

            <div className="output-window invite-gate">
              <div className="mini-title">ACCESS GATE</div>
              <label className="toggle-row">
                <input
                  checked={form.inviteRequired}
                  name="inviteRequired"
                  onChange={updateForm}
                  type="checkbox"
                />
                <span>Require an invite code to play &amp; mint</span>
              </label>
              <button className="press-key wide" onClick={saveInviteRequirement} type="button">
                SAVE INVITE MODE
              </button>
            </div>

            <div className="invite-generate">
              <div className="mini-title">GENERATE CODES</div>
              <div className="invite-tools">
                <input
                  className="terminal-input"
                  name="codeCount"
                  onChange={updateForm}
                  placeholder="1000"
                  value={form.codeCount}
                />
                <button className="press-key" onClick={generateCodes} type="button">
                  GENERATE
                </button>
                <button className="press-key" onClick={loadCodes} type="button">
                  LOAD
                </button>
                <button className="press-key" onClick={copyAllCodes} type="button">
                  COPY ALL
                </button>
                <button className="press-key danger" onClick={clearCodes} type="button">
                  <Trash2 size={15} />
                  CLEAR
                </button>
              </div>
            </div>

            <div className="list-count">{inviteCodes.length} code(s) loaded</div>
            <div className="invite-list scrolled">
              {inviteCodes.length === 0 && <div className="status-tape">No codes loaded.</div>}
              {inviteCodes.map((invite) => (
                <div className="invite-row" key={invite.code}>
                  <code>{invite.code}</code>
                  <span className={`invite-state ${invite.redeemedBy ? "used" : "open"}`}>
                    {invite.mintedBy ? "MINTED" : invite.redeemedBy ? "REDEEMED" : "OPEN"}
                  </span>
                  <button
                    aria-label={`Copy ${invite.code}`}
                    className="icon-copy"
                    onClick={() => copyCode(invite.code)}
                    type="button"
                  >
                    <Copy size={15} />
                  </button>
                </div>
              ))}
            </div>
          </section>
        )}
      </section>
    </main>
  );
}

function AdminAction({ buttonLabel, danger, hint, inputName, label, onChange, onClick, placeholder, value }) {
  return (
    <div className="action-card">
      <div className="mini-title">{label}</div>
      {hint && <p className="action-hint">{hint}</p>}
      <input
        className="terminal-input"
        name={inputName}
        onChange={onChange}
        placeholder={placeholder || label}
        value={value}
      />
      <button className={`press-key wide mt-2 ${danger ? "danger" : ""}`} onClick={onClick} type="button">
        {buttonLabel}
      </button>
    </div>
  );
}

// Concurrency control + double-submit protection. `run(key, fn)` refuses to
// start while any guarded action is already in flight (the synchronous ref check
// drops rapid double-clicks before React re-renders), and exposes `pending`/
// `busy` so buttons can disable themselves while a request is running.
function useActionGuard() {
  const inFlightRef = useRef(new Set());
  const [pending, setPending] = useState({});

  const run = useCallback(async (key, fn) => {
    if (inFlightRef.current.size > 0) return undefined;
    inFlightRef.current.add(key);
    setPending((prev) => ({ ...prev, [key]: true }));
    try {
      return await fn();
    } finally {
      inFlightRef.current.delete(key);
      setPending((prev) => ({ ...prev, [key]: false }));
    }
  }, []);

  const busy = Object.values(pending).some(Boolean);
  return { run, pending, busy };
}

function useDialog() {
  const [dialogState, setDialogState] = useState(null);
  const resolverRef = useRef(null);

  const close = (result = false) => {
    resolverRef.current?.(result);
    resolverRef.current = null;
    setDialogState(null);
  };

  const notify = (message) => {
    setDialogState({
      message,
      mode: "notice",
      title: "SNAKIOX SIGNAL"
    });
  };

  const confirm = (message) =>
    new Promise((resolve) => {
      resolverRef.current = resolve;
      setDialogState({
        message,
        mode: "confirm",
        title: "CONFIRM ACTION"
      });
    });

  // Resolves with the chosen option's `key`. options: [{ key, label }]
  const choose = (message, options, title = "CHOOSE OPTION") =>
    new Promise((resolve) => {
      resolverRef.current = resolve;
      setDialogState({ message, mode: "choose", title, options });
    });

  return { close, confirm, choose, notify, state: dialogState };
}

function CustomDialog({ dialog }) {
  if (!dialog.state) return null;

  const isConfirm = dialog.state.mode === "confirm";
  const isChoose = dialog.state.mode === "choose";

  return (
    <div className="custom-alert-backdrop" role="presentation">
      <div className="custom-alert" role="dialog">
        <div className="brand-strip">
          <span>{dialog.state.title}</span>
          <span>{isConfirm || isChoose ? "INPUT REQUIRED" : "READY"}</span>
        </div>
        <p>{dialog.state.message}</p>
        <div className="custom-alert-actions">
          {isChoose ? (
            dialog.state.options.map((option) => (
              <button
                key={option.key}
                className="press-key"
                onClick={() => dialog.close(option.key)}
                type="button"
              >
                {option.label}
              </button>
            ))
          ) : (
            <>
              {isConfirm && (
                <button className="press-key" onClick={() => dialog.close(false)} type="button">
                  CANCEL
                </button>
              )}
              <button className="start-button" onClick={() => dialog.close(true)} type="button">
                {isConfirm ? "CONFIRM" : "OK"}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function ControlPanel({
  state,
  busy,
  onWalletInput,
  onConnect,
  onDisconnect,
  inviteCode,
  onInviteCodeChange,
  onRedeemCode,
  onStatus,
  onStart,
  onResult,
  onGenerateRandom
}) {
  const connected = Boolean(state.wallet);
  const canStart = state.status?.canPlay || state.status?.activeSessionId;
  // Item 5: once a wallet is allowlisted or already holds an active code, it
  // can't redeem again — lock the input and the button.
  const inviteLocked = Boolean(state.status?.isAllowlisted || state.status?.hasInvite);

  return (
    <aside className="panel">
      <div className="panel-title">
        <Wallet size={18} />
        WALLET LINK
      </div>
      <input
        className="terminal-input"
        value={state.wallet}
        onChange={onWalletInput}
        placeholder="0x..."
        spellCheck="false"
      />
      <div className="grid grid-cols-2 gap-2">
        <button className="press-key" onClick={onConnect} disabled={busy}>
          CONNECT
        </button>
        <button className="press-key" onClick={onDisconnect} disabled={!connected}>
          DISCONNECT
        </button>
      </div>
      <button className="press-key wide" onClick={onStatus} disabled={busy || !connected}>
        SCAN STATUS
      </button>
      <input
        className="terminal-input"
        onChange={(event) => onInviteCodeChange(event.target.value)}
        placeholder={inviteLocked ? "CODE ALREADY ACTIVE" : "SNX-INVITE-CODE"}
        value={inviteCode}
        disabled={inviteLocked}
      />
      <button
        className="press-key wide"
        onClick={onRedeemCode}
        disabled={busy || inviteLocked || !connected}
      >
        REDEEM CODE
      </button>
      <div className="status-tape">
        <p>{state.status?.registered ? "REGISTERED" : "UNREGISTERED"}</p>
        <p>
          {state.status?.isAllowlisted
            ? "ALLOWLIST ACCESS"
            : state.status?.hasInvite
              ? "CODE ACTIVE"
              : state.status?.inviteRequired === false
                ? "OPEN ACCESS"
                : "CODE REQUIRED"}
        </p>
        {state.status?.reason && <p>{state.status.reason}</p>}
      </div>
      {/* Item 4: on small screens these move into the RUN OUTPUT panel. */}
      <div className="desktop-only control-actions">
        <button className="start-button" onClick={onStart} disabled={busy || !canStart}>
          <Gamepad2 size={18} />
          START RUN
        </button>
        <button
          className="press-key wide"
          onClick={onGenerateRandom}
          disabled={busy || !state.status?.canPlay}
          title="Skip playing: get a random score and mint it. No replay, and it can't be re-rolled."
        >
          GENERATE RANDOM &amp; MINT
        </button>
        <button className="press-key wide" onClick={onResult} disabled={busy || !connected}>
          LOAD LOCKED RESULT
        </button>
      </div>
      {state.loadingLabel && <div className="pulse-note">{state.loadingLabel}...</div>}
      {state.error && <div className="error-tape">{state.error}</div>}
    </aside>
  );
}

function ScoreLine({ score, level, speed, phase }) {
  return (
    <div className="score-line">
      <span>SCORE {String(score).padStart(5, "0")}</span>
      <span>LV {level}</span>
      <span>{speed}MS</span>
      <span>{phase.toUpperCase()}</span>
    </div>
  );
}

function SnakeBoard({ game }) {
  const snakeCells = useMemo(() => new Set(game.snake.map(makeCellKey)), [game.snake]);
  const headKey = makeCellKey(game.snake[0]);
  const faceDir = game.direction || headDirection(game.snake);

  return (
    <div className="lcd-wrap">
      <div
        className="snake-grid"
        style={{ gridTemplateColumns: `repeat(${BOARD_SIZE}, minmax(0, 1fr))` }}
      >
        {Array.from({ length: BOARD_SIZE * BOARD_SIZE }, (_, index) => {
          const x = index % BOARD_SIZE;
          const y = Math.floor(index / BOARD_SIZE);
          const key = `${x}:${y}`;
          const isFood = game.food.x === x && game.food.y === y;
          const isSnake = snakeCells.has(key);
          const isHead = key === headKey;
          return (
            <div
              className={[
                "grid-cell",
                isSnake ? "snake-cell" : "",
                isHead ? "snake-head" : "",
                isFood ? "food-cell" : ""
              ].join(" ")}
              data-dir={isHead ? faceDir : undefined}
              key={key}
            />
          );
        })}
      </div>
      {game.phase === "idle" && <div className="screen-message">PRESS START</div>}
      {game.phase === "dead" && <div className="screen-message">SIGNAL LOST</div>}
      {game.phase === "locked" && <div className="screen-message">RESULT LOCKED</div>}
    </div>
  );
}

function TouchControls({ dispatch }) {
  const queue = (direction) => dispatch({ type: "QUEUE_DIRECTION", direction });

  return (
    <div className="touch-pad" aria-label="Direction controls">
      <button onClick={() => queue("UP")}>UP</button>
      <button onClick={() => queue("LEFT")}>LEFT</button>
      <button onClick={() => queue("DOWN")}>DOWN</button>
      <button onClick={() => queue("RIGHT")}>RIGHT</button>
    </div>
  );
}

function MobileDirectionPad({ canStart, dispatch, gamePhase, onStart }) {
  const queue = (direction) => dispatch({ type: "QUEUE_DIRECTION", direction });
  const isRunning = gamePhase === "running";

  return (
    <div className="mobile-control-deck">
      <div className="mobile-dpad" aria-label="Mobile direction controls">
        <button className="dpad-up" onClick={() => queue("UP")} type="button">
          <ChevronUp size={26} />
        </button>
        <button className="dpad-left" onClick={() => queue("LEFT")} type="button">
          <ChevronLeft size={26} />
        </button>
        <button className="dpad-right" onClick={() => queue("RIGHT")} type="button">
          <ChevronRight size={26} />
        </button>
        <button className="dpad-down" onClick={() => queue("DOWN")} type="button">
          <ChevronDown size={26} />
        </button>
      </div>
      <button
        aria-label="Start game"
        className="mobile-start-control"
        disabled={!canStart || isRunning}
        onClick={onStart}
        type="button"
      >
        <Gamepad2 size={20} />
        <span>{isRunning ? "LIVE" : "START"}</span>
      </button>
    </div>
  );
}

function ResultPanel({ state, busy, level, speed, onMint, onGenerateRandom, onResult }) {
  const session = state.game.lockedResult;
  const hasInviteAccess =
    state.status?.isAllowlisted ||
    state.status?.inviteRequired === false ||
    state.status?.hasInvite;
  const canMint = Boolean((state.mint || session) && !session?.txHash && hasInviteAccess);

  return (
    <aside className="panel">
      <div className="panel-title">
        <Trophy size={18} />
        RUN OUTPUT
      </div>
      <div className="metric-row">
        <span>LEVEL</span>
        <strong>{level}</strong>
      </div>
      <div className="metric-row">
        <span>SPEED</span>
        <strong>{speed}ms</strong>
      </div>
      <div className="metric-row">
        <span>LENGTH</span>
        <strong>{state.game.snake.length}</strong>
      </div>
      <div className="metric-row">
        <span>DEATH</span>
        <strong>{state.game.deathReason || session?.deathReason || "none"}</strong>
      </div>
      <button className="start-button" onClick={onMint} disabled={busy || !canMint}>
        <ShieldCheck size={18} />
        MINT NFT
      </button>
      {/* Item 4: on small screens the control panel hides these, so they live
          here under MINT NFT instead. */}
      <div className="mobile-only control-actions">
        <button
          className="press-key wide"
          onClick={onGenerateRandom}
          disabled={busy || !state.status?.canPlay}
          title="Skip playing: get a random score and mint it. No replay, and it can't be re-rolled."
        >
          GENERATE RANDOM &amp; MINT
        </button>
        <button className="press-key wide" onClick={onResult} disabled={busy || !state.wallet}>
          LOAD LOCKED RESULT
        </button>
      </div>
      <div className="output-window">
        <div className="mini-title">
          <Activity size={16} />
          CONTROLS
        </div>
        <p>ARROWS / WASD / PAD</p>
        <p>Walls and self contact end the run.</p>
        <p>Every 50 points increases level and speed.</p>
      </div>
      <button className="press-key wide" onClick={() => window.location.reload()}>
        <RotateCcw size={16} />
        REBOOT DISPLAY
      </button>
      <div className="dead-mark">
        <CircleStop size={18} />
        CLASSIC MODE
      </div>
    </aside>
  );
}

// Item 6: on small screens the middle console (which holds the replay + minted
// token strips) is hidden, so surface them in their own panel after RUN OUTPUT.
function MobileActionsPanel({ sessions }) {
  const hasReplays = sessions.some((session) => session?.moves?.length);
  const hasMinted = sessions.some((session) => session?.mintedTokenId);

  return (
    <section className="panel mobile-only mobile-actions">
      <div className="panel-title">
        <LayoutDashboard size={18} />
        ACTIONS
      </div>
      <ReplayPanel sessions={sessions} />
      <MintedTokensPanel sessions={sessions} />
      {!hasReplays && !hasMinted && (
        <div className="status-tape">Play and mint a run to unlock replays and tokens here.</div>
      )}
    </section>
  );
}

function MintedTokensPanel({ sessions }) {
  const mintedSessions = sessions.filter((session) => session?.mintedTokenId);
  const [activeSession, setActiveSession] = useState(null);
  const tokenId = activeSession?.mintedTokenId;
  const [token, setToken] = useState(null);
  const [error, setError] = useState("");
  const openSeaUrl = buildOpenSeaAssetUrl(tokenId);
  const etherscanTxUrl = buildEtherscanTxUrl(activeSession?.txHash);

  useEffect(() => {
    if (!tokenId) {
      setToken(null);
      setError("");
      return undefined;
    }

    let cancelled = false;
    loadMintedToken(tokenId)
      .then((nextToken) => {
        if (!cancelled) setToken(nextToken);
      })
      .catch((loadError) => {
        if (!cancelled) setError(loadError.shortMessage || loadError.message);
      });

    return () => {
      cancelled = true;
    };
  }, [tokenId]);

  if (!mintedSessions.length) return null;

  return (
    <section className="minted-strip">
      <div className="mini-title">
        <Image size={16} />
        MINTED NFT TOKENS
      </div>
      <div className="token-list">
        {mintedSessions.map((session, index) => (
          <button
            className="token-row"
            key={session.sessionId || session.id}
            onClick={() => setActiveSession(session)}
            type="button"
          >
            <span>#{session.mintedTokenId}</span>
            <strong>RUN {index + 1}</strong>
          </button>
        ))}
      </div>
      {activeSession && (
        <NftPreviewModal
          image={token?.image}
          onClose={() => setActiveSession(null)}
          openSeaUrl={openSeaUrl}
          tokenId={tokenId}
          txUrl={etherscanTxUrl}
        />
      )}
      {error && <small className="inline-error">{error}</small>}
    </section>
  );
}

function ReplayPanel({ sessions }) {
  const replaySessions = sessions.filter((session) => session?.moves?.length);
  const [activeSession, setActiveSession] = useState(null);

  if (!replaySessions.length) return null;

  return (
    <section className="replay-strip">
      <div className="mini-title">
        <Activity size={16} />
        RUN REPLAY
      </div>
      <div className="token-list">
        {replaySessions.map((session, index) => (
          <button
            className="token-row"
            key={session.sessionId || session.id}
            onClick={() => setActiveSession(session)}
            type="button"
          >
            <span>RUN {index + 1}</span>
            <strong>{session.score || 0} PTS</strong>
          </button>
        ))}
      </div>
      {activeSession && (
        <ReplayModal
          moves={activeSession.moves}
          onClose={() => setActiveSession(null)}
          session={activeSession}
        />
      )}
    </section>
  );
}

function ReplayModal({ moves, onClose, session }) {
  const frames = useMemo(() => buildReplayFrames(moves, session), [moves, session]);
  const [frameIndex, setFrameIndex] = useState(0);
  const frame = frames[frameIndex] || frames[0] || START_SNAKE;
  const cells = new Set(frame.map(makeCellKey));
  const headKey = makeCellKey(frame[0] || START_SNAKE[0]);
  const faceDir = headDirection(frame);

  useEffect(() => {
    if (frames.length <= 1) return undefined;

    const timer = window.setInterval(() => {
      setFrameIndex((current) => (current + 1) % frames.length);
    }, 85);

    return () => window.clearInterval(timer);
  }, [frames.length]);

  return (
    <div className="nft-modal-backdrop" onClick={onClose} role="presentation">
      <div className="replay-modal" onClick={(event) => event.stopPropagation()} role="dialog">
        <div className="brand-strip">
          <span>SNAKIOX REPLAY</span>
          <button className="modal-close" onClick={onClose} type="button">
            CLOSE
          </button>
        </div>
        <div
          className="replay-grid"
          style={{ gridTemplateColumns: `repeat(${BOARD_SIZE}, minmax(0, 1fr))` }}
        >
          {Array.from({ length: BOARD_SIZE * BOARD_SIZE }, (_, index) => {
            const x = index % BOARD_SIZE;
            const y = Math.floor(index / BOARD_SIZE);
            const key = `${x}:${y}`;
            return (
              <div
                className={[
                  "grid-cell",
                  cells.has(key) ? "snake-cell" : "",
                  headKey === key ? "snake-head" : ""
                ].join(" ")}
                data-dir={headKey === key ? faceDir : undefined}
                key={key}
              />
            );
          })}
        </div>
        <div className="replay-progress" aria-hidden="true">
          <span
            className="replay-progress-fill"
            style={{ width: `${((frameIndex + 1) / frames.length) * 100}%` }}
          />
        </div>
        <div className="metric-row">
          <span>FRAME</span>
          <strong>
            {frameIndex + 1}/{frames.length}
          </strong>
        </div>
      </div>
    </div>
  );
}

function buildReplayFrames(moves, session) {
  const sortedMoves = moves
    .filter((move) => DIRECTIONS[move.direction])
    .slice()
    .sort((a, b) => (a.tick || 0) - (b.tick || 0));
  const lastTick = Math.max(...sortedMoves.map((move) => move.tick || 0), 30);
  const targetLength = Math.max(session?.snakeLength || session?.finalSnakeCells?.length || 3, 3);
  let direction = sortedMoves[0]?.direction || "RIGHT";
  let moveIndex = 0;
  let snake = START_SNAKE.map((cell) => ({ ...cell }));
  const frames = [snake];

  for (let tick = 1; tick <= lastTick + 16; tick += 1) {
    while (sortedMoves[moveIndex + 1] && (sortedMoves[moveIndex + 1].tick || 0) <= tick) {
      moveIndex += 1;
      direction = sortedMoves[moveIndex].direction;
    }

    const delta = DIRECTIONS[direction];
    const head = snake[0];
    const nextHead = { x: head.x + delta.x, y: head.y + delta.y };

    if (
      nextHead.x < 0 ||
      nextHead.y < 0 ||
      nextHead.x >= BOARD_SIZE ||
      nextHead.y >= BOARD_SIZE
    ) {
      break;
    }

    const currentLength = Math.min(targetLength, 3 + Math.floor(tick / 10));
    snake = [nextHead, ...snake].slice(0, currentLength);
    frames.push(snake);
  }

  return frames;
}

function NftPreviewModal({ image, onClose, openSeaUrl, tokenId, txUrl }) {
  return (
    <div className="nft-modal-backdrop" onClick={onClose} role="presentation">
      <div className="nft-modal" onClick={(event) => event.stopPropagation()} role="dialog">
        <div className="brand-strip">
          <span>Snakiox #{tokenId}</span>
          <button className="modal-close" onClick={onClose} type="button">
            CLOSE
          </button>
        </div>
        <div className="nft-modal-art">
          {image ? <img alt={`Snakiox #${tokenId}`} src={image} /> : <span>LOADING TOKEN</span>}
        </div>
        {openSeaUrl && (
          <a className="start-button" href={openSeaUrl} rel="noreferrer" target="_blank">
            <ExternalLink size={18} />
            VIEW ON OPENSEA
          </a>
        )}
        {txUrl && (
          <a className="press-key wide" href={txUrl} rel="noreferrer" target="_blank">
            <ExternalLink size={16} />
            VIEW TX
          </a>
        )}
      </div>
    </div>
  );
}

export default App;
