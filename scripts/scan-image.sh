#!/usr/bin/env bash
# Report all HIGH/CRITICAL findings; block those with an available fix.
# No registry credentials or production access are needed for a local image.
set -euo pipefail
image="${1:?usage: scan-image.sh IMAGE}"
scanner='aquasec/trivy:0.76.1@sha256:790fd66d1697395d8693d1acaa1ea702406a20f109b6fc7bac8db623eca6c06c'
cache="${TRIVY_CACHE_DIR:-$PWD/.audit/trivy-cache}"
mkdir -p "$cache"
args=(--rm -v /var/run/docker.sock:/var/run/docker.sock -v "$cache:/root/.cache/trivy")
scan=(image --image-src docker --scanners vuln --severity HIGH,CRITICAL --timeout 10m)
docker run "${args[@]}" "$scanner" "${scan[@]}" --exit-code 0 "$image"
docker run "${args[@]}" "$scanner" "${scan[@]}" --ignore-unfixed --exit-code 1 "$image"
