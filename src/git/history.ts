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
  /** Commit message after the subject line. */
  body: string;
  path: string;
  hunks: Hunk[];
}

const MAX_COMMITS = 200;

/** Overrides for user config that would change the output we parse. */
const GIT_OPTS = ['-c', 'core.quotePath=false', '-c', 'diff.noprefix=false', '-c', 'diff.mnemonicPrefix=false', '-c', 'diff.suppressBlankEmpty=false'];

/** git (posix) form of a path relative to the repo root. */
const gitPath = (p: string) => p.split(path.sep).join('/');

/** Runs git; exit codes listed in `okCodes` (besides 0) still resolve. */
export function run(cwd: string, args: string[], okCodes: number[] = []): Promise<string> {
  return new Promise((resolve, reject) =>
    execFile('git', [...GIT_OPTS, ...args], { cwd, maxBuffer: 256 * 1024 * 1024 }, (err, out, stderr) => {
      const code = (err as { code?: unknown } | null)?.code;
      err && !(typeof code === 'number' && okCodes.includes(code)) ? reject(new Error(stderr || err.message)) : resolve(out);
    }));
}

/** Every commit that touched `relPath` (following renames), newest first, with its diff for that file. */
export async function fileHistory(root: string, relPath: string): Promise<Commit[]> {
  const out = await run(root, [
    'log', '--follow', `-n${MAX_COMMITS}`, '--no-color', '-p', '-U3', '--no-ext-diff', '--no-show-signature',
    '--src-prefix=a/', '--dst-prefix=b/', '--format=%x1e%H%x1f%an%x1f%at%x1f%s%x1f%b%x1d', '--', gitPath(relPath),
  ]);
  return out.split('\x1e').filter(Boolean).map(parseCommit);
}

/** Undoes git's C-style quoting of unusual paths ("a/tab\there.txt"). */
export function unquote(p: string): string {
  if (!p.startsWith('"') || !p.endsWith('"')) return p;
  const bytes: number[] = [];
  const body = p.slice(1, -1);
  const esc: Record<string, number> = { n: 10, t: 9, r: 13, '"': 34, '\\': 92, a: 7, b: 8, f: 12, v: 11 };
  for (let i = 0; i < body.length; i++) {
    if (body[i] !== '\\') { bytes.push(...Buffer.from(body[i])); continue; }
    const oct = /^[0-7]{3}/.exec(body.slice(i + 1));
    if (oct) { bytes.push(parseInt(oct[0], 8)); i += 3; }
    else { bytes.push(esc[body[i + 1]] ?? body.charCodeAt(i + 1)); i++; }
  }
  return Buffer.from(bytes).toString('utf8');
}

function parseCommit(chunk: string): Commit {
  const end = chunk.indexOf('\x1d');
  const [hash, author, at, subject, message = ''] = (end < 0 ? chunk : chunk.slice(0, end)).split('\x1f');
  const diff = end < 0 ? '' : chunk.slice(end + 1);
  // git appends a tab to header paths that contain spaces.
  const file = unquote((/^\+\+\+ (.*)$/m.exec(diff)?.[1] ?? '').replace(/\t$/, '')).replace(/^b\//, '');
  return {
    hash, author, date: Number(at) * 1000, subject, body: message.trim(),
    path: file === '/dev/null' ? '' : file, hunks: parseHunks(diff),
  };
}

export interface CommitFile {
  /** A, M, D, R, C or T. */
  status: string;
  path: string;
  /** Previous path for renames and copies. */
  oldPath?: string;
  /** Lines added / removed; undefined for binary files. */
  added?: number;
  removed?: number;
}

/** Every file changed in `hash`, with line counts. */
export async function commitFiles(root: string, hash: string): Promise<CommitFile[]> {
  const base = ['show', '--format=', '-M', '-z', '--no-ext-diff', hash];
  const [names, nums] = await Promise.all([run(root, [...base, '--name-status']), run(root, [...base, '--numstat'])]);

  const files: CommitFile[] = [];
  const n = names.split('\0');
  for (let i = 0; i < n.length && n[i];) {
    const status = n[i++][0];
    if (status === 'R' || status === 'C') files.push({ status, oldPath: n[i++], path: n[i++] });
    else files.push({ status, path: n[i++] });
  }

  // numstat -z: "add\tdel\tpath\0", or "add\tdel\t\0old\0new\0" for renames.
  const counts = new Map<string, [number?, number?]>();
  const m = nums.split('\0');
  for (let i = 0; i < m.length && m[i];) {
    const [a, d, p] = m[i++].split('\t');
    const path = p ? p : (i++, m[i++]);
    counts.set(path, [a === '-' ? undefined : Number(a), d === '-' ? undefined : Number(d)]);
  }
  for (const f of files) [f.added, f.removed] = counts.get(f.path) ?? [];
  return files;
}

function parseHunks(diff: string): Hunk[] {
  const hunks: Hunk[] = [];
  let hunk: Hunk | undefined;
  let oldLeft = 0, newLeft = 0;
  for (const line of diff.split('\n')) {
    if (hunk && (oldLeft > 0 || newLeft > 0)) {
      // Inside a hunk the counts say where it ends, so '--- x' / '+++ x' content isn't mistaken for a header.
      const k = line[0];
      if (k === ' ' || k === '-') oldLeft--;
      if (k === ' ' || k === '+') newLeft--;
      if (k === ' ' || k === '-' || k === '+') { hunk.lines.push(line); continue; }
      if (k === '\\') continue;
      if (line === '' && oldLeft > 0 && newLeft > 0) { oldLeft--; newLeft--; hunk.lines.push(' '); continue; }
    }
    const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (!m) continue;
    hunk = { header: line, oldStart: Number(m[1]), oldCount: m[2] === undefined ? 1 : Number(m[2]), newStart: Number(m[3]), newCount: m[4] === undefined ? 1 : Number(m[4]), lines: [] };
    oldLeft = hunk.oldCount; newLeft = hunk.newCount;
    hunks.push(hunk);
  }
  return hunks;
}

/** The file's content as of `hash`, or undefined if it didn't exist there. */
export async function showFile(root: string, hash: string, relPath: string): Promise<string | undefined> {
  try { return await run(root, ['show', `${hash}:${gitPath(relPath)}`]); }
  catch { return undefined; }
}

/** Line diff from `a` to `b`; hunk "old" side refers to `a`. Line endings are normalised to LF. */
export async function diffTexts(a: string, b: string): Promise<Hunk[]> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ohmg-'));
  try {
    const fa = path.join(dir, 'a'), fb = path.join(dir, 'b');
    await Promise.all([fs.writeFile(fa, a.replace(/\r\n/g, '\n')), fs.writeFile(fb, b.replace(/\r\n/g, '\n'))]);
    const out = await run(dir, ['diff', '--no-index', '--no-color', '--no-ext-diff', '--text', '-U3', 'a', 'b'], [1]);
    return parseHunks(out);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

/** Hash of the commit that last changed `line` (1-based) in the committed file, if any. */
export async function blameLine(root: string, relPath: string, line: number): Promise<string | undefined> {
  try {
    const out = await run(root, ['blame', '--porcelain', '-L', `${line},${line}`, '--', gitPath(relPath)]);
    const hash = out.slice(0, 40);
    return /^0+$/.test(hash) ? undefined : hash;
  } catch {
    return undefined;
  }
}

/** Web URL of `hash` on the repo's hosting service (GitHub, GitLab, Bitbucket, Azure DevOps), if recognisable. */
export async function commitWebUrl(root: string, hash: string): Promise<string | undefined> {
  let remote: string;
  try {
    const remotes = (await run(root, ['remote'])).split('\n').filter(Boolean);
    const name = remotes.includes('origin') ? 'origin' : remotes[0];
    if (!name) return undefined;
    remote = (await run(root, ['remote', 'get-url', name])).trim();
  } catch {
    return undefined;
  }
  // Normalise ssh (git@host:path, ssh://git@host/path) and https forms to host + path.
  const m = /^(?:[a-z+]+:\/\/)?(?:[^@/]+@)?([^/:]+)(?::\d+)?[:/](.+?)(?:\.git)?\/?$/i.exec(remote);
  if (!m) return undefined;
  const host = m[1].toLowerCase();
  const repoPath = m[2];
  if (host === 'ssh.dev.azure.com') {
    const [, org, project, repo] = repoPath.split('/');
    return `https://dev.azure.com/${org}/${project}/_git/${repo}/commit/${hash}`;
  }
  if (host === 'vs-ssh.visualstudio.com') {
    const [, org, project, repo] = repoPath.split('/');
    return `https://${org}.visualstudio.com/${project}/_git/${repo}/commit/${hash}`;
  }
  if (host === 'dev.azure.com' || host.endsWith('.visualstudio.com')) {
    return `https://${host}/${repoPath.replace(/^v3\//, '')}/commit/${hash}`;
  }
  if (host.includes('bitbucket')) return `https://${host}/${repoPath}/commits/${hash}`;
  if (host.includes('gitlab')) return `https://${host}/${repoPath}/-/commit/${hash}`;
  return `https://${host}/${repoPath}/commit/${hash}`;
}
