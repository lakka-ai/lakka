#!/usr/bin/env bash
# Dependency and container scanning (NF-S7, ADR 0075 Q3, ADR 0086), with Trivy pinned by digest:
# the lockfile's dependencies, then each image given. A HIGH or CRITICAL vulnerability with a
# fixed version fails; those without a fix are listed, not failed, since no change here can
# fix them. Exceptions go in .trivyignore, each with its reason.
#
#   scripts/scan.sh [image...]
set -euo pipefail
cd "$(dirname "$0")/.."
trivy=aquasec/trivy:0.74.0@sha256:62b1e65e8869bc4b4c6aa4fa2b21595256c7c2f6018a9d9ad61caf87187c1969
run() {
  docker run --rm -v lakka-trivy-cache:/root/.cache -v "$PWD:/src:ro" "$@"
}
gate=(--scanners vuln --severity HIGH,CRITICAL --ignore-unfixed --exit-code 1 --no-progress
  --ignorefile /src/.trivyignore)
report=(--scanners vuln --severity HIGH,CRITICAL --exit-code 0 --no-progress --quiet
  --ignorefile /src/.trivyignore)

echo "scan: dependencies (pnpm-lock.yaml)"
run "$trivy" fs "${gate[@]}" /src

work=$(mktemp -d "${TMPDIR:-/tmp}/lakka-scan.XXXXXX")
trap 'rm -rf "$work"' EXIT
for image in "$@"; do
  echo "scan: image $image"
  docker image save "$image" -o "$work/image.tar"
  run -v "$work:/work:ro" "$trivy" image "${gate[@]}" --input /work/image.tar
  echo "scan: $image, HIGH and CRITICAL with no fix yet (not failed)"
  run -v "$work:/work:ro" "$trivy" image "${report[@]}" --input /work/image.tar
  rm -f "$work/image.tar"
done
echo "scan: nothing HIGH or CRITICAL that has a fix"
