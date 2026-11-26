#!/usr/bin/env bash
# Writes `node-version-file=<path>` to $GITHUB_OUTPUT: the .node-version in $WORKING_DIRECTORY or, failing
# that, the nearest one above it up to $GITHUB_WORKSPACE, as a path relative to $GITHUB_WORKSPACE
# (setup-node joins its node-version-file to the workspace). Fails for a directory outside the
# workspace or with no .node-version on the way up. Bash, not Node: it runs before Node is set up.
# An empty WORKING_DIRECTORY is the root. CDPATH is unset, and each cd's stdout dropped, so a cd that
# CDPATH resolves cannot print its directory into the paths captured below.
set -euo pipefail
unset CDPATH
WORKING_DIRECTORY=${WORKING_DIRECTORY:-.}

workspace=$(cd -- "$GITHUB_WORKSPACE" >/dev/null && pwd -P)
if ! dir=$(cd -- "$GITHUB_WORKSPACE/$WORKING_DIRECTORY" >/dev/null 2>&1 && pwd -P); then
  echo "::error::working-directory $WORKING_DIRECTORY does not exist"
  exit 1
fi
case "$dir/" in
  "$workspace"/*) ;;
  *)
    echo "::error::working-directory $WORKING_DIRECTORY is outside the repository"
    exit 1
    ;;
esac
while [ ! -f "$dir/.node-version" ] && [ "$dir" != "$workspace" ]; do dir=$(dirname "$dir"); done
if [ ! -f "$dir/.node-version" ]; then
  echo "::error::no .node-version in $WORKING_DIRECTORY or a directory above it"
  exit 1
fi
relative=${dir#"$workspace"}
relative=${relative#/}
echo "node-version-file=${relative:+$relative/}.node-version" >> "$GITHUB_OUTPUT"
