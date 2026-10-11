#!/usr/bin/env bash
# The Developer Certificate of Origin (ADR 0002, CONTRIBUTING.md): every commit in the range,
# merges aside, carries a Signed-off-by trailer with its author's email.
#
#   scripts/check-dco.sh                 the commits on this branch that main does not have
#   scripts/check-dco.sh BASE..HEAD      the commits of a pull request, as CI passes them
set -euo pipefail
cd "$(dirname "$0")/.."

range=${1:-}
if [ -z "$range" ]; then
  main=origin/main
  git rev-parse --verify -q "$main" > /dev/null || main=main
  range="$main..HEAD"
fi

checked=0
missing=0
for sha in $(git rev-list --no-merges "$range"); do
  checked=$((checked + 1))
  email=$(git log -1 --format=%ae "$sha" | tr '[:upper:]' '[:lower:]')
  # Read first, not piped into grep -q, which stops reading early and under pipefail would fail
  # the pipeline when tr's write is cut off.
  signers=$(git log -1 --format='%(trailers:key=Signed-off-by,valueonly)' "$sha" |
    tr '[:upper:]' '[:lower:]')
  if ! grep -qF "<$email>" <<< "$signers"; then
    echo "dco: $(git log -1 --format='%h %s' "$sha")" >&2
    echo "     has no Signed-off-by from its author, $email" >&2
    missing=$((missing + 1))
  fi
done

if [ "$missing" -gt 0 ]; then
  echo "dco: $missing of $checked commits are not signed off. Sign off with 'git commit -s'," >&2
  echo "     or add it to earlier commits with 'git rebase --signoff ${range%%..*}', then push again." >&2
  exit 1
fi
echo "dco: $checked commits signed off"
