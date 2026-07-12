#!/usr/bin/env bash
set -euo pipefail

archive=/backup/production.archive.gz

if [[ ! -r "$archive" ]]; then
  echo "MongoDB bootstrap archive is missing: $archive" >&2
  exit 1
fi

echo "Restoring the local development database from the bundled production archive."
mongorestore \
  --archive="$archive" \
  --gzip \
  --drop \
  --nsInclude='i-store-db.*'
