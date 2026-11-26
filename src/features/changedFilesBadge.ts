import * as vscode from 'vscode';
import { currentRepo, onAnyGitChange, Repository } from '../git/api';
import { Feature } from './types';

export function changedUris(repo: Repository): vscode.Uri[] {
  const s = repo.state;
  const all = [...s.indexChanges, ...s.workingTreeChanges, ...(s.untrackedChanges ?? [])];
  const seen = new Map<string, vscode.Uri>();
  for (const c of all) seen.set(c.uri.toString(), c.uri);
  return [...seen.values()];
}

export const changedFilesBadge: Feature = {
  id: 'changedFilesBadge',
  label: 'Git: changed files count',
  enabledSetting: 'git.changedFilesBadge.enabled',
  activate({ git }) {
    const item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 999);
    item.command = 'ohmg.git.openChangedFiles';

    const render = () => {
      const repo = git && currentRepo(git);
      const count = repo ? changedUris(repo).length : 0;
      if (!count) { item.hide(); return; }
      item.text = `$(diff) ${count}`;
      item.tooltip = `${count} changed file${count === 1 ? '' : 's'}. Click to open all`;
      item.show();
    };

    render();
    return vscode.Disposable.from(item, git ? onAnyGitChange(git, render) : new vscode.Disposable(() => {}));
  },
};
