import { createContext, useContext, useMemo, useReducer } from "react";
import { createInitialGame, isOpposite, stepGame } from "../game/snakeEngine";

const GameContext = createContext(null);

const initialState = {
  wallet: "",
  user: null,
  status: null,
  mint: null,
  error: "",
  loadingLabel: "",
  lockedResults: [],
  game: createInitialGame()
};

function gameReducer(state, action) {
  switch (action.type) {
    case "SET_LOADING":
      return { ...state, loadingLabel: action.label, error: "" };
    case "SET_ERROR":
      return { ...state, loadingLabel: "", error: action.message };
    case "SET_WALLET":
      return { ...state, wallet: action.wallet, error: "" };
    case "DISCONNECT":
      return {
        ...initialState,
        game: createInitialGame()
      };
    case "REGISTERED":
      return { ...state, user: action.user, status: action.status, loadingLabel: "", error: "" };
    case "STATUS_LOADED":
      return { ...state, status: action.status, loadingLabel: "", error: "" };
    case "STARTED":
      return {
        ...state,
        loadingLabel: "",
        error: "",
        game: {
          ...createInitialGame(),
          phase: "playing",
          sessionId: action.sessionId,
          startedAt: Date.now(),
          moves: [{ direction: "RIGHT", tick: 0, atMs: 0 }]
        }
      };
    case "QUEUE_DIRECTION": {
      if (state.game.phase !== "playing") return state;
      if (isOpposite(state.game.direction, action.direction)) return state;
      const move = {
        direction: action.direction,
        tick: state.game.tick,
        atMs: Date.now() - (state.game.startedAt || Date.now())
      };
      return {
        ...state,
        game: {
          ...state.game,
          pendingDirection: action.direction,
          moves: [...state.game.moves, move]
        }
      };
    }
    case "STEP": {
      const withDirection = {
        ...state.game,
        direction: state.game.pendingDirection
      };
      return { ...state, game: stepGame(withDirection) };
    }
    case "TIMEOUT": {
      if (state.game.phase !== "playing") return state;
      // 40-min cap reached: lock in whatever score the player has now.
      return { ...state, game: { ...state.game, phase: "dead", deathReason: "timeout" } };
    }
    case "LOCKED":
      return {
        ...state,
        mint: action.mint,
        loadingLabel: "",
        lockedResults: action.sessions || mergeSessions(state.lockedResults, action.session),
        game: { ...state.game, phase: "locked", lockedResult: action.session }
      };
    case "RESULTS_LOADED":
      return {
        ...state,
        loadingLabel: "",
        lockedResults: action.sessions,
        game: {
          ...state.game,
          phase: action.sessions[0] ? "locked" : state.game.phase,
          lockedResult: action.sessions[0] || state.game.lockedResult
        }
      };
    case "MINTED":
      return {
        ...state,
        loadingLabel: "",
        status: state.status
          ? {
              ...state.status,
              hasMinted: true,
              mintedCount: (state.status.mintedCount || 0) + 1,
              remainingMints: Math.max((state.status.remainingMints || 1) - 1, 0)
            }
          : state.status,
        game: {
          ...state.game,
          lockedResult: {
            ...state.game.lockedResult,
            txHash: action.txHash,
            mintedTokenId: action.tokenId,
            status: "MINTED"
          }
        },
        lockedResults: mergeSessions(state.lockedResults, {
          ...state.game.lockedResult,
          txHash: action.txHash,
          mintedTokenId: action.tokenId,
          status: "MINTED"
        })
      };
    case "RESET_GAME":
      return { ...state, mint: null, game: createInitialGame(), error: "" };
    default:
      return state;
  }
}

function mergeSessions(sessions, session) {
  if (!session) return sessions;
  const sessionId = session.sessionId || session.id;
  const withoutSession = sessions.filter((item) => (item.sessionId || item.id) !== sessionId);
  return [session, ...withoutSession].sort(
    (a, b) => new Date(b.endedAt || b.updatedAt || 0) - new Date(a.endedAt || a.updatedAt || 0)
  );
}

export function GameProvider({ children }) {
  const [state, dispatch] = useReducer(gameReducer, initialState);
  const value = useMemo(() => ({ state, dispatch }), [state]);

  return <GameContext.Provider value={value}>{children}</GameContext.Provider>;
}

export function useGame() {
  const context = useContext(GameContext);
  if (!context) throw new Error("useGame must be used inside GameProvider");
  return context;
}
