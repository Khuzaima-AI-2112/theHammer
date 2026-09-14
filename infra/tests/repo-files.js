'use strict';

// The files that belong to the repository, for guards that scan it (#10).
//
// Asked of git rather than walked from disk: a walk also finds node_modules,
// scratch copies and anything else .gitignore excludes, so a guard would pass
// in a clean checkout and fail on a developer's machine for a file nobody
// committed. Untracked files that are not ignored are included, so a stray is
// caught before it is committed, not after.

const { execFileSync } = require('node:child_process');
const path = require('node:path');

const REPO = path.join(__dirname, '..', '..');

/** Repo-relative, forward-slash paths of tracked and not-ignored files. */
function repoFiles() {
  const out = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], {
    cwd: REPO,
    encoding: 'utf8',
  });
  return out.split('\0').filter(Boolean);
}

module.exports = { repoFiles };
