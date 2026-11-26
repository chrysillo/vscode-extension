import { execFile } from 'child_process';
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';

export interface Hunk {
  header: string;
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  /** Diff body lines, each prefixed with ' ', '-' or '+'. */
  lines: string[];
}

export interface Commit {
  hash: string;
  author: string;
  date: number;
  subject: string;
  path: string;
  hunks: Hunk[];
}

const MAX_COMMITS = 200;

/** Runs git; exit codes listed in `okCodes` (besides 0) still resolve. */
export function run(cwd: string, args: string[], okCodes: number[] = []): Promise<string> {
  return new Promise((resolve, reject) =>
    execFile('git', args, { cwd, maxBuffer: 256 * 1024 * 1024 }, (err, out, stderr) => {
      const code = (err as { code?: unknown } | null)?.code;
      err && !(typeof code === 'number' && okCodes.includes(code)) ? reject(new Error(stderr || err.message)) : resolve(out);
    }));
}

/** Every commit that touched `relPath` (following renames), newest first, with its diff for that file. */
export async function fileHistory(root: string, relPath: string): Promise<Commit[]> {
  const out = await run(root, [
    'log', '--follow', `-n${MAX_COMMITS}`, '--no-color', '-p', '-U3', '--no-ext-diff',
    '--format=%x1e%H%x1f%an%x1f%at%x1f%s', '--', relPath,
  ]);
  return out.split('\x1e').filter(Boolean).map(parseCommit);
}

function parseCommit(chunk: string): Commit {
  const nl = chunk.indexOf('\n');
  const [hash, author, at, subject] = (nl < 0 ? chunk : chunk.slice(0, nl)).split('\x1f');
  const body = nl < 0 ? '' : chunk.slice(nl + 1);
  const file = /^\+\+\+ (?:b\/)?(.*)$/m.exec(body)?.[1] ?? '';
  return { hash, author, date: Number(at) * 1000, subject, path: file === '/dev/null' ? '' : file, hunks: parseHunks(body) };
}

function parseHunks(diff: string): Hunk[] {
  const hunks: Hunk[] = [];
  let hunk: Hunk | undefined;
  for (const line of diff.split('\n')) {
    const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (m) {
      hunk = { header: line, oldStart: Number(m[1]), oldCount: m[2] === undefined ? 1 : Number(m[2]), newStart: Number(m[3]), newCount: m[4] === undefined ? 1 : Number(m[4]), lines: [] };
      hunks.push(hunk);
    } else if (hunk && /^[ +-]/.test(line) && !line.startsWith('+++ ') && !line.startsWith('--- ')) {
      hunk.lines.push(line);
    } else if (!line.startsWith('\\')) {
      hunk = undefined;
    }
  }
  return hunks;
}

/** The file's content as of `hash`, or undefined if it didn't exist there. */
export async function showFile(root: string, hash: string, relPath: string): Promise<string | undefined> {
  try { return await run(root, ['show', `${hash}:${relPath.split(path.sep).join('/')}`]); }
  catch { return undefined; }
}

/** Line diff from `a` to `b`; hunk "old" side refers to `a`. Line endings are normalised to LF. */
export async function diffTexts(a: string, b: string): Promise<Hunk[]> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ohmg-'));
  try {
    const fa = path.join(dir, 'a'), fb = path.join(dir, 'b');
    await Promise.all([fs.writeFile(fa, a.replace(/\r\n/g, '\n')), fs.writeFile(fb, b.replace(/\r\n/g, '\n'))]);
    const out = await run(dir, ['diff', '--no-index', '--no-color', '--no-ext-diff', '-U3', 'a', 'b'], [1]);
    return parseHunks(out);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

/** Hash of the commit that last changed `line` (1-based) in the committed file, if any. */
export async function blameLine(root: string, relPath: string, line: number): Promise<string | undefined> {
  try {
    const out = await run(root, ['blame', '--porcelain', '-L', `${line},${line}`, '--', relPath]);
    const hash = out.slice(0, 40);
    return /^0+$/.test(hash) ? undefined : hash;
  } catch {
    return undefined;
  }
}

/**
 * Position of each hunk line on the "new" side: line n is 2n, the gap after line n is 2n+1.
 * Removed lines sit in a gap. Lets two diffs that share a new side be lined up exactly.
 */
export function newSidePositions(h: Hunk): number[] {
  let n = h.newCount === 0 ? h.newStart + 1 : h.newStart;
  return h.lines.map(l => (l[0] === '-' ? 2 * (n - 1) + 1 : 2 * n++));
}
