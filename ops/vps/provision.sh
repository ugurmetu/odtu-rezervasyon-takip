#!/bin/bash
set -euo pipefail
base=/opt/odtu-rez
sudo install -d -m 0755 "$base/runtime" "$base/releases"
if ! id rez >/dev/null 2>&1; then
  sudo useradd --system --create-home --home-dir /var/lib/odtu-rez --shell /usr/sbin/nologin rez
fi
sudo install -d -o rez -g rez -m 0700 /var/lib/odtu-rez/private /var/lib/odtu-rez/chrome-profile
sudo apt-get update -qq
sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq curl ca-certificates unzip xz-utils xvfb xauth dbus-x11 libnss3 libatk1.0-0 libatk-bridge2.0-0 libx11-xcb1 libxcomposite1 libxdamage1 libxrandr2 libgbm1 libasound2t64 fonts-liberation libgtk-3-0 libdrm2 libxkbcommon0 libxshmfence1 libu2f-udev libvulkan1
stage=$(mktemp -d /tmp/rez-runtime.XXXXXX)
trap 'rm -rf -- "$stage"' EXIT
cd "$stage"
curl --fail --silent --show-error --location --proto '=https' https://nodejs.org/dist/latest-v24.x/SHASUMS256.txt -o SHASUMS256.txt
node_archive=$(awk '$2 ~ /^node-v24\.[0-9]+\.[0-9]+-linux-x64\.tar\.xz$/ {print $2}' SHASUMS256.txt)
test -n "$node_archive"
test "$(printf '%s\n' "$node_archive" | wc -l)" -eq 1
curl --fail --silent --show-error --location --proto '=https' "https://nodejs.org/dist/latest-v24.x/$node_archive" -o "$node_archive"
awk -v name="$node_archive" '$2 == name' SHASUMS256.txt | sha256sum -c -
node_dir=${node_archive%.tar.xz}
if ! test -d "$base/runtime/$node_dir"; then sudo tar -xJf "$node_archive" -C "$base/runtime"; fi
sudo ln -sfn "$base/runtime/$node_dir" "$base/runtime/node"
curl --fail --silent --show-error --location --proto '=https' https://googlechromelabs.github.io/chrome-for-testing/last-known-good-versions-with-downloads.json -o chrome-versions.json
python3 - <<'PY'
import json
from pathlib import Path
d=json.loads(Path('chrome-versions.json').read_text())['channels']['Stable']
u=next(x['url'] for x in d['downloads']['chrome'] if x['platform']=='linux64')
assert u.startswith('https://storage.googleapis.com/chrome-for-testing-public/')
Path('chrome-url').write_text(u)
Path('chrome-version').write_text(d['version'])
PY
chrome_version=$(cat chrome-version)
curl --fail --silent --show-error --location --proto '=https' "$(cat chrome-url)" -o chrome.zip
unzip -q chrome.zip
if ! test -d "$base/runtime/chrome-$chrome_version"; then sudo mv chrome-linux64 "$base/runtime/chrome-$chrome_version"; fi
sudo ln -sfn "$base/runtime/chrome-$chrome_version" "$base/runtime/chrome"
sudo chown root:root "$base/runtime/chrome/chrome_sandbox"
sudo chmod 4755 "$base/runtime/chrome/chrome_sandbox"
chrome_binary=$(readlink -f "$base/runtime/chrome/chrome")
case "$chrome_binary" in /opt/odtu-rez/runtime/chrome-[0-9]*.[0-9]*.[0-9]*.[0-9]*/chrome) ;; *) exit 1 ;; esac
# Ubuntu's shipped Chrome policy allows user namespaces only for its packaged
# path. Apply the same permission to this exact root-owned vendor executable.
# Keep the global restriction and Chromium's own sandbox enabled.
sudo tee /etc/apparmor.d/odtu-rez-chrome >/dev/null <<EOF
abi <abi/4.0>,
include <tunables/global>
profile odtu-rez-chrome $chrome_binary flags=(unconfined) {
  userns,
}
EOF
sudo apparmor_parser -r /etc/apparmor.d/odtu-rez-chrome
"$base/runtime/node/bin/node" --version
"$base/runtime/chrome/chrome" --version
ldd "$base/runtime/chrome/chrome" | awk '/not found/ {bad=1; print} END {exit bad}'
sudo install -d -o rez -g rez -m 0700 /var/lib/odtu-rez/run
echo RUNTIME_READY
