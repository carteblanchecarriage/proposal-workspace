#!/usr/bin/env bash
# Blocks commits and pushes that contain secrets. Installed as git hooks by scripts/install-hooks.sh.
#   check-secrets.sh staged          → scans what's about to be committed (pre-commit)
#   check-secrets.sh range A..B      → scans commits about to be pushed (pre-push)
# The repo is public, so anything that gets through is exposed.
set -euo pipefail

PATTERNS=(
  'sb_secret_[A-Za-z0-9_-]{10,}'                       # Supabase secret key
  'sk-ant-[A-Za-z0-9_-]{10,}'                          # Anthropic API key
  'eyJ[A-Za-z0-9_-]{15,}\.eyJ[A-Za-z0-9_-]{15,}\.'     # JWTs (old-style Supabase service_role keys, session tokens)
  '-----BEGIN [A-Z ]*PRIVATE KEY-----'
  'AKIA[0-9A-Z]{16}'                                   # AWS access key
  'gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}'
  'xox[abpr]-[A-Za-z0-9-]{10,}'                        # Slack
  'vercel_[A-Za-z0-9]{20,}'
  '(postgres|postgresql)://[^:@/ ]+:[^@/ ]+@'          # database URL with a password
)
# Files that should never be committed (.env.example is the one allowed env file).
BAD_FILES='(^|/)\.env($|\.)|(^|/)id_(rsa|ed25519)|\.pem$|\.p12$|\.key$'

mode=${1:-staged}
# Prints the lines a file adds (staged, or across the pushed range).
added() {
  if [[ $mode == staged ]]; then git diff --cached -U0 -- "$1"; else git diff -U0 "$range" -- "$1"; fi | grep -E '^\+[^+]' || true
}
if [[ $mode == staged ]]; then
  files=$(git diff --cached --name-only --diff-filter=ACMR)
else
  range=$2
  files=$(git diff --name-only --diff-filter=ACMR "$range")
fi

fail=0
bad=$(grep -E "$BAD_FILES" <<<"$files" | grep -vE '(^|/)\.env\.example$' || true)
if [[ -n $bad ]]; then
  echo "✗ Secret-looking files:"; sed 's/^/    /' <<<"$bad"; fail=1
fi

while IFS= read -r f; do
  [[ -z $f ]] && continue
  lines=$(added "$f")
  for p in "${PATTERNS[@]}"; do
    # Name the file and kind of secret, never print the secret itself.
    if grep -qE -- "$p" <<<"$lines"; then echo "✗ Possible secret in $f (matches ${p:0:12}…)"; fail=1; fi
  done
done <<<"$files"

# Words that must never be committed (names, clients, …), one per line, in .git/info/blocked-terms. That file lives
# inside .git, so it's never committed itself. Matched case-insensitively as a whole word (letters/digits around it
# don't count, so random hashes don't trip it).
terms_file=$(git rev-parse --git-path info/blocked-terms)
if [[ -f $terms_file ]]; then
  while IFS= read -r term; do
    term=${term%%#*}; term=${term//[[:space:]]/}
    [[ -z $term ]] && continue
    while IFS= read -r f; do
      [[ -z $f ]] && continue
      if added "$f" | grep -qiE -- "(^|[^[:alnum:]])${term}([^[:alnum:]]|$)"; then echo "✗ Blocked term in $f (see .git/info/blocked-terms)"; fail=1; fi
    done <<<"$files"
    # File names too.
    if grep -qiE -- "(^|[^[:alnum:]])${term}([^[:alnum:]]|$)" <<<"$files"; then echo "✗ Blocked term in a file name"; fail=1; fi
  done <"$terms_file"
fi

if (( fail )); then
  echo "Blocked by scripts/check-secrets.sh. Remove the secret (keep keys in .env.local / Vercel env vars) and try again."
  exit 1
fi
echo "✓ No secrets found."
