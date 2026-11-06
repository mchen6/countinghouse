#!/bin/bash
# Starts a private Redis, pre-funds every key in the mounted auth file, then
# the server on 0.0.0.0:9540 (published on the host as 127.0.0.1:9540 only).
set -euo pipefail
AUTH=/run/perf/server-auth.json
redis-server --daemonize yes --bind 127.0.0.1 --dir /home/ch --save '' --appendonly no
until redis-cli ping >/dev/null 2>&1; do sleep 0.2; done
for k in $(node -e 'console.log(Object.keys(require(process.argv[1])).join(" "))' "$AUTH"); do
  redis-cli HSET "$k" balance 1000000 >/dev/null
done
exec node ./framework.js --workerThread --bindAddr 0.0.0.0 --port 9540 \
  --authProvider file --authConfigPath "$AUTH" --mcpToolCallCost 1 \
  --loadModule ./examples/log-triage/log-read --loadModule ./examples/log-triage/pii-redact \
  --loadModule ./examples/log-triage/error-cluster --loadModule ./examples/log-triage/log-triage
