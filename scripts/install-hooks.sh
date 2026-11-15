#!/usr/bin/env bash
# Installs git hooks that run scripts/check-secrets.sh before every commit and push. Run once per clone.
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
hooks=$(git rev-parse --git-path hooks)
mkdir -p "$hooks"

cat > "$hooks/pre-commit" <<'EOF'
#!/usr/bin/env bash
exec bash scripts/check-secrets.sh staged
EOF

cat > "$hooks/pre-push" <<'EOF'
#!/usr/bin/env bash
# stdin: <local ref> <local sha> <remote ref> <remote sha>
zero=0000000000000000000000000000000000000000
while read -r _ local _ remote; do
  [[ $local == "$zero" ]] && continue
  # A new branch is checked against an empty tree, i.e. everything in it.
  [[ $remote == "$zero" ]] && remote=$(git hash-object -t tree /dev/null)
  bash scripts/check-secrets.sh range "$remote..$local" || exit 1
done
EOF

chmod +x "$hooks/pre-commit" "$hooks/pre-push"
echo "Installed pre-commit and pre-push secret checks."
