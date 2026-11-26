import { exec } from 'child_process';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';

function run(cmd: string, cwd: string): Promise<void> {
  return new Promise((resolve, reject) => {
    exec(cmd, { cwd, shell: process.env.SHELL || '/bin/zsh' }, (err, stdout, stderr) => {
      if (err) reject(new Error(`${cmd}\n${stderr || stdout || err.message}`));
      else resolve();
    });
  });
}

async function sourceFolder(): Promise<string | undefined> {
  const cfg = vscode.workspace.getConfiguration('ohmg');
  const saved = cfg.get<string>('dev.sourcePath', '');
  if (saved) return saved;

  const picked = await vscode.window.showOpenDialog({
    canSelectFolders: true, canSelectFiles: false,
    openLabel: 'Use as OHMG source folder',
  });
  if (!picked?.length) return;
  await cfg.update('dev.sourcePath', picked[0].fsPath, vscode.ConfigurationTarget.Global);
  return picked[0].fsPath;
}

export async function reinstallSelf() {
  const cwd = await sourceFolder();
  if (!cwd) return;
  const vsix = path.join(os.tmpdir(), 'ohmg-vscode-dev.vsix');

  try {
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: 'OHMG' },
      async progress => {
        progress.report({ message: 'Compiling…' });
        await run('npm run compile', cwd);
        progress.report({ message: 'Packaging…' });
        await run(`npx vsce package --allow-missing-repository --skip-license -o "${vsix}"`, cwd);
        progress.report({ message: 'Installing…' });
        await vscode.commands.executeCommand('workbench.extensions.installExtension', vscode.Uri.file(vsix));
      },
    );
  } catch (e) {
    const out = vscode.window.createOutputChannel('OHMG');
    out.appendLine(String(e instanceof Error ? e.message : e));
    out.show();
    return vscode.window.showErrorMessage('OHMG rebuild failed. See the OHMG output panel.');
  }

  await vscode.commands.executeCommand('workbench.action.reloadWindow');
}
