import * as vscode from 'vscode';
import { features } from './features';
import { changedUris } from './features/changedFilesBadge';
import { openBlameTimeline } from './features/blameTimeline';
import { reinstallSelf } from './features/reinstallSelf';
import { FeatureContext } from './features/types';
import { currentRepo, getGitApi } from './git/api';
import { stashSelected } from './git/stashSelected';

const running = new Map<string, vscode.Disposable>();

function cfg() { return vscode.workspace.getConfiguration('ohmg'); }

function sync(ctx: FeatureContext) {
  for (const f of features) {
    const on = cfg().get<boolean>(f.enabledSetting, true);
    if (on && !running.has(f.id)) running.set(f.id, f.activate(ctx));
    if (!on && running.has(f.id)) { running.get(f.id)!.dispose(); running.delete(f.id); }
  }
}

export async function activate(extension: vscode.ExtensionContext) {
  const ctx: FeatureContext = { git: await getGitApi(), extension };

  extension.subscriptions.push(
    vscode.commands.registerCommand('ohmg.git.copyBranchName', async () => {
      const name = ctx.git && currentRepo(ctx.git)?.state.HEAD?.name;
      if (!name) return vscode.window.showWarningMessage('No git branch found.');
      await vscode.env.clipboard.writeText(name);
      vscode.window.setStatusBarMessage(`Copied ${name}`, 2000);
    }),

    vscode.commands.registerCommand('ohmg.git.openChangedFiles', async () => {
      const repo = ctx.git && currentRepo(ctx.git);
      const uris = repo ? changedUris(repo) : [];
      if (!uris.length) return vscode.window.showInformationMessage('No changed files.');
      for (const uri of uris) {
        try { await vscode.window.showTextDocument(uri, { preview: false, preserveFocus: true }); }
        catch { /* deleted or binary file */ }
      }
    }),

    vscode.commands.registerCommand('ohmg.git.stashSelected', (...args: unknown[]) => stashSelected(ctx.git, ...args)),

    vscode.commands.registerCommand('ohmg.git.blameTimeline', () => openBlameTimeline(ctx.git)),

    vscode.commands.registerCommand('ohmg.dev.reinstall', reinstallSelf),

    vscode.commands.registerCommand('ohmg.toggleFeature', async () => {
      const pick = await vscode.window.showQuickPick(
        features.map(f => ({
          label: f.label,
          description: cfg().get<boolean>(f.enabledSetting, true) ? 'on' : 'off',
          feature: f,
        })),
        { placeHolder: 'Toggle an OHMG feature' },
      );
      if (!pick) return;
      const key = pick.feature.enabledSetting;
      await cfg().update(key, !cfg().get<boolean>(key, true), vscode.ConfigurationTarget.Global);
    }),

    vscode.workspace.onDidChangeConfiguration(e => { if (e.affectsConfiguration('ohmg')) sync(ctx); }),
    { dispose: () => { running.forEach(d => d.dispose()); running.clear(); } },
  );

  sync(ctx);
}

export function deactivate() {}
