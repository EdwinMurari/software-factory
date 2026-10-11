#!/usr/bin/env bash
set -euo pipefail
# Run as berry after verified source is deployed to the canonical checkout.
if [[ $(id -un) != berry ]]; then
  echo 'Run this installer as berry.' >&2
  exit 1
fi
source_dir=/srv/appdata/berry/projects/services/software-factory/afk
config_dir=/srv/appdata/berry/config/software-factory
state_dir=/srv/appdata/berry/state/services/software-factory
runtime_dir="$state_dir/runtime"
node_dir=/home/berry/.nvm/versions/node/v26.5.0/bin
export PATH="$node_dir:/home/berry/.local/bin:/usr/local/bin:/usr/bin:/bin"
if systemctl --user is-active --quiet berry-afk.service; then
  echo 'Stop berry-afk.service before updating runtime dependencies.' >&2
  exit 1
fi
[[ -x "$node_dir/node" && -x "$node_dir/npm" ]]
[[ -f "$source_dir/package-lock.json" ]]
if [[ -e "$source_dir/node_modules" && ! -L "$source_dir/node_modules" ]]; then
  echo 'Source node_modules must be absent or a symlink. Installation stopped.' >&2
  exit 1
fi
install -d -m 0700 "$config_dir" "$state_dir" "$runtime_dir" /home/berry/.config/systemd/user /home/berry/.local/bin
install -m 0600 "$source_dir/package.json" "$source_dir/package-lock.json" "$runtime_dir/"
npm ci --prefix "$runtime_dir" --ignore-scripts --no-audit --no-fund
ln -sfn "$runtime_dir/node_modules" "$source_dir/node_modules"
if [[ ! -e "$config_dir/repositories.json" ]]; then
  install -m 0600 "$source_dir/deploy/repositories.example.json" "$config_dir/repositories.json"
fi
install -m 0600 "$source_dir/deploy/berry-afk.service" /home/berry/.config/systemd/user/berry-afk.service
install -m 0700 "$source_dir/deploy/berry-afk" /home/berry/.local/bin/berry-afk
systemctl --user daemon-reload
echo 'Installed. Register repositories, then enable and start the user unit.'
