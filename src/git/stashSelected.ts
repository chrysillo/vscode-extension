import { execFile } from 'child_process';
import * as path from 'path';
import * as vscode from 'vscode';
import { GitAPI, Repository } from './api';

interface ResourceState { resourceUri: vscode.Uri; }

function repoFor(api: GitAPI, uri: vscode.Uri): Repository | undefined {
  return api.repositories
    .filter(r => uri.fsPath.startsWith(r.rootUri.fsPath + path.sep))
    .sort((a, b) => b.rootUri.fsPath.length - a.rootUri.fsPath.length)[0];
}

function git(cwd: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) =>
    execFile('git', args, { cwd }, (err, _out, stderr) => (err ? reject(new Error(stderr || err.message)) : resolve())));
}

/** SCM context menu handler: VS Code passes each selected item as its own argument. */
export async function stashSelected(api: GitAPI | undefined, ...args: unknown[]) {
  const seen = new Map<string, ResourceState>();
  for (const a of args.flat()) {
    const s = a as ResourceState | undefined;
    if (s?.resourceUri) seen.set(s.resourceUri.toString(), s);
  }
  const states = [...seen.values()];
  if (!api || !states.length) return vscode.window.showWarningMessage('No files selected.');

  // Keyed by root path: the git API hands out a new Repository object on every access.
  const byRepo = new Map<string, string[]>();
  for (const s of states) {
    const repo = repoFor(api, s.resourceUri);
    if (!repo) continue;
    const rel = path.relative(repo.rootUri.fsPath, s.resourceUri.fsPath);
    const root = repo.rootUri.fsPath;
    byRepo.set(root, [...(byRepo.get(root) ?? []), rel]);
  }
  if (!byRepo.size) return vscode.window.showWarningMessage('Selected files are not in a git repository.');

  const now = new Date();
  const day = now.toLocaleDateString('en-US', { weekday: 'short' }).toUpperCase();
  const time = now.toTimeString().slice(0, 8);
  const message = `${day} ${time}`;

  for (const [root, files] of byRepo) {
    const args = ['stash', 'push', '--include-untracked', '-m', message];
    try {
      await git(root, [...args, '--', ...new Set(files)]);
    } catch (e) {
      return vscode.window.showErrorMessage(`Stash failed: ${(e as Error).message}`);
    }
  }
  const n = states.length;
  vscode.window.setStatusBarMessage(`Stashed ${n} file${n === 1 ? '' : 's'} as "${message}"`, 3000);
}
