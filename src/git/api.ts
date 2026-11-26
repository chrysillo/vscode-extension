import * as vscode from 'vscode';

// Minimal slice of the built-in git extension API (vscode.git, API v1).
export interface Branch { name?: string; ahead?: number; behind?: number; }
export interface Change { uri: vscode.Uri; }
export interface RepositoryState {
  HEAD: Branch | undefined;
  workingTreeChanges: Change[];
  indexChanges: Change[];
  untrackedChanges?: Change[];
  onDidChange: vscode.Event<void>;
}
export interface Repository { rootUri: vscode.Uri; state: RepositoryState; }
export interface GitAPI {
  repositories: Repository[];
  onDidOpenRepository: vscode.Event<Repository>;
  onDidCloseRepository: vscode.Event<Repository>;
}

export async function getGitApi(): Promise<GitAPI | undefined> {
  const ext = vscode.extensions.getExtension<{ getAPI(v: 1): GitAPI }>('vscode.git');
  if (!ext) return undefined;
  const exports = ext.isActive ? ext.exports : await ext.activate();
  return exports.getAPI(1);
}

/** Repo for the active editor, falling back to the first one. */
export function currentRepo(api: GitAPI): Repository | undefined {
  const uri = vscode.window.activeTextEditor?.document.uri;
  if (uri) {
    const match = api.repositories
      .filter(r => uri.fsPath.startsWith(r.rootUri.fsPath))
      .sort((a, b) => b.rootUri.fsPath.length - a.rootUri.fsPath.length)[0];
    if (match) return match;
  }
  return api.repositories[0];
}

/** Calls `fn` whenever any repo state changes, the active editor changes, or repos open/close. */
export function onAnyGitChange(api: GitAPI, fn: () => void): vscode.Disposable {
  const subs: vscode.Disposable[] = [];
  const watch = (r: Repository) => subs.push(r.state.onDidChange(fn));
  api.repositories.forEach(watch);
  subs.push(
    api.onDidOpenRepository(r => { watch(r); fn(); }),
    api.onDidCloseRepository(fn),
    vscode.window.onDidChangeActiveTextEditor(fn),
  );
  return vscode.Disposable.from(...subs);
}
