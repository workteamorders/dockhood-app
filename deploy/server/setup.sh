#!/usr/bin/env bash
# One-shot setup for a fresh Ubuntu server (Oracle Cloud Always Free Arm works). Run as the normal user, not root:
#   git clone -b feat/dockhood-rebrand https://github.com/workteamorders/dockhood-app.git && cd dockhood-app
#   bash deploy/server/setup.sh
# It installs Docker, opens ports 80/443, writes deploy/server/.env (mode 600) and starts the stack.
set -euo pipefail
cd "$(dirname "$0")/../.."

FACTORY=0x9B78f8878fb269CdDAEdfFe9Eb00368d90BF9095
START_BLOCK=140875036
RPC=${TESTNET_RPC_URL:-https://robinhood-testnet.drpc.org}
WEB_ORIGIN=${WEB_ORIGIN:-https://dockhood-app-web.vercel.app}
ENV_FILE=deploy/server/.env

if ! command -v docker >/dev/null; then
  echo "Installing Docker..."
  curl -fsSL https://get.docker.com | sudo sh
  sudo usermod -aG docker "$USER"
fi
DOCKER="sudo docker"

echo "Opening ports 80 and 443 in the server firewall..."
for p in 80 443; do
  sudo iptables -C INPUT -p tcp --dport "$p" -j ACCEPT 2>/dev/null || sudo iptables -I INPUT 1 -p tcp --dport "$p" -j ACCEPT
done
if command -v netfilter-persistent >/dev/null; then sudo netfilter-persistent save >/dev/null
else sudo DEBIAN_FRONTEND=noninteractive apt-get install -y iptables-persistent >/dev/null && sudo netfilter-persistent save >/dev/null; fi

if [ -f "$ENV_FILE" ]; then
  echo "$ENV_FILE already exists; keeping it (delete it to regenerate)."
else
  IP=$(curl -fsS https://api.ipify.org)
  HOSTNAME_API="${IP//./-}.sslip.io"
  read -r -s -p "Paste PROXY_SECRET (same value as Vercel, input hidden): " PROXY_SECRET; echo
  [ "${#PROXY_SECRET}" -ge 32 ] || { echo "PROXY_SECRET must be at least 32 characters."; exit 1; }
  umask 077
  cat > "$ENV_FILE" <<ENV
API_HOST=$HOSTNAME_API
CORS_ORIGINS=$WEB_ORIGIN
TESTNET_FACTORY_ADDRESS=$FACTORY
TESTNET_START_BLOCK=$START_BLOCK
TESTNET_RPC_URL=$RPC
TESTNET_HASURA_ADMIN_SECRET=$(openssl rand -hex 32)
SESSION_SECRET=$(openssl rand -hex 32)
PROXY_SECRET=$PROXY_SECRET
ENV
fi

COMPOSE="$DOCKER compose -f docker-compose.testnet.yml -f deploy/server/docker-compose.server.yml --env-file $ENV_FILE --profile indexer"
$COMPOSE up -d --build
sleep 20
$COMPOSE ps

HOST=$(grep '^API_HOST=' "$ENV_FILE" | cut -d= -f2)
echo
echo "API address: https://$HOST"
echo "Test it:     curl -s https://$HOST/health"
echo "Vercel variables to add, then redeploy without build cache:"
echo "  API_PROXY_TARGET=https://$HOST"
echo "  NEXT_PUBLIC_WS_URL=wss://$HOST/ws"
