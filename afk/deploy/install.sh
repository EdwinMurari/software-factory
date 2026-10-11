#!/usr/bin/env bash
set -euo pipefail
# Run as berry from a verified, committed source checkout.
if [[ $(id -un) != berry ]]; then
  echo 'Run this installer as berry.' >&2
  exit 1
fi
source_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)
state_dir=/srv/appdata/berry/state/services/software-factory
node_dir=/home/berry/.nvm/versions/node/v26.5.0/bin
export PATH="$node_dir:/home/berry/.local/bin:/usr/local/bin:/usr/bin:/bin"
[[ -x "$node_dir/node" && -x "$node_dir/npm" ]]
if [[ -n $(git -C "$source_dir" status --porcelain) ]]; then
  echo 'Commit and verify source before installing a release.' >&2
  exit 1
fi
revision=$(git -C "$source_dir" rev-parse HEAD)
release="$state_dir/releases/$revision"
install -d -m 0700 "$state_dir/releases" "$state_dir/runs" /home/berry/.local/bin
if [[ ! -d "$release" ]]; then
  staging=$(mktemp -d "$state_dir/releases/.install.XXXXXXXX")
  trap 'rm -rf -- "$staging"' EXIT
  git -C "$source_dir" archive HEAD afk | tar -x -C "$staging"
  npm ci --prefix "$staging/afk" --ignore-scripts --no-audit --no-fund
  chmod 0700 "$staging/afk/deploy/berry-afk"
  mv -T -- "$staging" "$release"
  trap - EXIT
fi
# Atomic entrypoint replacement; existing processes retain their release paths.
link=$(mktemp /home/berry/.local/bin/.berry-afk.XXXXXXXX)
rm -- "$link"
ln -s "$release/afk/deploy/berry-afk" "$link"
mv -Tf -- "$link" /home/berry/.local/bin/berry-afk
printf 'Installed independent factory release %s\n' "$revision"
printf 'Run berry-afk run --config FILE --spec FILE --flow build\n'
