# OHMG

Multipurpose UI tweaks for VS Code, mostly around git.

## Features

### File history (Cmd+Shift+Y / Ctrl+Shift+Y)

Opens a tab with the history of the file you're editing. It's also available from the Command Palette as **OHMG: File History Timeline**.

It's built for tracking down regressions. Walk back through the commits that touched a file, see what each one changed (and what else changed with it), and put old code back into your working file to check whether the issue goes away.

- **Timeline (left).** Every commit that touched the file, newest first, following renames (last 200). Each entry shows the message, author, short id and date. The dot's colour shows how much the commit changed this file (grey small, yellow medium, red large, relative to the file's own history). A filled dot marks the commit that created or renamed the file. Hover the dot for exact line counts. Use the mouse or ↑/↓ (j/k) to browse. Drag the divider to resize it, or double-click the divider to reset. It starts on the commit that last changed the line under your cursor.
- **Commit header.** Click the commit id to copy the full hash. **Open on server ↗** opens the commit on GitHub, GitLab, Bitbucket or Azure DevOps, based on the `origin` remote.
- **Compare to current tab.** Your current file, including unsaved edits, compared with the file as it was at that commit. `-` lines are in your file now and `+` lines are from the commit. Line numbers refer to your current file.
  - **Restore block** makes that block match the commit.
  - Click lines (shift-click for a range), then **Restore N selected** to apply only those lines, the same way partial staging works. When you pick a `-` line and the `+` line that replaced it, the commit's line goes in the same place.
  - **Restore whole file** makes the file match the commit, after asking you to confirm.
  - Restores are unsaved edits, so Cmd/Ctrl+Z undoes them. The comparison refreshes after each restore and while you edit.
- **Changes in commit tab.** Context for the commit. Read-only.
  - The full commit message.
  - What the commit changed in this file.
  - **Files in this commit**, at the bottom: every file the commit touched, with its status (added, modified, deleted, renamed) and +/− line counts. The current file is marked. Click another file to open its history in a new tab, already on the same commit, so you can compare it with your current code and restore from it in the same way.

Several history tabs can be open at once. The shortcut reuses the history tab you used last; files opened from **Files in this commit** always get a new tab.

### Stash selected files

In the Source Control view, select files, right-click, and choose **STASH Selected**. The selected files go into one stash, whether they're modified, staged or untracked. The stash is named after the current day and time, e.g. `TUE 13:30:40`.

### Status bar

- **Branch.** The current branch with ahead/behind counts. Click it to copy the branch name. `ohmg.git.branchStatusBar.ticketPattern` can shorten it to a ticket number, e.g. `f/notifications-217943` → `#217943`.
- **Changed files.** The number of changed files. Click it to open them all.
- **OHMG menu** (tools icon). Hover it for quick actions such as **Rebuild & Reload OHMG**.

Turn any of these on or off with **OHMG: Toggle Feature…** or the `ohmg.*.enabled` settings.

## Settings

| Setting | Default | |
|---|---|---|
| `ohmg.git.branchStatusBar.enabled` | `true` | Branch status bar item |
| `ohmg.git.branchStatusBar.ticketPattern` | `(\d{4,})$` | Regex for the ticket number; first capture group is shown. Empty shows the full branch |
| `ohmg.git.changedFilesBadge.enabled` | `true` | Changed files status bar item |
| `ohmg.statusMenu.enabled` | `true` | OHMG status bar menu |
| `ohmg.dev.sourcePath` | `""` | Extension source folder used by Rebuild & Reload OHMG |

## Development

```sh
npm install
npm run compile   # or: npm run watch
npm test          # unit tests (node:test, against throwaway git repos)
npm run package   # builds the .vsix
```

Press F5 to run it in an Extension Development Host, or use **OHMG: Rebuild & Reload OHMG** to rebuild, reinstall and reload in place.

Source layout:

- `src/extension.ts`: activation and command registration.
- `src/features/`: status bar features. Each one is registered in `features/index.ts` and has an `enabled` setting.
- `src/features/blameTimeline.ts`: the file history panel.
- `src/git/api.ts`: a thin wrapper around the built-in git extension API.
- `src/git/history.ts`: git log/diff/blame parsing, and building commit web links.
- `src/git/patch.ts`: applying picked parts of a diff (pure, no vscode).
- `src/git/stashSelected.ts`: Stash Selected.
- `src/test/`: unit tests for the git parsing and restore logic.
