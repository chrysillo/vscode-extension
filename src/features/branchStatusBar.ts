import * as vscode from 'vscode';
import { currentRepo, onAnyGitChange } from '../git/api';
import { Feature } from './types';

export const branchStatusBar: Feature = {
  id: 'branchStatusBar',
  label: 'Git: branch in status bar',
  enabledSetting: 'git.branchStatusBar.enabled',
  activate({ git }) {
    const item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 1000);
    item.command = 'ohmg.git.copyBranchName';

    const render = () => {
      const branch = git && currentRepo(git)?.state.HEAD;
      if (!branch?.name) { item.hide(); return; }

      const pattern = vscode.workspace.getConfiguration('ohmg').get<string>('git.branchStatusBar.ticketPattern', '');
      let label = branch.name;
      if (pattern) {
        try {
          const m = branch.name.match(new RegExp(pattern));
          if (m?.[1]) label = `#${m[1]}`;
        } catch { /* invalid regex: show full name */ }
      }
      const sync = [
        branch.ahead ? `↑${branch.ahead}` : '',
        branch.behind ? `↓${branch.behind}` : '',
      ].filter(Boolean).join(' ');

      item.text = `$(git-branch) ${label}${sync ? ' ' + sync : ''}`;
      item.tooltip = `${branch.name}\nClick to copy branch name`;
      item.show();
    };

    render();
    return vscode.Disposable.from(
      item,
      git ? onAnyGitChange(git, render) : new vscode.Disposable(() => {}),
      vscode.workspace.onDidChangeConfiguration(e => {
        if (e.affectsConfiguration('ohmg.git.branchStatusBar')) render();
      }),
    );
  },
};
