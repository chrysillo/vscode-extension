import * as assert from 'assert/strict';
import { describe, it } from 'node:test';
import { diffTexts } from '../git/history';
import { applyEdits, applyHunk, pairs, Picks, restoreEdits } from '../git/patch';
import { lines } from './helpers';

/** Restores the picked lines (by their text in the diff) from `commit` into `current`. */
async function restore(current: string, commit: string, pickText?: string[]): Promise<string> {
  const hunks = await diffTexts(current, commit);
  const picks: Picks = new Map();
  hunks.forEach((h, i) => {
    if (!pickText) return picks.set(i, undefined);
    const set = new Set(h.lines.flatMap((l, j) => (pickText.includes(l) ? [j] : [])));
    if (set.size) picks.set(i, set);
  });
  return applyEdits(current, restoreEdits(hunks, picks));
}

describe('restoring from a commit', () => {
  const commit = lines('a', 'B', 'c');
  const current = lines('a', 'B2', 'n1', 'n2', 'c');

  it('restores a whole block to the commit', async () => {
    assert.equal(await restore(current, commit), commit);
  });

  it('replaces an edited line in place when both sides are picked', async () => {
    assert.equal(await restore(current, commit, ['-B2', '+B']), lines('a', 'B', 'n1', 'n2', 'c'));
  });

  it('only inserts when just the commit line is picked', async () => {
    assert.equal(await restore(current, commit, ['+B']), lines('a', 'B2', 'n1', 'n2', 'B', 'c'));
  });

  it('only removes when just a current line is picked', async () => {
    assert.equal(await restore(current, commit, ['-n1']), lines('a', 'B2', 'n2', 'c'));
  });

  it('never touches lines that were not picked, however many there are', async () => {
    const many = Array.from({ length: 30 }, (_, i) => `new${i}`);
    const cur = lines('a', 'B2', ...many, 'c');
    assert.equal(await restore(cur, commit, ['-B2', '+B']), lines('a', 'B', ...many, 'c'));
  });

  it('applies several hunks at once without shifting each other', async () => {
    const base = Array.from({ length: 40 }, (_, i) => `l${i}`);
    const cur = [...base]; cur[2] = 'X'; cur[30] = 'Y';
    assert.equal(await restore(lines(...cur), lines(...base)), lines(...base));
  });

  it('restores into an empty file and empties a file', async () => {
    assert.equal(await restore('', lines('a', 'b')), lines('a', 'b'));
    assert.equal(await restore(lines('a', 'b'), ''), '');
  });

  it('inserts lines at the very start and the very end', async () => {
    assert.equal(await restore(lines('b', 'c'), lines('a', 'b', 'c')), lines('a', 'b', 'c'));
    assert.equal(await restore(lines('a', 'b'), lines('a', 'b', 'c')), lines('a', 'b', 'c'));
  });

  it('handles content that looks like diff headers', async () => {
    const cur = lines('x', '-- sql comment', '++ y', 'z');
    const old = lines('x', '--- other', '+++ thing', 'z');
    assert.equal(await restore(cur, old), old);
  });

  it('handles blank lines inside hunks', async () => {
    const old = lines('a', '', 'b', '', 'c');
    assert.equal(await restore(lines('a', '', 'B', '', 'c'), old), old);
  });

  it('treats CRLF and LF text as the same lines', async () => {
    assert.deepEqual(await diffTexts('a\r\nb\r\n', 'a\nb\n'), []);
  });
});

describe('pairs', () => {
  it('pairs removed and added lines by offset within a run', () => {
    const p = pairs({ header: '', oldStart: 1, oldCount: 3, newStart: 1, newCount: 2, lines: [' a', '-b', '-c', '+B', ' d'] });
    assert.equal(p.get(1), 3);
    assert.equal(p.get(3), 1);
    assert.equal(p.has(2), false);
  });
});

describe('applyHunk', () => {
  it('reports changes with current-file line numbers', () => {
    const { changes } = applyHunk({ header: '', oldStart: 10, oldCount: 2, newStart: 10, newCount: 2, lines: [' a', '-b', '+B'] }, undefined);
    assert.deepEqual(changes, [{ kind: '-', line: 11, text: 'b' }, { kind: '+', line: 11, text: 'B' }]);
  });
});
