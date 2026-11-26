import * as vscode from 'vscode';
import { GitAPI } from '../git/api';

export interface FeatureContext {
  git: GitAPI | undefined;
  extension: vscode.ExtensionContext;
}

/**
 * A self-contained UI tweak. `enabledSetting` is a key under `ohmg.*`;
 * the feature is started/stopped live when that setting flips.
 */
export interface Feature {
  id: string;
  label: string;
  enabledSetting: string;
  activate(ctx: FeatureContext): vscode.Disposable;
}
