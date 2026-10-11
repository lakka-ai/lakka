#!/usr/bin/env bash
# Checks UI source for characters the copy rules ban (docs/design/docs/copy.md).
# Usage: scripts/check-copy.sh [path ...]   (default: apps/web/src)
# Exit code 1 when anything is found, 2 when grep itself fails.
#
# The design bundle's version used grep -P, which BSD grep on macOS lacks, and it passed
# when grep errored. This one sticks to POSIX ERE in the C locale, so it runs the same on
# macOS and Linux, and a grep error fails the check.
set -u
paths=("$@")
[ ${#paths[@]} -eq 0 ] && paths=(apps/web/src)
status=0
export LC_ALL=C

# BSD grep with --include skips a missing path without an error.
for path in "${paths[@]}"; do
  [ -e "$path" ] || { echo "check-copy: no such path: $path" >&2; exit 2; }
done

# grep exits 0 on a match, 1 on none, 2 on an error.
run() {
  "$@"
  local code=$?
  [ $code -gt 1 ] && exit 2
  return $code
}

# Any non-ASCII byte: em and en dashes, curly quotes, ellipsis, arrows and the rest.
if run grep -rnE $'[\x80-\xff]' --include='*.ts' --include='*.tsx' --include='*.js' \
  --include='*.jsx' --include='*.json' --include='*.md' --include='*.html' --include='*.css' \
  "${paths[@]}"; then
  echo "check-copy: non-ASCII characters found (see above)" >&2
  status=1
fi

# A plus sign between words inside a string literal or JSX text, used to mean "and". Code such
# as `reply + piece` is fine, so only text between quotes, backticks or tags is matched, and
# a match may not span code (parentheses, semicolons, assignments) between two literals.
word_plus="[A-Za-z] \\+ [A-Za-z]"
code_chars="();="
literal="'[^'$code_chars]*${word_plus}[^'$code_chars]*'|\"[^\"$code_chars]*${word_plus}[^\"$code_chars]*\"|\`[^\`$code_chars]*${word_plus}[^\`$code_chars]*\`|>[^<{]*${word_plus}[^<{]*<"
if run grep -rnE "$literal" --include='*.ts' --include='*.tsx' --include='*.jsx' \
  --include='*.json' "${paths[@]}"; then
  echo "check-copy: '+' used as 'and' in UI text (see above); write 'and'" >&2
  status=1
fi

exit $status
