import * as vscode from 'vscode';
import { Feature } from './types';

interface MenuAction {
  icon: string;
  label: string;
  command: string;
}

// Add new entries here; each command must be registered and listed in package.json.
const actions: MenuAction[] = [
  { icon: 'sync', label: 'Rebuild & Reload OHMG', command: 'ohmg.dev.reinstall' },
];

function buildTooltip(): vscode.MarkdownString {
  const md = new vscode.MarkdownString('**OHMG**\n\n---\n\n', true);
  md.appendMarkdown(actions.map(a => `[$(${a.icon}) ${a.label}](command:${a.command})`).join('\n\n'));
  md.isTrusted = { enabledCommands: actions.map(a => a.command) };
  return md;
}

export const statusMenu: Feature = {
  id: 'statusMenu',
  label: 'Status bar menu',
  enabledSetting: 'statusMenu.enabled',
  activate() {
    const item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 1000);
    item.text = '$(tools)';
    item.tooltip = buildTooltip();
    item.command = 'ohmg.dev.reinstall';
    item.show();
    return item;
  },
};
