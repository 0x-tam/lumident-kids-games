/**
 * Maze Escape — the maze itself.
 *
 * Pure data. No React, no three, no DOM: importing this file pulls in nothing, which is
 * what lets the shell, the engine, the geometry builder and the announcer all share one
 * definition of "the maze" without any of them reaching into each other.
 *
 * The generator, the dead-end picker and the shortest-path search are carried over from
 * the 2D implementation **unchanged** — same algorithm, same randomisation, same start and
 * goal cells (PROJECT.md: "a genuinely generated maze, fresh every run"). Everything after
 * `pathBetween` is new and exists only to serve the 3D build:
 *
 *   • `corridorLoops` traces the boundary of the carved region as closed polygons, so the
 *     gum block can be extruded as one solid with the corridors as holes rather than as a
 *     pile of per-cell blocks with a groove between every pair of neighbours.
 *   • `filletLoop` rounds every corner of that boundary. A bevel on the extrusion rounds
 *     the *top* edge of a wall; it does nothing about a 90-degree vertical crease seen from
 *     above, and 3D-SPEC §3 allows no hard silhouette corner anywhere in this product.
 *   • `goalDistances` is a BFS field used to tell a screen-reader player how far they are
 *     from the toothbrush — the maze has to be playable by ear, not only by eye.
 */

/** Odd sizes, because the generator carves rooms on odd indices and walls on even ones. */
export const GRID = [9, 11, 13] as const;

export type Cell = { r: number; c: number };

const key = (p: Cell) => `${p.r},${p.c}`;

/** Iterative recursive-backtracker maze. true = wall. Start (1,1), goal (n-2,n-2). */
export function generateMaze(n: number): boolean[][] {
  const g: boolean[][] = Array.from({ length: n }, () => Array(n).fill(true));
  const stack: Cell[] = [{ r: 1, c: 1 }];
  g[1][1] = false;
  while (stack.length) {
    const cur = stack[stack.length - 1];
    const options = [
      [0, 2],
      [0, -2],
      [2, 0],
      [-2, 0],
    ]
      .map(([dr, dc]) => ({ r: cur.r + dr, c: cur.c + dc, wr: cur.r + dr / 2, wc: cur.c + dc / 2 }))
      .filter((p) => p.r > 0 && p.r < n - 1 && p.c > 0 && p.c < n - 1 && g[p.r][p.c]);
    if (!options.length) {
      stack.pop();
      continue;
    }
    const next = options[Math.floor(Math.random() * options.length)];
    g[next.wr][next.wc] = false;
    g[next.r][next.c] = false;
    stack.push({ r: next.r, c: next.c });
  }
  return g;
}

/** Open cells with exactly one open neighbour — natural spots for treat decorations. */
export function deadEnds(maze: boolean[][], n: number): Cell[] {
  const out: Cell[] = [];
  for (let r = 1; r < n - 1; r++) {
    for (let c = 1; c < n - 1; c++) {
      if (maze[r][c]) continue;
      if ((r === 1 && c === 1) || (r === n - 2 && c === n - 2)) continue;
      const open = [
        [1, 0],
        [-1, 0],
        [0, 1],
        [0, -1],
      ].filter(([dr, dc]) => !maze[r + dr][c + dc]);
      if (open.length === 1) out.push({ r, c });
    }
  }
  return out.sort(() => Math.random() - 0.5);
}

/** Shortest path between two open cells (list of steps, excluding `from`). */
export function pathBetween(maze: boolean[][], n: number, from: Cell, to: Cell): Cell[] {
  if (maze[to.r][to.c]) return [];
  if (from.r === to.r && from.c === to.c) return [];
  const prev = new Map<string, Cell | null>([[key(from), null]]);
  const queue: Cell[] = [from];
  while (queue.length) {
    const cur = queue.shift()!;
    if (cur.r === to.r && cur.c === to.c) break;
    for (const [dr, dc] of [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
    ]) {
      const nr = cur.r + dr;
      const nc = cur.c + dc;
      if (nr < 0 || nr >= n || nc < 0 || nc >= n || maze[nr][nc]) continue;
      if (prev.has(`${nr},${nc}`)) continue;
      prev.set(`${nr},${nc}`, cur);
      queue.push({ r: nr, c: nc });
    }
  }
  if (!prev.has(key(to))) return [];
  const path: Cell[] = [];
  let cur: Cell | null = to;
  while (cur && !(cur.r === from.r && cur.c === from.c)) {
    path.unshift(cur);
    cur = prev.get(key(cur)) ?? null;
  }
  return path;
}

/**
 * Steps from every open cell to `goal`, -1 for walls and unreachable cells.
 *
 * A flood fill from the goal rather than a search per query: it is computed once per maze
 * and read on every keyboard step, which is what makes "eleven steps to go" free to say.
 */
export function goalDistances(maze: boolean[][], n: number, goal: Cell): Int16Array {
  const dist = new Int16Array(n * n).fill(-1);
  if (maze[goal.r][goal.c]) return dist;
  const queue = new Int16Array(n * n);
  let head = 0;
  let tail = 0;
  dist[goal.r * n + goal.c] = 0;
  queue[tail++] = goal.r * n + goal.c;
  while (head < tail) {
    const at = queue[head++];
    const r = (at / n) | 0;
    const c = at - r * n;
    const d = dist[at] + 1;
    if (r > 0 && !maze[r - 1][c] && dist[at - n] < 0) {
      dist[at - n] = d;
      queue[tail++] = at - n;
    }
    if (r < n - 1 && !maze[r + 1][c] && dist[at + n] < 0) {
      dist[at + n] = d;
      queue[tail++] = at + n;
    }
    if (c > 0 && !maze[r][c - 1] && dist[at - 1] < 0) {
      dist[at - 1] = d;
      queue[tail++] = at - 1;
    }
    if (c < n - 1 && !maze[r][c + 1] && dist[at + 1] < 0) {
      dist[at + 1] = d;
      queue[tail++] = at + 1;
    }
  }
  return dist;
}

/* ------------------------------------------------------------------ */
/* Corridor outline                                                    */
/* ------------------------------------------------------------------ */

/**
 * Traces the boundary of the carved region as closed loops of lattice points, in cell
 * units: `[u0, v0, u1, v1, …]` where `u` is the column edge and `v` the row edge, so cell
 * `(r, c)` spans `u ∈ [c, c+1]`, `v ∈ [r, r+1]`.
 *
 * Every open cell contributes one directed edge per side that faces a wall, walked in the
 * order top → right → bottom → left so that consecutive edges chain head-to-tail. Linking
 * them needs each lattice point to have exactly one outgoing boundary edge, which is true
 * here for a structural reason worth writing down: two open cells can never touch at only
 * a corner. Open cells are either `(odd, odd)` rooms or the `(odd, even)` / `(even, odd)`
 * walls the generator knocked through; for any two diagonally adjacent cells one of the
 * two cells completing that 2×2 block is `(odd, odd)`, which is always open. So a diagonal
 * pair is always part of a solid L, never a pinch — and the trace is unambiguous.
 *
 * A perfect maze's passages form a spanning tree, so the carved region is connected and
 * simply connected and this returns exactly one loop. Multiple loops are still handled, so
 * the caller does not depend on that being true.
 */
export function corridorLoops(maze: boolean[][], n: number): number[][] {
  const isOpen = (r: number, c: number) => r >= 0 && r < n && c >= 0 && c < n && !maze[r][c];

  const sx: number[] = [];
  const sy: number[] = [];
  const ex: number[] = [];
  const ey: number[] = [];
  const stride = n + 2;
  const from = new Map<number, number>();

  const edge = (x1: number, y1: number, x2: number, y2: number) => {
    from.set(x1 * stride + y1, sx.length);
    sx.push(x1);
    sy.push(y1);
    ex.push(x2);
    ey.push(y2);
  };

  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      if (maze[r][c]) continue;
      if (!isOpen(r - 1, c)) edge(c, r, c + 1, r);
      if (!isOpen(r, c + 1)) edge(c + 1, r, c + 1, r + 1);
      if (!isOpen(r + 1, c)) edge(c + 1, r + 1, c, r + 1);
      if (!isOpen(r, c - 1)) edge(c, r + 1, c, r);
    }
  }

  const used = new Uint8Array(sx.length);
  const loops: number[][] = [];
  for (let start = 0; start < sx.length; start++) {
    if (used[start]) continue;
    const loop: number[] = [];
    let at = start;
    let guard = sx.length + 4;
    while (!used[at] && guard-- > 0) {
      used[at] = 1;
      loop.push(sx[at], sy[at]);
      const next = from.get(ex[at] * stride + ey[at]);
      if (next === undefined) break;
      at = next;
    }
    if (loop.length >= 6) loops.push(loop);
  }
  return loops;
}

/**
 * Widens the goal cell into the two border-wall cells behind it, turning the corner of the
 * maze into a real carved bay for the toothbrush to stand in.
 *
 * The alcove is cut into the *outline*, not added as a prop, which is what makes it safe:
 * a free-standing archway over the goal cell would sit across a corridor mouth in about
 * seven runs out of ten (the goal is a through-cell that often), and the tooth would roll
 * straight through it. A recess cannot be in the way of anything.
 *
 * Its position is always legal. The goal is `(n-2, n-2)`, so the cells to its south and its
 * east are border walls in every maze this generator can produce; the bay pushes `depth`
 * cells into that L and still leaves most of the border ring standing, clear of the board's
 * own rounded corner.
 *
 * The three lattice points the goal cell contributes to the boundary — the start of its
 * east side, its south-east corner and the start of its south side — are always present and
 * always consecutive, because the tracer walks each cell top → right → bottom → left.
 */
export function carveAlcove(loop: number[], gr: number, gc: number, depth: number): number[] {
  const m = loop.length / 2;
  let corner = -1;
  for (let i = 0; i < m; i++) {
    if (loop[i * 2] === gc + 1 && loop[i * 2 + 1] === gr + 1) {
      corner = i;
      break;
    }
  }
  if (corner < 0) return loop;

  const before = ((corner - 1 + m) % m) * 2;
  const after = ((corner + 1) % m) * 2;
  if (loop[before] !== gc + 1 || loop[before + 1] !== gr) return loop;
  if (loop[after] !== gc || loop[after + 1] !== gr + 1) return loop;

  const out: number[] = [];
  for (let i = 0; i < m; i++) {
    const x = loop[i * 2];
    const y = loop[i * 2 + 1];
    if (i === corner) {
      // Mouth, back-east, corner, back-south — splayed so the bay opens toward the corridor
      // instead of reading as a square box bolted onto the cell.
      out.push(gc + 1 + depth, gr + 0.3);
      out.push(gc + 1 + depth, gr + 1 + depth);
      out.push(gc + 0.7, gr + 1 + depth);
      continue;
    }
    out.push(x, y);
  }
  return out;
}

/** Drops points that sit on the straight line between their neighbours. */
export function mergeCollinear(loop: number[]): number[] {
  const m = loop.length / 2;
  if (m < 3) return loop.slice();
  const out: number[] = [];
  for (let i = 0; i < m; i++) {
    const p = ((i - 1 + m) % m) * 2;
    const c = i * 2;
    const q = ((i + 1) % m) * 2;
    const ax = loop[c] - loop[p];
    const ay = loop[c + 1] - loop[p + 1];
    const bx = loop[q] - loop[c];
    const by = loop[q + 1] - loop[c + 1];
    if (Math.abs(ax * by - ay * bx) < 1e-9) continue;
    out.push(loop[c], loop[c + 1]);
  }
  return out.length >= 6 ? out : loop.slice();
}

/**
 * Miter-offsets a closed polygon outward by `d`, in the loop's own units.
 *
 * ## Why a carved corridor has to be cut wider than the corridor it wants
 *
 * `ExtrudeGeometry` holds a contour at both caps and offsets it by `bevelSize` through the
 * middle, so a solid is **widest between its bevels** — measured on the shipped gum block by
 * `scratchpad/verify/me-bevel.mjs`, the outer contour sits at nominal at y = 0.0850 and
 * y = 0.3922 and at nominal + `wallBevel` at every plane between. For a *hole* that means the
 * corridor is narrowest exactly where a prop standing on the floor occupies it: a nominal
 * one-cell corridor has a clear width of `1 - 2 x wallBevel/cell` = **0.787 cells** at 9
 * cells, not 1.0.
 *
 * Three rounds of arithmetic in `layout.ts` assumed the 1.0. The consequences were all real
 * and all measured: the hero's arms stand **0.0115 units** from the gum at rest against a
 * §3 minimum bevel of 0.02 and go *inside* it on every bump (`maze-bump.mjs`, whose own wall
 * was at `cell / 2` and therefore could not see it); the start ring ran under the gum by up to
 * 0.0017 units (`me-ring.mjs`); the toothbrush by 0.017 (`me-goal.mjs`).
 *
 * Offsetting the carved contour outward by exactly the bevel restores the design's own
 * geometry — a one-cell clear corridor, a one-cell wall — instead of correcting nine
 * downstream numbers against a width nobody intended. The bevel is unchanged, so §3's rolled
 * lip is unchanged; only where it is rolled *from* moves.
 *
 * ## Why it is safe on this maze
 *
 * Offsetting a hole outward can break the solid at a diagonal pinch — two open cells touching
 * only at a corner. `generateMaze` cannot produce one: it carves on the odd sublattice, so any
 * two diagonally adjacent open cells always share an open orthogonal neighbour. Verified over
 * **1,200 generated mazes** (400 each at 9, 11 and 13 cells): zero pinches
 * (`scratchpad/verify/me-pinch.mjs`). The thinnest edge the offset has to survive is the bay's
 * own 0.3-cell mouth against `2d` = 0.213 cells.
 *
 * The miter is exact for the axis-aligned edges this maze is made of and for the bay's two
 * diagonals; a corner sharper than `MITER_LIMIT` would spike, so it is clamped there — which
 * cannot fire on a 90° turn (miter √2) and is a guard rather than a behaviour.
 */
const MITER_LIMIT = 4;

export function offsetLoop(loop: number[], d: number): number[] {
  const m = loop.length / 2;
  if (m < 3 || d === 0) return loop.slice();
  // Outward is away from the enclosed area, whichever way the loop happens to wind.
  const sign = signedArea(loop) > 0 ? 1 : -1;
  const out: number[] = [];
  for (let i = 0; i < m; i++) {
    const p = ((i - 1 + m) % m) * 2;
    const c = i * 2;
    const q = ((i + 1) % m) * 2;
    // Outward normals of the two edges meeting at this vertex.
    const inX = loop[c] - loop[p];
    const inY = loop[c + 1] - loop[p + 1];
    const outX = loop[q] - loop[c];
    const outY = loop[q + 1] - loop[c + 1];
    const li = Math.hypot(inX, inY);
    const lo = Math.hypot(outX, outY);
    if (li < 1e-9 || lo < 1e-9) {
      out.push(loop[c], loop[c + 1]);
      continue;
    }
    const n1x = (sign * inY) / li;
    const n1y = (-sign * inX) / li;
    const n2x = (sign * outY) / lo;
    const n2y = (-sign * outX) / lo;
    // Miter direction = the normalised bisector; its length is 1 / cos(half the turn).
    let bx = n1x + n2x;
    let by = n1y + n2y;
    const bl = Math.hypot(bx, by);
    if (bl < 1e-9) {
      out.push(loop[c] + n1x * d, loop[c + 1] + n1y * d);
      continue;
    }
    bx /= bl;
    by /= bl;
    const cosHalf = bx * n1x + by * n1y;
    const scale = Math.min(MITER_LIMIT, 1 / Math.max(1e-6, cosHalf));
    out.push(loop[c] + bx * d * scale, loop[c + 1] + by * d * scale);
  }
  return out;
}

/**
 * Replaces every corner of a closed polygon with a circular arc.
 *
 * `radius` is the ideal fillet; the tangent length it implies is clamped to 45% of each
 * adjacent edge so two fillets on a one-cell edge can never cross and invert the outline.
 * Convex and concave corners are both filleted — a concave corner left sharp is a knife
 * edge in the gum exactly where a child's eye follows the corridor round a bend.
 */
export function filletLoop(loop: number[], radius: number, segments: number): number[] {
  const m = loop.length / 2;
  if (m < 3) return loop.slice();
  const out: number[] = [];

  for (let i = 0; i < m; i++) {
    const pi = ((i - 1 + m) % m) * 2;
    const ci = i * 2;
    const ni = ((i + 1) % m) * 2;
    const cx = loop[ci];
    const cy = loop[ci + 1];

    let ax = cx - loop[pi];
    let ay = cy - loop[pi + 1];
    let bx = loop[ni] - cx;
    let by = loop[ni + 1] - cy;
    const la = Math.hypot(ax, ay);
    const lb = Math.hypot(bx, by);
    if (la < 1e-9 || lb < 1e-9) {
      out.push(cx, cy);
      continue;
    }
    ax /= la;
    ay /= la;
    bx /= lb;
    by /= lb;

    const cross = ax * by - ay * bx;
    const dot = ax * bx + ay * by;
    if (Math.abs(cross) < 1e-9) {
      out.push(cx, cy);
      continue;
    }

    const turn = Math.atan2(cross, dot);
    const half = Math.abs(turn) / 2;
    const tanHalf = Math.tan(half);
    // Tangent length first, radius second: clamping the radius directly would let a sharp
    // turn (small tanHalf) still push its tangent points past the end of a short edge.
    const t = Math.min(radius * tanHalf, la * 0.45, lb * 0.45);
    const r = t / tanHalf;
    if (r < 1e-5) {
      out.push(cx, cy);
      continue;
    }

    const t1x = cx - ax * t;
    const t1y = cy - ay * t;
    const t2x = cx + bx * t;
    const t2y = cy + by * t;
    const sign = cross > 0 ? 1 : -1;
    // Centre sits one radius along the inward normal of the incoming edge.
    const centreX = t1x + -ay * r * sign;
    const centreY = t1y + ax * r * sign;

    const a0 = Math.atan2(t1y - centreY, t1x - centreX);
    let a1 = Math.atan2(t2y - centreY, t2x - centreX);
    let sweep = a1 - a0;
    if (sign > 0 && sweep < 0) sweep += Math.PI * 2;
    if (sign < 0 && sweep > 0) sweep -= Math.PI * 2;

    const steps = Math.max(1, segments);
    for (let s = 0; s <= steps; s++) {
      a1 = a0 + (sweep * s) / steps;
      out.push(centreX + Math.cos(a1) * r, centreY + Math.sin(a1) * r);
    }
  }

  return out;
}

/** Signed area of a closed polygon; positive is counter-clockwise. */
export function signedArea(loop: number[]): number {
  let sum = 0;
  const m = loop.length / 2;
  for (let i = 0; i < m; i++) {
    const j = (i + 1) % m;
    sum += loop[i * 2] * loop[j * 2 + 1] - loop[j * 2] * loop[i * 2 + 1];
  }
  return sum / 2;
}

/** Reverses a flat point loop in place and returns it. */
export function reverseLoop(loop: number[]): number[] {
  const m = loop.length / 2;
  for (let i = 0; i < (m >> 1); i++) {
    const j = m - 1 - i;
    const xa = loop[i * 2];
    const ya = loop[i * 2 + 1];
    loop[i * 2] = loop[j * 2];
    loop[i * 2 + 1] = loop[j * 2 + 1];
    loop[j * 2] = xa;
    loop[j * 2 + 1] = ya;
  }
  return loop;
}
