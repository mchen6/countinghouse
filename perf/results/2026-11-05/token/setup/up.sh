#!/bin/bash
# Run as:  sudo bash <this file>
# Builds the image and starts the container detached. Stop it later with:
#   sudo docker stop ch-token-cost
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
docker build --progress=plain -f "$HERE/ctx/Dockerfile.token-cost" -t ch-token-cost:1 "$HERE/ctx"
docker rm -f ch-token-cost >/dev/null 2>&1 || true
# The auth file holds the test key; it is mounted read-only into the
# container and never baked into the image. No other host path is mounted.
docker run -d --name ch-token-cost -p 127.0.0.1:9540:9540 \
  -v "$HERE/../secrets/server-auth.json:/run/perf/server-auth.json:ro" \
  ch-token-cost:1
docker image inspect ch-token-cost:1 --format 'image {{.Id}}'
docker inspect ch-token-cost --format 'container {{.Id}} started {{.State.StartedAt}}'
for i in $(seq 1 60); do
  # capture first: grep -q closing the pipe early would SIGPIPE docker logs,
  # and pipefail would turn a ready server into a failure
  out=$(docker logs ch-token-cost 2>&1)
  if grep -q 'countinghouse ready' <<<"$out"; then echo READY; exit 0; fi
  sleep 1
done
echo "not ready after 60s; last log lines:"; docker logs --tail 30 ch-token-cost
exit 1
