#!/bin/bash
set -eo pipefail

NODE_VERSION="${NODE_VERSION:-24.13.0}"
PNPM_VERSION="${PNPM_VERSION:-10.28.0}"
NVM_VERSION="${NVM_VERSION:-0.40.2}"

# Helper to run with sudo if needed and available
run_privileged() {
  if [ "$(id -u)" -eq 0 ]; then
    "$@"
  elif command -v sudo >/dev/null 2>&1; then
    sudo "$@"
  else
    "$@"
  fi
}

echo "Installing Doppler CLI"
(curl -Ls --tlsv1.2 --proto "=https" --retry 3 https://cli.doppler.com/install.sh || wget -t 3 -qO- https://cli.doppler.com/install.sh) | run_privileged sh

echo "Installing NVM v${NVM_VERSION}"
export NVM_DIR="$HOME/.nvm"
if [[ ! -s "$NVM_DIR/nvm.sh" ]]; then
  curl -o- "https://raw.githubusercontent.com/nvm-sh/nvm/v${NVM_VERSION}/install.sh" | bash
fi
# shellcheck disable=SC1091
source "$NVM_DIR/nvm.sh"

echo "Installing Node.js v${NODE_VERSION}"
nvm install "$NODE_VERSION"
nvm use "$NODE_VERSION"

echo "Configuring pnpm v${PNPM_VERSION} via Corepack"
corepack enable || run_privileged corepack enable
corepack prepare "pnpm@${PNPM_VERSION}" --activate

echo "Setting up Doppler (using DOPPLER_TOKEN env var)"
doppler setup --project os --config dev_codex

echo "Installing workspace dependencies"
pnpm install

echo "Running pnpm typecheck"
pnpm typecheck

echo "Running pnpm lint"
pnpm lint

echo "Running pnpm format"
pnpm format

echo "Running pnpm test"
pnpm test

echo "Sandbox setup complete"
