#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"

export ASPNETCORE_URLS="${ASPNETCORE_URLS:-http://127.0.0.1:4173}"

echo "Starting Peptide Dose Planner at ${ASPNETCORE_URLS}"

if dotnet --list-runtimes | grep -q '^Microsoft.AspNetCore.App 9\.'; then
  dotnet run --project src/Shots.Web
else
  echo "Microsoft.AspNetCore.App 9.x runtime not found; using self-contained run."
  dotnet run --project src/Shots.Web -r linux-x64 --self-contained
fi
