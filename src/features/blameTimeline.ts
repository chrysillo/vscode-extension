/**
 * File history panel (Cmd/Ctrl+Shift+Y): a timeline of the commits that touched the active
 * file, with two views of the selected commit:
 *  - "Compare to current": the live document diffed against the file as of that commit. Lines,
 *    blocks or the whole file can be restored from it, staging-style, as unsaved (undoable) edits.
 *  - "Changes in commit": the full message, the commit's diff for this file, and every other
 *    file it touched (each opens in its own history tab on the same commit). Read-only.
 */
import * as path from 'path';
import * as vscode from 'vscode';
import { GitAPI } from '../git/api';
import { applyHunk, Picks, restoreEdits } from '../git/patch';
import { blameLine, Commit, CommitFile, commitFiles, commitWebUrl, diffTexts, fileHistory, Hunk, showFile } from '../git/history';

type Msg =
  | { type: 'compare'; commit: number }
  | { type: 'files'; commit: number }
  | { type: 'openFile'; commit: number; file: number }
  | { type: 'copyHash'; commit: number }
  | { type: 'openCommit'; commit: number }
  | { type: 'restore'; commit: number; hunk?: number; lines?: number[] }
  | { type: 'listWidth'; width: number; commit?: undefined };

interface Target {
  uri: vscode.Uri;
  root: string;
  rel: string;
  commits: Commit[];
  /** Files changed per commit, loaded on demand. */
  files: Map<number, CommitFile[]>;
  /** Diff from the current document to the commit's version of the file. */
  compare?: { commit: number; version: number; hunks: Hunk[] };
}

/** Every open history tab; the shortcut reuses the most recently focused one. */
const panels = new Set<HistoryPanel>();
let lastActive: HistoryPanel | undefined;
/** Timeline width in px, shared by all history tabs this session. */
let listWidth: number | undefined;

/** Shortcut / command: history of the active editor's file, in the last used history tab. */
export async function openBlameTimeline(api: GitAPI | undefined) {
  const editor = vscode.window.activeTextEditor;
  if (!api || !editor || editor.document.uri.scheme !== 'file') {
    return vscode.window.showWarningMessage('Open a file in a git repository first.');
  }
  const uri = editor.document.uri;
  const repo = api.repositories
    .filter(r => uri.fsPath.startsWith(r.rootUri.fsPath + path.sep))
    .sort((a, b) => b.rootUri.fsPath.length - a.rootUri.fsPath.length)[0];
  if (!repo) return vscode.window.showWarningMessage('This file is not in a git repository.');

  const root = repo.rootUri.fsPath;
  const rel = path.relative(root, uri.fsPath);
  const owner = await blameLine(root, rel, editor.selection.active.line + 1);
  const p = lastActive ?? new HistoryPanel(api);
  await p.load(uri, root, rel, owner);
}

/** One history tab. Several can be open, each on its own file. */
class HistoryPanel {
  private readonly panel: vscode.WebviewPanel;
  private target: Target | undefined;
  private refreshTimer: NodeJS.Timeout | undefined;

  constructor(private readonly git: GitAPI) {
    this.panel = vscode.window.createWebviewPanel('ohmg.blameTimeline', 'History', vscode.ViewColumn.Active, {
      enableScripts: true,
      retainContextWhenHidden: true,
    });
    panels.add(this);
    lastActive = this;
    const docSub = vscode.workspace.onDidChangeTextDocument(e => {
      const t = this.target;
      if (!t?.compare || !this.panel.visible || e.document.uri.toString() !== t.uri.toString()) return;
      clearTimeout(this.refreshTimer);
      this.refreshTimer = setTimeout(() => t.compare && this.sendCompare(t.compare.commit), 300);
    });
    this.panel.onDidDispose(() => {
      docSub.dispose();
      clearTimeout(this.refreshTimer);
      panels.delete(this);
      if (lastActive === this) lastActive = [...panels].pop();
    });
    this.panel.onDidChangeViewState(e => {
      if (e.webviewPanel.active) lastActive = this;
      if (e.webviewPanel.visible && this.target?.compare) this.sendCompare(this.target.compare.commit);
    });
    this.panel.webview.onDidReceiveMessage((m: Msg) => this.onMessage(m));
    this.panel.webview.html = html(this.panel.webview);
  }

  /** Shows the history of `rel`, starting on commit `selectHash` when it's in the list. */
  async load(uri: vscode.Uri, root: string, rel: string, selectHash?: string) {
    const commits = await fileHistory(root, rel).catch(e => {
      vscode.window.showErrorMessage(`git log failed: ${e.message}`);
      return [] as Commit[];
    });
    if (!commits.length) {
      vscode.window.showInformationMessage(`No committed history for ${path.basename(rel)}.`);
      if (!this.target) this.panel.dispose();
      return;
    }
    this.target = { uri, root, rel, commits, files: new Map() };
    this.panel.title = `History: ${path.basename(rel)}`;
    this.panel.reveal();
    this.panel.webview.postMessage({ type: 'load', commits, owner: selectHash, listWidth, file: rel.split(path.sep).join('/') });
  }

  private async onMessage(m: Msg) {
    if (m.type === 'listWidth') { listWidth = m.width; return; }
    const t = this.target;
    const c = t?.commits[m.commit];
    if (!t || !c) return;
    switch (m.type) {
      case 'compare': return this.sendCompare(m.commit);
      case 'restore': return this.restore(m.commit, m.hunk, m.lines);
      case 'files': return this.sendFiles(m.commit);
      case 'openFile': return this.openCommitFile(m.commit, m.file);
      case 'copyHash':
        await vscode.env.clipboard.writeText(c.hash);
        return vscode.window.setStatusBarMessage(`Copied ${c.hash.slice(0, 10)}`, 2000);
      case 'openCommit': {
        const url = await commitWebUrl(t.root, c.hash);
        if (!url) return vscode.window.showWarningMessage('No recognisable remote to open this commit on.');
        return vscode.env.openExternal(vscode.Uri.parse(url));
      }
    }
  }

  private async sendFiles(commit: number) {
    const t = this.target!;
    const c = t.commits[commit];
    let files = t.files.get(commit);
    if (!files) {
      try { files = await commitFiles(t.root, c.hash); }
      catch (e) { vscode.window.showErrorMessage(`Could not list files of ${c.hash.slice(0, 7)}: ${(e as Error).message}`); return; }
      t.files.set(commit, files);
    }
    if (t === this.target) this.panel.webview.postMessage({ type: 'files', commit, files, self: c.path || t.rel.split(path.sep).join('/') });
  }

  /** Opens another file of the commit in a new history tab, on the same commit. */
  private async openCommitFile(commit: number, index: number) {
    const t = this.target!;
    const c = t.commits[commit];
    const f = t.files.get(commit)?.[index];
    if (!f) return;
    const rel = f.path.split('/').join(path.sep);
    await new HistoryPanel(this.git).load(vscode.Uri.file(path.join(t.root, rel)), t.root, rel, c.hash);
  }

  /** The commit's version of the file ('' if the file didn't exist in it). */
  private async committedText(t: Target, commit: number) {
    const c = t.commits[commit];
    return (await showFile(t.root, c.hash, c.path || t.rel)) ?? '';
  }

  private async sendCompare(commit: number): Promise<Target['compare']> {
    const t = this.target;
    if (!t || !t.commits[commit]) return;
    let doc: vscode.TextDocument;
    try {
      doc = await vscode.workspace.openTextDocument(t.uri);
    } catch {
      this.panel.webview.postMessage({ type: 'compare', commit, hunks: [], missing: true });
      return;
    }
    const version = doc.version;
    let hunks: Hunk[];
    try {
      hunks = await diffTexts(doc.getText(), await this.committedText(t, commit));
    } catch (e) {
      vscode.window.showErrorMessage(`Could not compare with ${t.commits[commit].hash.slice(0, 7)}: ${(e as Error).message}`);
      return;
    }
    if (t !== this.target) return;
    t.compare = { commit, version, hunks };
    this.panel.webview.postMessage({ type: 'compare', commit, hunks });
    return t.compare;
  }

  /** Applies picked lines of the current-vs-commit diff the user is looking at (all of it if `hunk` is omitted). */
  private async restore(commit: number, hunk: number | undefined, lines?: number[]) {
    const t = this.target!;
    const c = t.commits[commit];
    const cmp = t.compare;
    if (!cmp || cmp.commit !== commit || !cmp.hunks[hunk ?? 0]) return;
    const picks: Picks = hunk === undefined
      ? new Map(cmp.hunks.map((_, i) => [i, undefined]))
      : new Map([[hunk, lines ? new Set(lines) : undefined]]);
    const doc = await vscode.workspace.openTextDocument(t.uri);
    if (doc.version !== cmp.version) {
      vscode.window.showWarningMessage('The file changed; check the updated comparison and try again.');
      return this.sendCompare(commit);
    }

    if (hunk === undefined) {
      const items = [...picks].flatMap(([i, pick]) => applyHunk(cmp.hunks[i], pick).changes);
      const del = items.filter(i => i.kind === '-').length, add = items.length - del;
      const ok = await vscode.window.showWarningMessage(
        `Restore the whole file to ${c.hash.slice(0, 7)}? This removes ${del} line(s) and adds ${add} line(s) in the current file.`,
        { modal: true }, 'Restore');
      if (ok !== 'Restore' || doc.version !== cmp.version) return;
    }

    const eol = doc.eol === vscode.EndOfLine.CRLF ? '\r\n' : '\n';
    const edit = new vscode.WorkspaceEdit();
    for (const e of restoreEdits(cmp.hunks, picks)) {
      edit.replace(doc.uri, new vscode.Range(e.start, 0, e.start + e.count, 0), e.lines.map(l => l + eol).join(''));
    }
    await vscode.workspace.applyEdit(edit);
    await this.sendCompare(commit);
  }
}

function html(webview: vscode.Webview): string {
  const nonce = Math.random().toString(36).slice(2) + Date.now().toString(36);
  return `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
<style>
  body { margin: 0; padding: 0; font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); color: var(--vscode-foreground); }
  .wrap { display: grid; grid-template-columns: var(--list-w, 32%) 5px 1fr; height: 100vh; }
  #list { overflow-y: auto; min-width: 0; }
  #split { cursor: col-resize; border-left: 1px solid var(--vscode-panel-border); }
  #split:hover, #split.drag { background: var(--vscode-sash-hoverBorder, var(--vscode-focusBorder)); }
  #detail { min-width: 0; }
  #detail { overflow-y: auto; padding: 12px 16px; }
  .item { position: relative; padding: 8px 12px 8px 26px; cursor: pointer; border-bottom: 1px solid var(--vscode-panel-border); }
  .item::before { content: ''; position: absolute; left: 11px; top: 0; bottom: 0; width: 2px; background: var(--vscode-panel-border); }
  .dot { position: absolute; left: 7px; top: 13px; width: 10px; height: 10px; border-radius: 50%; background: var(--vscode-editor-background); border: 2px solid var(--c); box-sizing: border-box; }
  .dot.filled { background: var(--c); }
  .dot.s0 { --c: var(--vscode-descriptionForeground); }
  .dot.s1 { --c: var(--vscode-charts-yellow, #cca700); }
  .dot.s2 { --c: var(--vscode-charts-red, #f14c4c); }
  .item:hover { background: var(--vscode-list-hoverBackground); }
  .item.sel { background: var(--vscode-list-activeSelectionBackground); color: var(--vscode-list-activeSelectionForeground); }
  .subj { font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .meta { opacity: .75; font-size: .9em; margin-top: 2px; }
  .who { display: flex; align-items: center; gap: 6px; margin-top: 4px; font-size: .92em; min-width: 0; }
  .who.big { font-size: 1em; margin: 6px 0 2px; }
  .who .name { font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .avatar { flex: none; display: inline-flex; align-items: center; justify-content: center; width: 18px; height: 18px; border-radius: 50%; color: #fff; }
  .who.big .avatar { width: 24px; height: 24px; }
  .who.big .avatar svg { width: 15px; height: 15px; }
  .hash { flex: none; font-family: var(--vscode-editor-font-family); font-size: .9em; padding: 0 5px; border-radius: 3px; cursor: copy; background: var(--vscode-textCodeBlock-background, rgba(128,128,128,.15)); }
  .short { flex: none; opacity: .6; font-family: var(--vscode-editor-font-family); font-size: .9em; }
  .hash:hover { outline: 1px solid var(--vscode-focusBorder); }
  .hash.copied::after { content: ' ✓ copied'; color: var(--vscode-charts-green); }
  button.link { background: none; color: var(--vscode-textLink-foreground); padding: 0 4px; }
  button.link:hover { background: none; text-decoration: underline; }
  h2 { margin: 0 0 4px; font-size: 1.15em; }
  .tabs { display: flex; gap: 2px; margin: 12px 0 4px; border-bottom: 1px solid var(--vscode-panel-border); align-items: center; }
  .tab { padding: 6px 12px; cursor: pointer; border-bottom: 2px solid transparent; opacity: .75; margin-bottom: -1px; }
  .tab.on { opacity: 1; border-bottom-color: var(--vscode-focusBorder); }
  .tabs .spacer { flex: 1; }
  .legend { font-family: var(--vscode-editor-font-family); font-size: .85em; margin-right: 6px; }
  .legend span { padding: 0 4px; border-radius: 2px; }
  .ln { display: inline-block; width: 4ch; margin-right: 8px; text-align: right; opacity: .5; }
  .hunk { margin: 14px 0; border: 1px solid var(--vscode-panel-border); border-radius: 4px; overflow: hidden; }
  .hhead { display: flex; align-items: center; gap: 8px; padding: 4px 8px; background: var(--vscode-sideBarSectionHeader-background); font-family: var(--vscode-editor-font-family); font-size: .9em; }
  .hhead span { flex: 1; opacity: .8; }
  button { font: inherit; font-size: .9em; padding: 2px 8px; border: none; border-radius: 2px; cursor: pointer; color: var(--vscode-button-foreground); background: var(--vscode-button-background); }
  button:hover { background: var(--vscode-button-hoverBackground); }
  button.sec { color: var(--vscode-button-secondaryForeground); background: var(--vscode-button-secondaryBackground); }
  button.sec:hover { background: var(--vscode-button-secondaryHoverBackground); }
  pre { margin: 0; font-family: var(--vscode-editor-font-family); font-size: var(--vscode-editor-font-size); overflow-x: auto; user-select: none; }
  .l { display: block; padding: 0 8px; white-space: pre; border-left: 3px solid transparent; }
  .add { background: var(--vscode-diffEditor-insertedLineBackground, rgba(0,160,0,.18)); }
  .del { background: var(--vscode-diffEditor-removedLineBackground, rgba(220,0,0,.18)); }
  .pickable .add, .pickable .del { cursor: pointer; }
  .l.picked { border-left-color: var(--vscode-focusBorder); filter: brightness(1.35); }
  .body { white-space: pre-wrap; margin: 10px 0 0; padding: 8px 10px; border-left: 3px solid var(--vscode-panel-border); opacity: .9; }
  .section { margin: 16px 0 6px; font-weight: 600; font-size: .85em; text-transform: uppercase; letter-spacing: .04em; opacity: .8; }
  .count { font-weight: 400; opacity: .7; margin-left: 4px; }
  .files { border: 1px solid var(--vscode-panel-border); border-radius: 4px; overflow: hidden; }
  .file { display: flex; align-items: center; gap: 8px; padding: 3px 8px; white-space: nowrap; }
  .file[data-file] { cursor: pointer; }
  .file[data-file]:hover { background: var(--vscode-list-hoverBackground); }
  .file.self { background: var(--vscode-list-inactiveSelectionBackground); }
  .st { flex: none; width: 1.2em; text-align: center; font-family: var(--vscode-editor-font-family); font-weight: 700; }
  .st-A { color: var(--vscode-gitDecoration-addedResourceForeground, #73c991); }
  .st-M, .st-T { color: var(--vscode-gitDecoration-modifiedResourceForeground, #e2c08d); }
  .st-D { color: var(--vscode-gitDecoration-deletedResourceForeground, #c74e39); }
  .st-R, .st-C { color: var(--vscode-gitDecoration-renamedResourceForeground, #73c991); }
  .fname { flex: none; }
  .dir { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; opacity: .6; font-size: .9em; }
  .this { flex: none; font-size: .8em; padding: 0 5px; border-radius: 3px; background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); }
  .counts { flex: none; font-family: var(--vscode-editor-font-family); font-size: .9em; display: flex; gap: 6px; }
  .plus { color: var(--vscode-gitDecoration-addedResourceForeground, #73c991); }
  .minus { color: var(--vscode-gitDecoration-deletedResourceForeground, #c74e39); }
  .bin { opacity: .6; }
  .empty { opacity: .7; padding: 20px 0; }
</style></head><body>
<div class="wrap"><div id="list"></div><div id="split" title="Drag to resize, double-click to reset"></div><div id="detail"><div class="empty">Loading…</div></div></div>
<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  const list = document.getElementById('list'), detail = document.getElementById('detail');
  let commits = [], owner, sel = 0, tab = 'compare', compare = null, picked = new Map(), anchor = null, files = null;
  const esc = s => s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const when = t => {
    const d = (Date.now() - t) / 1000;
    const rel = d < 3600 ? Math.round(d / 60) + 'm' : d < 86400 ? Math.round(d / 3600) + 'h' : d < 86400 * 60 ? Math.round(d / 86400) + 'd' : Math.round(d / 86400 / 30) + 'mo';
    return new Date(t).toLocaleString() + ' · ' + rel + ' ago';
  };
  const lineCls = l => l[0] === '+' ? 'add' : l[0] === '-' ? 'del' : '';

  const personSvg = '<svg viewBox="0 0 16 16" width="12" height="12" fill="currentColor" aria-hidden="true"><circle cx="8" cy="5" r="3"/><path d="M2 14.5c0-3 2.7-5 6-5s6 2 6 5V15H2z"/></svg>';
  function avatar(name) {
    let h = 0;
    for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
    return '<span class="avatar" style="background:hsl(' + (h % 360) + ' 55% 42%)" title="' + esc(name) + '">' + personSvg + '</span>';
  }
  function hashChip(c, i, n) {
    return '<span class="hash" data-copy="' + i + '" title="Click to copy ' + c.hash + '">' + c.hash.slice(0, n) + '</span>';
  }

  /**
   * Per commit: how big its change to this file was (0 small, 1 medium, 2 large, relative to the
   * file's own history) and whether it is a milestone (created or renamed the file).
   */
  let dots = [];
  function computeDots(file) {
    const size = commits.map(c => c.hunks.reduce((n, h) => n + h.lines.filter(l => l[0] !== ' ').length, 0));
    const sorted = size.filter(Boolean).sort((a, b) => a - b);
    const at = q => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? 0;
    // Few commits give meaningless percentiles, so fall back to fixed line counts.
    const [mid, big] = sorted.length >= 5 ? [Math.max(at(0.5), 3), Math.max(at(0.85), 10)] : [10, 50];
    // A pure rename has no diff (path ''), so carry the newer commit's path down.
    const paths = [];
    commits.forEach((c, i) => { paths[i] = c.path || (i ? paths[i - 1] : file); });
    dots = commits.map((c, i) => {
      const created = c.hunks.length > 0 && c.hunks.every(h => h.oldStart === 0 && h.oldCount === 0);
      const renamedFrom = i + 1 < commits.length && paths[i + 1] !== paths[i] ? paths[i + 1] : '';
      const added = c.hunks.reduce((n, h) => n + h.lines.filter(l => l[0] === '+').length, 0);
      const tip = ['+' + added + ' −' + (size[i] - added) + ' in this file'];
      if (created) tip.push('file created');
      if (renamedFrom) tip.push('renamed from ' + renamedFrom);
      return { s: size[i] > big ? 2 : size[i] > mid ? 1 : 0, filled: created || !!renamedFrom, tip: tip.join(' · ') };
    });
  }

  function renderList() {
    list.innerHTML = commits.map((c, i) =>
      '<div class="item' + (i === sel ? ' sel' : '') + '" data-i="' + i + '">' +
      '<span class="dot s' + dots[i].s + (dots[i].filled ? ' filled' : '') + '" title="' + esc(dots[i].tip) + '"></span>' +
      '<div class="subj">' + esc(c.subject) + '</div>' +
      '<div class="who">' + avatar(c.author) + '<span class="name">' + esc(c.author) + '</span><span class="short">' + c.hash.slice(0, 7) + '</span></div>' +
      '<div class="meta">' + when(c.date) + '</div></div>').join('');
  }

  const statusName = { A: 'added', M: 'modified', D: 'deleted', R: 'renamed', C: 'copied', T: 'type changed' };
  function renderFiles() {
    if (!files || files.commit !== sel) return '<div class="section">Files in this commit</div><div class="empty">Loading…</div>';
    return '<div class="section">Files in this commit <span class="count">' + files.files.length + '</span></div><div class="files">' +
      files.files.map((f, i) => {
        const slash = f.path.lastIndexOf('/');
        const dir = slash < 0 ? '' : f.path.slice(0, slash + 1), base = f.path.slice(slash + 1);
        const counts = f.added === undefined ? '<span class="bin">binary</span>' :
          (f.added ? '<span class="plus">+' + f.added + '</span>' : '') + (f.removed ? '<span class="minus">−' + f.removed + '</span>' : '');
        return '<div class="file' + (f.path === files.self ? ' self' : '') + '"' + (f.path === files.self ? '' : ' data-file="' + i + '" title="Open history of ' + esc(f.path) + ' at this commit"') + '>' +
          '<span class="st st-' + f.status + '" title="' + (statusName[f.status] || f.status) + '">' + f.status + '</span>' +
          '<span class="fname">' + esc(base) + '</span><span class="dir">' + esc(f.oldPath ? f.oldPath + ' → ' + dir : dir) + '</span>' +
          (f.path === files.self ? '<span class="this">this file</span>' : '') +
          '<span class="counts">' + counts + '</span></div>';
      }).join('') + '</div>';
  }

  function renderChanges(c) {
    const msg = c.body ? '<div class="body">' + esc(c.body) + '</div>' : '';
    return msg + '<div class="section">Changes to this file</div>' + renderHunks(c) + renderFiles();
  }

  function renderHunks(c) {
    if (!c.hunks.length) return '<div class="empty">No text changes to this file in this commit.</div>';
    return c.hunks.map(h =>
      '<div class="hunk"><div class="hhead"><span>' + esc(h.header) + '</span></div><pre>' +
      h.lines.map(l => '<span class="l ' + lineCls(l) + '">' + esc(l) + '</span>').join('') + '</pre></div>').join('');
  }

  function renderCompare() {
    if (!compare || compare.commit !== sel) return '<div class="empty">Comparing…</div>';
    if (compare.missing) return '<div class="empty">This file no longer exists in your working tree.</div>';
    if (!compare.hunks.length) return '<div class="empty">The current file is the same as this commit.</div>';
    return compare.hunks.map((h, j) => {
      const p = picked.get(j);
      let cur = h.oldCount === 0 ? h.oldStart + 1 : h.oldStart;
      return '<div class="hunk pickable"><div class="hhead"><span>' + esc(h.header) + '</span>' +
        (p && p.size ? '<button class="sec" data-act="clear" data-h="' + j + '">Clear</button>' +
          '<button data-act="lines" data-h="' + j + '">Restore ' + p.size + ' selected</button>' : '') +
        '<button class="sec" data-act="hunk" data-h="' + j + '">Restore block</button></div><pre>' +
        h.lines.map((l, k) => {
          const n = l[0] === '+' ? '' : String(cur++);
          return '<span class="l ' + lineCls(l) + (p && p.has(k) ? ' picked' : '') + '" data-h="' + j + '" data-k="' + k + '"><span class="ln">' + n + '</span>' + esc(l) + '</span>';
        }).join('') + '</pre></div>';
    }).join('');
  }

  function renderDetail() {
    const c = commits[sel];
    if (!c) { detail.innerHTML = '<div class="empty">No commit selected.</div>'; return; }
    const tabBtn = (id, label) => '<div class="tab' + (tab === id ? ' on' : '') + '" data-tab="' + id + '">' + label + '</div>';
    const hasDiff = compare && compare.commit === sel && compare.hunks.length;
    detail.innerHTML = '<h2>' + esc(c.subject) + '</h2>' +
      '<div class="who big">' + avatar(c.author) + '<span class="name">' + esc(c.author) + '</span>' + hashChip(c, sel, 10) +
      '<button class="link" data-act="open" title="Open this commit on the server">Open on server ↗</button></div>' +
      '<div class="meta">' + when(c.date) + (c.path ? ' · ' + esc(c.path) : '') + '</div>' +
      '<div class="tabs">' + tabBtn('compare', 'Compare to current') + tabBtn('changes', 'Changes in commit') + '<div class="spacer"></div>' +
      (tab === 'compare' ? '<span class="legend"><span class="del">- current</span> <span class="add">+ this commit</span></span>' : '') +
      (tab === 'compare' && hasDiff ? '<button class="sec" data-act="all">Restore whole file</button>' : '') + '</div>' +
      (tab === 'compare' ? renderCompare() : renderChanges(c));
  }

  function requestFiles() {
    if (tab === 'changes' && (!files || files.commit !== sel)) vscode.postMessage({ type: 'files', commit: sel });
  }

  function select(i) {
    const next = Math.max(0, Math.min(commits.length - 1, i));
    if (next !== sel) { picked = new Map(); anchor = null; }
    sel = next;
    renderList(); renderDetail();
    vscode.postMessage({ type: 'compare', commit: sel });
    requestFiles();
    list.querySelector('.sel')?.scrollIntoView({ block: 'nearest' });
  }

  document.addEventListener('click', e => {
    const h = e.target.closest('[data-copy]');
    if (!h) return;
    e.stopPropagation();
    vscode.postMessage({ type: 'copyHash', commit: +h.dataset.copy });
    h.classList.add('copied'); setTimeout(() => h.classList.remove('copied'), 900);
  }, true);
  list.addEventListener('click', e => { const it = e.target.closest('.item'); if (it) select(+it.dataset.i); });
  detail.addEventListener('click', e => {
    const t = e.target.closest('[data-tab]');
    if (t) { tab = t.dataset.tab; renderDetail(); if (tab === 'changes') requestFiles(); return; }
    const f = e.target.closest('[data-file]');
    if (f) { vscode.postMessage({ type: 'openFile', commit: sel, file: +f.dataset.file }); return; }
    const b = e.target.closest('button[data-act]');
    if (b) {
      const h = +b.dataset.h;
      if (b.dataset.act === 'open') vscode.postMessage({ type: 'openCommit', commit: sel });
      if (b.dataset.act === 'all') vscode.postMessage({ type: 'restore', commit: sel });
      if (b.dataset.act === 'hunk') vscode.postMessage({ type: 'restore', commit: sel, hunk: h });
      if (b.dataset.act === 'lines') vscode.postMessage({ type: 'restore', commit: sel, hunk: h, lines: [...picked.get(h)] });
      if (b.dataset.act === 'clear') { picked.delete(h); renderDetail(); }
      return;
    }
    const l = e.target.closest('.pickable .l.add, .pickable .l.del');
    if (!l) return;
    const h = +l.dataset.h, k = +l.dataset.k;
    const set = picked.get(h) ?? new Set();
    if (e.shiftKey && anchor && anchor.h === h) {
      const lines = compare.hunks[h].lines;
      for (let i = Math.min(anchor.k, k); i <= Math.max(anchor.k, k); i++) if (lines[i][0] !== ' ') set.add(i);
    } else {
      set.has(k) ? set.delete(k) : set.add(k);
      anchor = { h, k };
    }
    picked.set(h, set);
    renderDetail();
  });
  document.addEventListener('keydown', e => {
    if (e.key === 'ArrowDown' || e.key === 'j') { select(sel + 1); e.preventDefault(); }
    if (e.key === 'ArrowUp' || e.key === 'k') { select(sel - 1); e.preventDefault(); }
  });
  const wrap = document.querySelector('.wrap'), split = document.getElementById('split');
  const setListWidth = w => wrap.style.setProperty('--list-w', w ? Math.round(w) + 'px' : '');
  split.addEventListener('pointerdown', e => {
    e.preventDefault();
    split.setPointerCapture(e.pointerId);
    split.classList.add('drag');
    const move = ev => setListWidth(Math.max(160, Math.min(window.innerWidth - 280, ev.clientX)));
    const up = () => {
      split.removeEventListener('pointermove', move);
      split.removeEventListener('pointerup', up);
      split.classList.remove('drag');
      vscode.postMessage({ type: 'listWidth', width: list.getBoundingClientRect().width });
    };
    split.addEventListener('pointermove', move);
    split.addEventListener('pointerup', up);
  });
  split.addEventListener('dblclick', () => { setListWidth(0); vscode.postMessage({ type: 'listWidth', width: 0 }); });

  window.addEventListener('message', ({ data }) => {
    if (data.type === 'load') {
      if (data.listWidth) setListWidth(data.listWidth);
      commits = data.commits; owner = data.owner; compare = null; files = null;
      computeDots(data.file);
      const o = commits.findIndex(c => c.hash === owner);
      sel = -1; select(o < 0 ? 0 : o);
    }
    if (data.type === 'files' && data.commit === sel) { files = data; if (tab === 'changes') renderDetail(); }
    if (data.type === 'compare' && data.commit === sel) {
      const same = compare && compare.commit === data.commit && JSON.stringify(compare.hunks) === JSON.stringify(data.hunks);
      compare = data;
      if (!same) { picked = new Map(); anchor = null; }
      renderDetail();
    }
  });
</script></body></html>`;
}
