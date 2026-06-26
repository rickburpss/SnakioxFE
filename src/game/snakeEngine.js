export const BOARD_SIZE = 24;
export const START_SNAKE = [
  { x: 8, y: 12 },
  { x: 7, y: 12 },
  { x: 6, y: 12 }
];

export const DIRECTIONS = {
  UP: { x: 0, y: -1 },
  DOWN: { x: 0, y: 1 },
  LEFT: { x: -1, y: 0 },
  RIGHT: { x: 1, y: 0 }
};

export function getLevel(score) {
  return Math.floor(score / 50) + 1;
}

export function getSpeed(score) {
  return Math.max(62, 130 - (getLevel(score) - 1) * 18);
}

export function isOpposite(current, next) {
  return (
    (current === "UP" && next === "DOWN") ||
    (current === "DOWN" && next === "UP") ||
    (current === "LEFT" && next === "RIGHT") ||
    (current === "RIGHT" && next === "LEFT")
  );
}

export function makeCellKey(cell) {
  return `${cell.x}:${cell.y}`;
}

// Direction the head is facing, derived from the head and the cell behind it.
// Used to orient the snake's eyes. Falls back when the snake has no neck yet.
export function headDirection(snake, fallback = "RIGHT") {
  if (!snake || snake.length < 2) return fallback;
  const [head, neck] = snake;
  if (head.x > neck.x) return "RIGHT";
  if (head.x < neck.x) return "LEFT";
  if (head.y > neck.y) return "DOWN";
  if (head.y < neck.y) return "UP";
  return fallback;
}

export function makeFood(snake) {
  const occupied = new Set(snake.map(makeCellKey));
  const open = [];

  for (let y = 0; y < BOARD_SIZE; y += 1) {
    for (let x = 0; x < BOARD_SIZE; x += 1) {
      if (!occupied.has(`${x}:${y}`)) open.push({ x, y });
    }
  }

  return open[Math.floor(Math.random() * open.length)] || { x: 12, y: 12 };
}

export function stepGame(state) {
  if (state.phase !== "playing") return state;

  const delta = DIRECTIONS[state.direction];
  const head = state.snake[0];
  const nextHead = { x: head.x + delta.x, y: head.y + delta.y };

  if (
    nextHead.x < 0 ||
    nextHead.y < 0 ||
    nextHead.x >= BOARD_SIZE ||
    nextHead.y >= BOARD_SIZE
  ) {
    return { ...state, phase: "dead", deathReason: "wall" };
  }

  const ateFood = nextHead.x === state.food.x && nextHead.y === state.food.y;
  const nextSnake = [nextHead, ...state.snake];
  const snakeAfterMove = ateFood ? nextSnake : nextSnake.slice(0, -1);
  const bodyToCheck = ateFood ? state.snake : state.snake.slice(0, -1);

  if (bodyToCheck.some((cell) => cell.x === nextHead.x && cell.y === nextHead.y)) {
    return {
      ...state,
      phase: "dead",
      deathReason: "self"
    };
  }

  return {
    ...state,
    snake: snakeAfterMove,
    food: ateFood ? makeFood(snakeAfterMove) : state.food,
    score: ateFood ? state.score + 10 : state.score,
    tick: state.tick + 1
  };
}

export function createInitialGame() {
  return {
    phase: "idle",
    snake: START_SNAKE,
    food: makeFood(START_SNAKE),
    direction: "RIGHT",
    pendingDirection: "RIGHT",
    score: 0,
    tick: 0,
    moves: [],
    deathReason: null,
    sessionId: null,
    startedAt: null,
    lockedResult: null
  };
}
