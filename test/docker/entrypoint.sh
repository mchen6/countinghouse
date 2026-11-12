#!/bin/sh
# The container's own Redis, on its own loopback, with nothing persisted;
# then the command (a test run).
set -e
redis-server --bind 127.0.0.1 --port 6379 --save '' --appendonly no --dir /tmp --daemonize yes >/dev/null
i=0
until redis-cli -p 6379 ping >/dev/null 2>&1; do
  i=$((i + 1))
  if [ "$i" -gt 100 ]; then echo 'entrypoint: redis-server did not start' >&2; exit 1; fi
  sleep 0.1
done
exec "$@"
