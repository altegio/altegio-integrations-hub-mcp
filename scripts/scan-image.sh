#!/usr/bin/env bash
# Report every severity; block HIGH/CRITICAL findings with an available fix.
# No registry credentials or production access are needed for a local image.
set -euo pipefail
image="${1:?usage: scan-image.sh IMAGE}"
scanner='aquasec/trivy:0.76.2@sha256:8f6bb947dbc528902e11f2f5be52f7b519f6a39d5d148f41166f2040499768fb'
cache="${TRIVY_CACHE_DIR:-$PWD/.audit/trivy-cache}"
mkdir -p "$cache"
args=(--rm -v /var/run/docker.sock:/var/run/docker.sock -v "$cache:/root/.cache/trivy")
scan=(image --no-progress --image-src docker --scanners vuln --timeout 10m)
docker run "${args[@]}" "$scanner" "${scan[@]}" --exit-code 0 "$image"
docker run "${args[@]}" "$scanner" "${scan[@]}" --severity HIGH,CRITICAL --ignore-unfixed --exit-code 1 "$image"
