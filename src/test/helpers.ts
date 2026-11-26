import { execFileSync } from 'child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import * as os from 'os';
import * as path from 'path';

/** A throwaway git repo with a fixed identity, isolated from the user's global git config. */
export class TempRepo {
  readonly root = mkdtempSync(path.join(os.tmpdir(), 'ohmg-test-'));

  constructor() {
    this.git('init', '-q', '-b', 'main');
    this.git('config', 'user.name', 'Test User');
    this.git('config', 'user.email', 'test@example.com');
    this.git('config', 'commit.gpgsign', 'false');
  }

  git(...args: string[]): string {
    return execFileSync('git', args, {
      cwd: this.root,
      encoding: 'utf8',
      env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' },
    });
  }

  write(rel: string, content: string | Buffer) {
    const file = path.join(this.root, rel);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, content);
  }

  /** Stages everything and commits; returns the new hash. */
  commit(message: string): string {
    this.git('add', '-A');
    this.git('commit', '-q', '--allow-empty', '-m', message);
    return this.git('rev-parse', 'HEAD').trim();
  }

  dispose() {
    rmSync(this.root, { recursive: true, force: true });
  }
}

export const lines = (...l: string[]) => l.map(x => x + '\n').join('');
