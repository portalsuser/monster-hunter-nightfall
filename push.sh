#!/usr/bin/env bash
#
# Pushes this repo to GitHub under the `portalsuser` account.
#
# The Cowork cloud sandbox this project was built in has its git proxy locked
# to pre-configured repositories, so it could not reach github.com/portalsuser
# itself. Run this once from your own machine, where your credentials live.
#
#   ./push.sh                      # -> github.com/portalsuser/monster-hunter-nightfall
#   ./push.sh my-repo-name         # custom repo name
#   GH_OWNER=someone ./push.sh     # different owner
#
set -euo pipefail

OWNER="${GH_OWNER:-portalsuser}"
REPO="${1:-monster-hunter-nightfall}"
BRANCH="${BRANCH:-main}"
cd "$(dirname "${BASH_SOURCE[0]}")"

say() { printf '\033[1;36m▸\033[0m %s\n' "$*"; }
die() { printf '\033[1;31m✘\033[0m %s\n' "$*" >&2; exit 1; }

command -v git >/dev/null || die "git is not installed."

# --- 0. clear stale git locks ------------------------------------------------
# This repo was written into your folder through the Cowork device bridge,
# which cannot delete files. Git creates HEAD.lock and temporary object files
# during a commit and unlinks them afterwards; over the bridge those unlinks
# fail, so the leftovers block every later git command with
# "Unable to create '.git/HEAD.lock': File exists".
#
# Nothing is holding them — no git process is running — so clearing them here
# is safe. Guarded on there being no live git process for this repo.
if [[ -d .git ]]; then
  stale=$(find .git \( -name '*.lock' -o -name 'tmp_obj_*' \) 2>/dev/null | wc -l | tr -d ' ')
  if [[ "$stale" != "0" ]]; then
    if pgrep -f "git .*$(basename "$PWD")" >/dev/null 2>&1; then
      die "Found $stale stale git lock file(s) but a git process appears to be running. Close it and re-run."
    fi
    say "Clearing $stale stale git lock file(s) left by the device bridge"
    find .git \( -name '*.lock' -o -name 'tmp_obj_*' \) -delete 2>/dev/null || true
  fi
fi

# --- 1. repo -----------------------------------------------------------------
if [[ ! -d .git ]]; then
  say "Initialising git repository"
  git init -q
  git symbolic-ref HEAD "refs/heads/$BRANCH"
fi

if [[ -z "$(git config user.email || true)" ]]; then
  say "No git user.email set locally — using your global config if present."
fi

# --- 2. commit ---------------------------------------------------------------
git add -A
if git diff --cached --quiet 2>/dev/null; then
  say "Nothing new to commit."
else
  say "Committing"
  git commit -q -m "Monster Hunter: Nightfall — three.js horde survivor for Portals"
fi

# --- 3. remote ---------------------------------------------------------------
REMOTE_URL="https://github.com/${OWNER}/${REPO}.git"

if command -v gh >/dev/null 2>&1 && gh auth status >/dev/null 2>&1; then
  if ! gh repo view "${OWNER}/${REPO}" >/dev/null 2>&1; then
    say "Creating github.com/${OWNER}/${REPO} via gh"
    gh repo create "${OWNER}/${REPO}" --public \
      --description "A horde-survivor hunt through a dark forest. three.js + Portals SDK." \
      --source=. --remote=origin --push
    say "Done → https://github.com/${OWNER}/${REPO}"
    exit 0
  fi
  say "Repo already exists on GitHub"
else
  cat <<EOF

  Note: the GitHub CLI (gh) is not installed or not authenticated.
  This script will push over HTTPS instead, which means the repository
  must already exist. Create it here if you have not yet:

      https://github.com/new    (owner: ${OWNER}, name: ${REPO})

  Or install gh and re-run to have it created automatically:

      brew install gh && gh auth login

EOF
fi

if git remote get-url origin >/dev/null 2>&1; then
  git remote set-url origin "$REMOTE_URL"
else
  git remote add origin "$REMOTE_URL"
fi
say "Remote origin → $REMOTE_URL"

# --- 4. push -----------------------------------------------------------------
git branch -M "$BRANCH"
say "Pushing to $BRANCH"
git push -u origin "$BRANCH"

say "Done → https://github.com/${OWNER}/${REPO}"
