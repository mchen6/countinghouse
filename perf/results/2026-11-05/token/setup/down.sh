#!/bin/bash
# Run as:  sudo bash <this file>
# Undoes up.sh: removes the container, the image, and the test key's files.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
docker rm -f ch-token-cost
docker image rm ch-token-cost:1
rm -f "$HERE/../secrets/server-auth.json" "$HERE/../secrets/mcp.json"
echo "removed container ch-token-cost, image ch-token-cost:1 and the secrets files"
