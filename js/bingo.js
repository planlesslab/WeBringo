// Pure bingo helpers: duplicate checks and win detection.

/** "  Holiday   PLANS " and "holiday plans" count as the same phrase. */
export const normalise = (s) => (s || "").trim().replace(/\s+/g, " ").toLowerCase();

/** Indexes of every cell whose phrase appears in another cell too. */
export function findDuplicates(cells) {
  const seen = new Map();
  const dup = new Set();
  cells.forEach((c, i) => {
    const k = normalise(c);
    if (!k) return;
    if (seen.has(k)) { dup.add(i); dup.add(seen.get(k)); }
    else seen.set(k, i);
  });
  return dup;
}

/** Every row, column and both diagonals, as arrays of cell indexes. */
export function allLines(size) {
  const out = [];
  for (let r = 0; r < size; r++) out.push(Array.from({ length: size }, (_, c) => r * size + c));
  for (let c = 0; c < size; c++) out.push(Array.from({ length: size }, (_, r) => r * size + c));
  out.push(Array.from({ length: size }, (_, i) => i * size + i));
  out.push(Array.from({ length: size }, (_, i) => i * size + (size - 1 - i)));
  return out;
}

/**
 * Returns the winning cell indexes, or null.
 * rule "line": any full row, column or diagonal. rule "full": every cell.
 */
export function winningCells(counts, size, rule) {
  const marked = (i) => (counts?.[i] || 0) > 0;
  const n = size * size;
  if (rule === "full") {
    for (let i = 0; i < n; i++) if (!marked(i)) return null;
    return Array.from({ length: n }, (_, i) => i);
  }
  return allLines(size).find((line) => line.every(marked)) || null;
}

export const RULE_LABEL = {
  line: "Line bingo: a full row, column or diagonal",
  full: "Full card: every box ticked",
};
