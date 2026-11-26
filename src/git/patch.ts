// Pure helpers for applying parts of a diff; no vscode dependency so they can be unit tested.
import { Hunk } from './history';

/** Picked line indexes per hunk; undefined means the whole hunk. */
export type Picks = Map<number, Set<number> | undefined>;

/** For each '-' line followed by a run of '+' lines, the '+' line it was replaced by (same offset in the runs). */
export function pairs(h: Hunk): Map<number, number> {
  const out = new Map<number, number>();
  for (let i = 0; i < h.lines.length;) {
    if (h.lines[i][0] !== '-') { i++; continue; }
    const delStart = i;
    while (i < h.lines.length && h.lines[i][0] === '-') i++;
    const addStart = i;
    while (i < h.lines.length && h.lines[i][0] === '+') i++;
    for (let k = 0; delStart + k < addStart && addStart + k < i; k++) {
      out.set(addStart + k, delStart + k);
      out.set(delStart + k, addStart + k);
    }
  }
  return out;
}

export interface LineChange { kind: '+' | '-'; line: number; text: string; }

/**
 * The lines a diff hunk becomes once its picked changes are applied. A picked '+' line that
 * replaces a picked '-' line is put where that '-' line was, so it lands in the same spot.
 */
export function applyHunk(h: Hunk, pick: Set<number> | undefined): { out: string[]; changes: LineChange[] } {
  const take = (j: number) => !pick || pick.has(j);
  const pair = pairs(h);
  const moved = new Set<number>();
  const out: string[] = [], changes: LineChange[] = [];
  let cur = h.oldCount === 0 ? h.oldStart + 1 : h.oldStart;
  h.lines.forEach((l, j) => {
    if (l[0] === ' ') { out.push(l.slice(1)); cur++; return; }
    if (l[0] === '-') {
      if (!take(j)) { out.push(l.slice(1)); cur++; return; }
      changes.push({ kind: '-', line: cur, text: l.slice(1) });
      const p = pair.get(j);
      if (p !== undefined && take(p)) {
        moved.add(p);
        out.push(h.lines[p].slice(1));
        changes.push({ kind: '+', line: cur, text: h.lines[p].slice(1) });
      }
      cur++;
      return;
    }
    if (take(j) && !moved.has(j)) {
      out.push(l.slice(1));
      changes.push({ kind: '+', line: cur, text: l.slice(1) });
    }
  });
  return { out, changes };
}

/** A replacement of `count` lines starting at 0-based line `start` with `lines`. */
export interface LineEdit { start: number; count: number; lines: string[]; }

/** Line edits that apply the picked parts of `hunks` (a diff whose old side is the document). */
export function restoreEdits(hunks: Hunk[], picks: Picks): LineEdit[] {
  return [...picks].flatMap(([i, pick]) => {
    const h = hunks[i];
    if (!h) return [];
    // With zero old lines git reports the line *after which* to insert.
    const start = h.oldCount === 0 ? h.oldStart : h.oldStart - 1;
    return [{ start, count: h.oldCount, lines: applyHunk(h, pick).out }];
  });
}

/** Applies line edits to `text` (LF line endings); used by tests and mirrors the editor edit. */
export function applyEdits(text: string, edits: LineEdit[]): string {
  const lines = text.split('\n');
  for (const e of [...edits].sort((a, b) => b.start - a.start)) lines.splice(e.start, e.count, ...e.lines);
  return lines.join('\n');
}
