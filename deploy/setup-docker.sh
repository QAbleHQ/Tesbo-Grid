#!/usr/bin/env bash
# Idempotent Docker + Docker Compose installation for Ubuntu droplets.
# Usage: setup-docker.sh
set -euxo pipefail

if command -v docker &>/dev/null && docker compose version &>/dev/null; then
  echo "✓ Docker already installed: $(docker --version)"
  exit 0
fi

echo "▸ Installing Docker Engine + Compose plugin"
export DEBIAN_FRONTEND=noninteractive

apt-get update -y
apt-get install -y ca-certificates curl gnupg

install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg \
  | gpg --dearmor --yes -o /etc/apt/keyrings/docker.gpg
chmod a+r /etc/apt/keyrings/docker.gpg

echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] \
https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" \
  > /etc/apt/sources.list.d/docker.list

apt-get update -y
apt-get install -y docker-ce docker-ce-cli containerd.io \
  docker-buildx-plugin docker-compose-plugin

systemctl enable --now docker

echo "✓ Docker installed: $(docker --version)"
docker compose version
