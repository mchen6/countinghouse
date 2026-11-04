#!/usr/bin/env bash
# Re-render every saved perf result with the flags its run used, measuring
# nothing (--render). Produced the files in this directory and in
# ../../2026-10-26/rendered/. $1: output directory
set -eu
cd "$(dirname "$0")/../../../.."
O=$1; mkdir -p $O
R=perf/results
r() { local out=$1; shift; node "$@" > "$O/$out.md"; }
r 2026-10-26-direct-peer-channels perf/direct-peer-channels-perf.js --runs 3 --render $R/2026-10-26/direct-peer-channels.json
r 2026-10-26-serialization perf/peer-channel-serialization-perf.js --runs 3 --render $R/2026-10-26/serialization.json
r 2026-10-26-cross-process perf/cross-process-comparison.js --runs 3 --render $R/2026-10-26/cross-process.json
r 2026-10-26-log-triage perf/log-triage-perf.js --reps 25 --runs 3 --render $R/2026-10-26/log-triage.json
for c in 4 8 16 32; do
  r 2026-10-26-cap-sweep-$c perf/direct-peer-channels-perf.js --runs 3 --paths direct --cells 1048576:64 --directPeerChannelsMaxConcurrency $c --render $R/2026-10-26/cap-sweep-$c.json
done
r 2026-10-26-sandbox-direct-peer-channels perf/direct-peer-channels-perf.js --runs 3 --paths direct --sandboxModes off,audit,enforce --mcpToolCallCost 1 --render $R/2026-10-26/sandbox-direct-peer-channels.json
r 2026-10-26-sandbox-log-triage perf/log-triage-perf.js --reps 25 --runs 3 --paths direct --matrix headline --sandboxModes off,audit,enforce --render $R/2026-10-26/sandbox-log-triage.json
r 2026-10-26-recheck-1MB-c16 perf/direct-peer-channels-perf.js --runs 5 --paths direct --cells 1048576:16 --sandboxModes off,audit --mcpToolCallCost 1 --render $R/2026-10-26/recheck-1MB-c16.json
r 2026-10-27-log-triage perf/log-triage-perf.js --reps 25 --runs 3 --render $R/2026-10-27/log-triage.json
