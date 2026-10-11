#!/bin/sh
set -eu

cd /app

# station.yaml is the single source of truth for enabled local plugins.
exec ./node_modules/.bin/tsx src/index.ts "$@"
