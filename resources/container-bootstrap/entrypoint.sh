#!/usr/bin/env bash
# Session-container entrypoint.
# Runs as `aionui` user. Receives the agent/worker command via `docker exec`,
# so this script is mostly idle — it just ensures /workspace exists and execs
# whatever the control-plane asked for.
set -euo pipefail

# If invoked without args (CMD = "sleep infinity"), just exec the CMD.
# Otherwise, exec the provided command (used when control-plane uses
# `docker run` instead of `docker exec`).
if [ "$#" -eq 0 ]; then
  exec sleep infinity
fi

exec "$@"
