import * as path from 'path';
import * as vscode from 'vscode';
import { GitAPI } from '../git/api';
import { blameLine, Commit, diffTexts, fileHistory, Hunk, newSidePositions, showFile } from '../git/history';

type Msg =
  | { type: 'compare'; commit: number }
  | { type: 'restore'; commit: number; hunk?: number; lines?: number[] };

interface Target {
  uri: vscode.Uri;
  root: string;
  rel: string;
  commits: Commit[];
  /** Diff from the current document to the commit's version of the file. */
  compare?: { commit: number; version: number; hunks: Hunk[] };
}

let panel: vscode.WebviewPanel | undefined;
let target: Target | undefined;
let refreshTimer: NodeJS.Timeout | undefined;

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
  const [commits, owner] = await Promise.all([
    fileHistory(root, rel).catch(e => { vscode.window.showErrorMessage(`git log failed: ${e.message}`); return []; }),
    blameLine(root, rel, editor.selection.active.line + 1),
  ]);
  if (!commits.length) return vscode.window.showInformationMessage('No committed history for this file.');
  target = { uri, root, rel, commits };

  if (!panel) {
    panel = vscode.window.createWebviewPanel('ohmg.blameTimeline', '', vscode.ViewColumn.Active, {
      enableScripts: true,
      retainContextWhenHidden: true,
    });
    const docSub = vscode.workspace.onDidChangeTextDocument(e => {
      if (!target?.compare || !panel?.visible || e.document.uri.toString() !== target.uri.toString()) return;
      clearTimeout(refreshTimer);
      refreshTimer = setTimeout(() => target?.compare && sendCompare(target.compare.commit), 300);
    });
    panel.onDidDispose(() => { docSub.dispose(); clearTimeout(refreshTimer); panel = undefined; target = undefined; });
    panel.onDidChangeViewState(e => { if (e.webviewPanel.visible && target?.compare) sendCompare(target.compare.commit); });
    panel.webview.onDidReceiveMessage(onMessage);
    panel.webview.html = html(panel.webview);
  } else {
    panel.reveal(vscode.ViewColumn.Active);
  }
  panel.title = `History: ${path.basename(uri.fsPath)}`;
  panel.webview.postMessage({ type: 'load', file: rel, commits, owner });
}

async function onMessage(m: Msg) {
  if (m.type === 'compare') return sendCompare(m.commit);
  if (m.type === 'restore') return restore(m.commit, m.hunk, m.lines);
}

/** The compared commit's version of the file ('' if the file didn't exist in it). */
async function committedText(t: Target, commit: number) {
  const c = t.commits[commit];
  return (await showFile(t.root, c.hash, c.path || t.rel)) ?? '';
}

async function sendCompare(commit: number): Promise<Target['compare']> {
  const t = target;
  if (!t || !t.commits[commit]) return;
  const doc = await vscode.workspace.openTextDocument(t.uri);
  const version = doc.version;
  const hunks = await diffTexts(doc.getText(), await committedText(t, commit));
  if (t !== target) return;
  t.compare = { commit, version, hunks };
  panel?.webview.postMessage({ type: 'compare', commit, pending: pendingLines(t.commits[commit], hunks), anyDiff: hunks.length > 0 });
  return t.compare;
}

/** Which changed lines in each of the commit's hunks still differ from the current file. */
function pendingLines(c: Commit, cmp: Hunk[]): boolean[][] {
  const diffAt = new Map<number, string[]>();
  for (const h of cmp) {
    const pos = newSidePositions(h);
    h.lines.forEach((l, j) => { if (l[0] !== ' ') diffAt.set(pos[j], [...(diffAt.get(pos[j]) ?? []), l]); });
  }
  return c.hunks.map(h => {
    const pos = newSidePositions(h);
    return h.lines.map((l, i) => {
      if (l[0] === ' ') return false;
      const here = diffAt.get(pos[i]) ?? [];
      // A line the commit added should exist now; a line it removed should be gone now.
      return l[0] === '+' ? here.some(d => d[0] === '+') : here.some(d => d === l);
    });
  });
}

/**
 * Brings the commit's version of the chosen lines back into the current document. The chosen
 * lines (all of hunk `hunk` if `lines` is omitted, the whole file if `hunk` is too) are lined
 * up with the current-vs-commit diff by their position in the commit's file, and the matching
 * parts of that diff are applied staging-style.
 */
async function restore(commit: number, hunk: number | undefined, lines?: number[]) {
  const t = target;
  const c = t?.commits[commit];
  if (!t || !c) return;
  const cmp = await sendCompare(commit);
  if (!cmp) return;

  const picks = new Map<number, Set<number> | undefined>();
  if (hunk === undefined) {
    cmp.hunks.forEach((_, i) => picks.set(i, undefined));
  } else {
    const h = c.hunks[hunk];
    if (!h) return;
    const pos = newSidePositions(h);
    const chosen = (lines ?? h.lines.map((_, i) => i)).map(i => pos[i]);
    let lo = Math.min(...chosen), hi = Math.max(...chosen);
    // Include the gaps around chosen lines so a current edit of the same line gets replaced.
    if (lo % 2 === 0) lo--;
    if (hi % 2 === 0) hi++;
    cmp.hunks.forEach((ch, i) => {
      const cpos = newSidePositions(ch);
      const set = new Set(ch.lines.flatMap((l, j) => (l[0] !== ' ' && cpos[j] >= lo && cpos[j] <= hi ? [j] : [])));
      if (set.size) picks.set(i, set);
    });
  }
  if (!picks.size) return vscode.window.setStatusBarMessage('Already matches the current file.', 2500);

  const doc = await vscode.workspace.openTextDocument(t.uri);
  const eol = doc.eol === vscode.EndOfLine.CRLF ? '\r\n' : '\n';
  const edit = new vscode.WorkspaceEdit();
  for (const [i, pick] of picks) {
    const h = cmp.hunks[i];
    const out: string[] = [];
    h.lines.forEach((l, j) => {
      const take = !pick || pick.has(j);
      if (l[0] === ' ' || (l[0] === '-' && !take) || (l[0] === '+' && take)) out.push(l.slice(1));
    });
    // With zero old lines git reports the line *after which* to insert.
    const start = h.oldCount === 0 ? h.oldStart : h.oldStart - 1;
    edit.replace(doc.uri, new vscode.Range(start, 0, start + h.oldCount, 0), out.map(l => l + eol).join(''));
  }
  await vscode.workspace.applyEdit(edit);

  await sendCompare(commit);
}

function html(webview: vscode.Webview): string {
  const nonce = Math.random().toString(36).slice(2) + Date.now().toString(36);
  return `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
<style>
  body { margin: 0; padding: 0; font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); color: var(--vscode-foreground); }
  .wrap { display: grid; grid-template-columns: minmax(220px, 32%) 1fr; height: 100vh; }
  #list { overflow-y: auto; border-right: 1px solid var(--vscode-panel-border); }
  #detail { overflow-y: auto; padding: 12px 16px; }
  .item { position: relative; padding: 8px 12px 8px 26px; cursor: pointer; border-bottom: 1px solid var(--vscode-panel-border); }
  .item::before { content: ''; position: absolute; left: 11px; top: 0; bottom: 0; width: 2px; background: var(--vscode-panel-border); }
  .item::after { content: ''; position: absolute; left: 7px; top: 13px; width: 10px; height: 10px; border-radius: 50%; background: var(--vscode-editor-background); border: 2px solid var(--vscode-descriptionForeground); box-sizing: border-box; }
  .item.owner::after { background: var(--vscode-charts-orange); border-color: var(--vscode-charts-orange); }
  .item:hover { background: var(--vscode-list-hoverBackground); }
  .item.sel { background: var(--vscode-list-activeSelectionBackground); color: var(--vscode-list-activeSelectionForeground); }
  .subj { font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .meta { opacity: .75; font-size: .9em; margin-top: 2px; }
  .tag { font-size: .8em; padding: 0 5px; border-radius: 3px; background: var(--vscode-charts-orange); color: var(--vscode-editor-background); margin-left: 4px; }
  h2 { margin: 0 0 4px; font-size: 1.15em; }
  .bar { display: flex; align-items: center; gap: 8px; margin: 10px 0 0; }
  .bar .hint { flex: 1; margin: 0; }
  .hint { opacity: .7; font-size: .9em; margin: 8px 0; }
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
  .l.done { opacity: .45; }
  .ok { opacity: .7; font-size: .9em; }
  .l.picked { border-left-color: var(--vscode-focusBorder); filter: brightness(1.35); }
  .empty { opacity: .7; padding: 20px 0; }
</style></head><body>
<div class="wrap"><div id="list"></div><div id="detail"><div class="empty">Loading…</div></div></div>
<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  const list = document.getElementById('list'), detail = document.getElementById('detail');
  let commits = [], owner, sel = 0, pending = null, anyDiff = false, picked = new Map(), anchor = null;
  const esc = s => s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const when = t => {
    const d = (Date.now() - t) / 1000;
    const rel = d < 3600 ? Math.round(d / 60) + 'm' : d < 86400 ? Math.round(d / 3600) + 'h' : d < 86400 * 60 ? Math.round(d / 86400) + 'd' : Math.round(d / 86400 / 30) + 'mo';
    return new Date(t).toLocaleString() + ' · ' + rel + ' ago';
  };
  const lineCls = l => l[0] === '+' ? 'add' : l[0] === '-' ? 'del' : '';

  function renderList() {
    list.innerHTML = commits.map((c, i) =>
      '<div class="item' + (i === sel ? ' sel' : '') + (c.hash === owner ? ' owner' : '') + '" data-i="' + i + '">' +
      '<div class="subj">' + esc(c.subject) + (c.hash === owner ? '<span class="tag">cursor line</span>' : '') + '</div>' +
      '<div class="meta">' + esc(c.author) + ' · ' + c.hash.slice(0, 7) + '</div>' +
      '<div class="meta">' + when(c.date) + '</div></div>').join('');
  }

  function renderDetail() {
    const c = commits[sel];
    if (!c) { detail.innerHTML = '<div class="empty">No commit selected.</div>'; return; }
    let body;
    if (!c.hunks.length) body = '<div class="empty">No text changes to this file in this commit.</div>';
    else body = c.hunks.map((h, j) => {
      const p = picked.get(j), pend = pending?.[j];
      const open = !pend || pend.some(Boolean);
      return '<div class="hunk pickable"><div class="hhead"><span>' + esc(h.header) + '</span>' +
        (p && p.size ? '<button data-act="lines" data-h="' + j + '">Restore ' + p.size + ' selected line' + (p.size === 1 ? '' : 's') + '</button>' : '') +
        (open ? '<button class="sec" data-act="hunk" data-h="' + j + '">Restore block</button>' : '<span class="ok">✓ matches current file</span>') + '</div><pre>' +
        h.lines.map((l, k) => {
          const done = pend && l[0] !== ' ' && !pend[k];
          return '<span class="l ' + lineCls(l) + (p && p.has(k) ? ' picked' : '') + (done ? ' done' : '') + '" data-h="' + j + '" data-k="' + k + '"' +
            (done ? ' title="Already like this in the current file"' : '') + '>' + esc(l) + '</span>';
        }).join('') + '</pre></div>';
    }).join('');
    detail.innerHTML = '<h2>' + esc(c.subject) + '</h2><div class="meta">' + esc(c.author) + ' · ' + c.hash.slice(0, 10) + ' · ' + when(c.date) + (c.path ? ' · ' + esc(c.path) : '') + '</div>' +
      '<div class="bar"><div class="hint">Click lines to pick them (shift-click for a range), then restore them to how this commit left them. Faded lines already match the current file.</div>' +
      (anyDiff ? '<button class="sec" data-act="all">Restore whole file</button>' : '') + '</div>' + body;
  }

  function select(i) {
    const next = Math.max(0, Math.min(commits.length - 1, i));
    if (next !== sel) { picked = new Map(); anchor = null; pending = null; anyDiff = false; }
    sel = next;
    renderList(); renderDetail();
    vscode.postMessage({ type: 'compare', commit: sel });
    list.querySelector('.sel')?.scrollIntoView({ block: 'nearest' });
  }

  list.addEventListener('click', e => { const it = e.target.closest('.item'); if (it) select(+it.dataset.i); });
  detail.addEventListener('click', e => {
    const b = e.target.closest('button[data-act]');
    if (b) {
      const h = +b.dataset.h;
      if (b.dataset.act === 'all') vscode.postMessage({ type: 'restore', commit: sel });
      if (b.dataset.act === 'hunk') vscode.postMessage({ type: 'restore', commit: sel, hunk: h });
      if (b.dataset.act === 'lines') vscode.postMessage({ type: 'restore', commit: sel, hunk: h, lines: [...picked.get(h)] });
      return;
    }
    const l = e.target.closest('.pickable .l.add, .pickable .l.del');
    if (!l) return;
    const h = +l.dataset.h, k = +l.dataset.k;
    const set = picked.get(h) ?? new Set();
    if (e.shiftKey && anchor && anchor.h === h) {
      const lines = commits[sel].hunks[h].lines;
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
  window.addEventListener('message', ({ data }) => {
    if (data.type === 'load') {
      commits = data.commits; owner = data.owner;
      const o = commits.findIndex(c => c.hash === owner);
      sel = -1; select(o < 0 ? 0 : o);
    }
    if (data.type === 'compare' && data.commit === sel) {
      pending = data.pending; anyDiff = data.anyDiff;
      for (const [h, set] of picked) for (const k of set) if (!pending[h]?.[k]) set.delete(k);
      renderDetail();
    }
  });
</script></body></html>`;
}
