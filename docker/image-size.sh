#!/bin/sh
# NF-D6: our images together must pull under 1 GB (ADR 0023). Registries store layers gzip
# compressed, so the gzip size of `docker image save` approximates the pulled size.
#
# Usage: docker/image-size.sh IMAGE...
set -eu

limit="${LAKKA_IMAGE_BUDGET_BYTES:-1000000000}"
total=0
for image in "$@"; do
  bytes="$(docker image save "$image" | gzip -c | wc -c | tr -d ' ')"
  printf '%-28s %6d MB\n' "$image" "$((bytes / 1000000))"
  total=$((total + bytes))
done
printf '%-28s %6d MB (limit %d MB)\n' "total" "$((total / 1000000))" "$((limit / 1000000))"

if [ "$total" -gt "$limit" ]; then
  echo "image size budget exceeded" >&2
  exit 1
fi
