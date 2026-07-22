#!/usr/bin/env bash
# 部署葡萄个人助手家庭版到远程服务器
# 用法: SSHPASS='xxx' ./scripts/deploy.sh
set -euo pipefail

HOST="${DEPLOY_HOST:-101.201.237.149}"
USER="${DEPLOY_USER:-root}"
REMOTE_DIR="${DEPLOY_DIR:-/opt/grape-doctor}"
PORT="${DEPLOY_PORT:-8765}"
HTTPS_HOST="${DEPLOY_HTTPS_HOST:-${HOST}.sslip.io}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

if [[ -z "${SSHPASS:-}" ]]; then
  echo "请设置环境变量 SSHPASS=服务器密码"
  exit 1
fi

RSYNC=(sshpass -e rsync -avz -e "ssh -o StrictHostKeyChecking=accept-new")
SSH=(sshpass -e ssh -o StrictHostKeyChecking=accept-new)

echo "==> 停止远程服务（如已运行）…"
"${SSH[@]}" "${USER}@${HOST}" "systemctl stop grape-doctor 2>/dev/null || true"

echo "==> 同步代码到 ${REMOTE_DIR}…"
"${RSYNC[@]}" --delete \
  --exclude '.venv' \
  --exclude '__pycache__' \
  --exclude 'data/' \
  --exclude '.git' \
  --exclude '*.pyc' \
  --exclude '.DS_Store' \
  --exclude '.cursor' \
  --exclude '.deploy.secret' \
  "${ROOT}/" "${USER}@${HOST}:${REMOTE_DIR}/"

echo "==> 远程安装并启动 systemd 服务 + HTTPS…"
"${SSH[@]}" "${USER}@${HOST}" "bash -s" <<EOF
set -e
cd ${REMOTE_DIR}
python3 -m venv .venv
. .venv/bin/activate
pip install -q -r requirements.txt
mkdir -p data/users data/sessions

cat > /etc/systemd/system/grape-doctor.service <<UNIT
[Unit]
Description=Grape Family Doctor Assistant
After=network.target

[Service]
Type=simple
WorkingDirectory=${REMOTE_DIR}
EnvironmentFile=${REMOTE_DIR}/.env
ExecStart=${REMOTE_DIR}/.venv/bin/python -m uvicorn backend.main:app --host 0.0.0.0 --port ${PORT}
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
UNIT

# Caddy：为微信/浏览器录音提供 HTTPS 安全上下文
if ! command -v caddy >/dev/null 2>&1; then
  echo "安装 Caddy…"
  curl -fsSL "https://caddyserver.com/api/download?os=linux&arch=amd64" -o /usr/local/bin/caddy
  chmod +x /usr/local/bin/caddy
fi
mkdir -p /etc/caddy
cat > /etc/caddy/Caddyfile <<CADDY
${HTTPS_HOST} {
  encode gzip
  reverse_proxy 127.0.0.1:${PORT}
}

http:// {
  redir https://${HTTPS_HOST}{uri} permanent
}
CADDY

cat > /etc/systemd/system/caddy.service <<UNIT
[Unit]
Description=Caddy HTTPS reverse proxy for grape-doctor
After=network.target grape-doctor.service
Wants=grape-doctor.service

[Service]
Type=simple
ExecStart=/usr/local/bin/caddy run --config /etc/caddy/Caddyfile --adapter caddyfile
ExecReload=/usr/local/bin/caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile
Restart=always
RestartSec=3
LimitNOFILE=1048576
AmbientCapabilities=CAP_NET_BIND_SERVICE
CapabilityBoundingSet=CAP_NET_BIND_SERVICE

[Install]
WantedBy=multi-user.target
UNIT

systemctl daemon-reload
systemctl enable grape-doctor caddy >/dev/null
systemctl restart grape-doctor
sleep 1
systemctl restart caddy
sleep 4
systemctl --no-pager --full status grape-doctor | head -14
systemctl --no-pager --full status caddy | head -16
curl -sf http://127.0.0.1:${PORT}/api/health
echo
curl -sfk https://127.0.0.1/api/health -H "Host: ${HTTPS_HOST}" || echo "(HTTPS 健康检查稍后可用，请确认安全组已放行 80/443)"
echo
echo "文字聊天可用: http://${HOST}:${PORT}"
echo "语音请用 HTTPS: https://${HTTPS_HOST}"
EOF
