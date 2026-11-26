import * as assert from 'assert/strict';
import { after, before, describe, it } from 'node:test';
import { blameLine, commitFiles, commitWebUrl, fileHistory, showFile, unquote } from '../git/history';
import { lines, TempRepo } from './helpers';

describe('fileHistory', () => {
  let repo: TempRepo;
  const hashes: Record<string, string> = {};

  before(() => {
    repo = new TempRepo();
    repo.write('f.txt', lines('a', 'b', 'c'));
    hashes.one = repo.commit('one');
    repo.write('f.txt', lines('a', 'B', 'c', 'd'));
    hashes.two = repo.commit('two\n\nWhy it changed.\nSecond line.');
    repo.git('mv', 'f.txt', 'renamed.txt');
    hashes.rename = repo.commit('rename');
    repo.write('renamed.txt', lines('a', 'B', 'c', 'd', 'e'));
    hashes.three = repo.commit('three');
  });
  after(() => repo.dispose());

  it('lists commits newest first, following renames', async () => {
    const commits = await fileHistory(repo.root, 'renamed.txt');
    assert.deepEqual(commits.map(c => c.subject), ['three', 'rename', 'two', 'one']);
    assert.deepEqual(commits.map(c => c.hash), [hashes.three, hashes.rename, hashes.two, hashes.one]);
  });

  it('records the path the file had in each commit', async () => {
    const commits = await fileHistory(repo.root, 'renamed.txt');
    assert.equal(commits[0].path, 'renamed.txt');
    assert.equal(commits[2].path, 'f.txt');
  });

  it('keeps the subject and body apart', async () => {
    const two = (await fileHistory(repo.root, 'renamed.txt'))[2];
    assert.equal(two.subject, 'two');
    assert.equal(two.body, 'Why it changed.\nSecond line.');
    assert.equal(two.author, 'Test User');
  });

  it('parses the diff of each commit', async () => {
    const two = (await fileHistory(repo.root, 'renamed.txt'))[2];
    assert.equal(two.hunks.length, 1);
    assert.deepEqual(two.hunks[0].lines, [' a', '-b', '+B', ' c', '+d']);
  });

  it('reads the file as of a commit, under its old name', async () => {
    assert.equal(await showFile(repo.root, hashes.one, 'f.txt'), lines('a', 'b', 'c'));
    assert.equal(await showFile(repo.root, hashes.one, 'renamed.txt'), undefined);
  });

  it('blames a line to the commit that last changed it', async () => {
    assert.equal(await blameLine(repo.root, 'renamed.txt', 2), hashes.two);
    assert.equal(await blameLine(repo.root, 'renamed.txt', 5), hashes.three);
  });
});

describe('fileHistory with awkward content', () => {
  let repo: TempRepo;
  before(() => { repo = new TempRepo(); });
  after(() => repo.dispose());

  it('handles non-ASCII and spaced file names', async () => {
    repo.write('dir with space/café.txt', lines('x'));
    repo.commit('add');
    repo.write('dir with space/café.txt', lines('y'));
    repo.commit('edit');
    const commits = await fileHistory(repo.root, 'dir with space/café.txt');
    assert.equal(commits.length, 2);
    assert.equal(commits[0].path, 'dir with space/café.txt');
    assert.equal(await showFile(repo.root, commits[1].hash, commits[1].path), lines('x'));
  });

  it('is not confused by commit messages that look like diffs', async () => {
    repo.write('m.txt', lines('1'));
    repo.commit('fix\n\n@@ -1,2 +1,2 @@\n+++ b/other.txt');
    const [c] = await fileHistory(repo.root, 'm.txt');
    assert.equal(c.path, 'm.txt');
    assert.deepEqual(c.hunks.map(h => h.lines), [['+1']]);
  });

  it('ignores user config that changes diff output', async () => {
    repo.git('config', 'diff.noprefix', 'true');
    repo.git('config', 'diff.mnemonicPrefix', 'true');
    repo.git('config', 'diff.suppressBlankEmpty', 'true');
    repo.git('config', 'core.quotePath', 'true');
    try {
      repo.write('ñ.txt', lines('a', '', 'b'));
      repo.commit('one');
      repo.write('ñ.txt', lines('a', '', 'B'));
      repo.commit('two');
      const [c] = await fileHistory(repo.root, 'ñ.txt');
      assert.equal(c.path, 'ñ.txt');
      assert.deepEqual(c.hunks[0].lines, [' a', ' ', '-b', '+B']);
    } finally {
      for (const k of ['diff.noprefix', 'diff.mnemonicPrefix', 'diff.suppressBlankEmpty', 'core.quotePath']) repo.git('config', '--unset', k);
    }
  });

  it('returns no history for an untracked file', async () => {
    repo.write('new.txt', 'x');
    assert.deepEqual(await fileHistory(repo.root, 'new.txt'), []);
  });
});

describe('commitFiles', () => {
  let repo: TempRepo;
  let hash: string;
  before(() => {
    repo = new TempRepo();
    repo.write('keep.txt', lines('1', '2'));
    repo.write('gone.txt', lines('x'));
    repo.write('move.txt', lines('m', 'm', 'm'));
    repo.commit('base');
    repo.write('keep.txt', lines('1', 'two', '3'));
    repo.git('rm', '-q', 'gone.txt');
    repo.git('mv', 'move.txt', 'moved.txt');
    repo.write('img.bin', Buffer.from([0, 1, 2, 0, 255]));
    repo.write('sub dir/new é.txt', lines('n'));
    hash = repo.commit('mixed');
  });
  after(() => repo.dispose());

  it('lists every file with status and counts', async () => {
    const files = await commitFiles(repo.root, hash);
    const by = Object.fromEntries(files.map(f => [f.path, f]));
    assert.deepEqual(Object.keys(by).sort(), ['gone.txt', 'img.bin', 'keep.txt', 'moved.txt', 'sub dir/new é.txt']);
    assert.deepEqual([by['keep.txt'].status, by['keep.txt'].added, by['keep.txt'].removed], ['M', 2, 1]);
    assert.deepEqual([by['gone.txt'].status, by['gone.txt'].removed], ['D', 1]);
    assert.deepEqual([by['moved.txt'].status, by['moved.txt'].oldPath], ['R', 'move.txt']);
    assert.equal(by['img.bin'].added, undefined);
    assert.equal(by['sub dir/new é.txt'].status, 'A');
  });

  it('works on the root commit', async () => {
    const root = repo.git('rev-list', '--max-parents=0', 'HEAD').trim();
    const files = await commitFiles(repo.root, root);
    assert.equal(files.length, 3);
    assert.ok(files.every(f => f.status === 'A'));
  });
});

describe('commitWebUrl', () => {
  let repo: TempRepo;
  before(() => { repo = new TempRepo(); });
  after(() => repo.dispose());

  const cases: [string, string][] = [
    ['git@github.com:me/repo.git', 'https://github.com/me/repo/commit/abc'],
    ['https://github.com/me/repo', 'https://github.com/me/repo/commit/abc'],
    ['ssh://git@github.com/me/repo.git', 'https://github.com/me/repo/commit/abc'],
    ['https://gitlab.com/group/sub/repo.git', 'https://gitlab.com/group/sub/repo/-/commit/abc'],
    ['git@bitbucket.org:team/repo.git', 'https://bitbucket.org/team/repo/commits/abc'],
    ['https://org@dev.azure.com/org/proj/_git/repo', 'https://dev.azure.com/org/proj/_git/repo/commit/abc'],
    ['git@ssh.dev.azure.com:v3/org/proj/repo', 'https://dev.azure.com/org/proj/_git/repo/commit/abc'],
    ['https://org.visualstudio.com/proj/_git/repo', 'https://org.visualstudio.com/proj/_git/repo/commit/abc'],
    ['org@vs-ssh.visualstudio.com:v3/org/My%20Proj/repo', 'https://org.visualstudio.com/My%20Proj/_git/repo/commit/abc'],
    ['ssh://org@vs-ssh.visualstudio.com:22/v3/org/My%20Proj/repo', 'https://org.visualstudio.com/My%20Proj/_git/repo/commit/abc'],
  ];
  for (const [remote, url] of cases) {
    it(remote, async () => {
      try { repo.git('remote', 'remove', 'origin'); } catch { /* first case: no remote yet */ }
      repo.git('remote', 'add', 'origin', remote);
      assert.equal(await commitWebUrl(repo.root, 'abc'), url);
    });
  }

  it('returns undefined without a remote', async () => {
    const bare = new TempRepo();
    try { assert.equal(await commitWebUrl(bare.root, 'abc'), undefined); }
    finally { bare.dispose(); }
  });
});

describe('unquote', () => {
  it('decodes git C-style quoted paths', () => {
    assert.equal(unquote('plain.txt'), 'plain.txt');
    assert.equal(unquote('"b/caf\\303\\251.txt"'), 'b/café.txt');
    assert.equal(unquote('"tab\\there \\"q\\".txt"'), 'tab\there "q".txt');
  });
});
