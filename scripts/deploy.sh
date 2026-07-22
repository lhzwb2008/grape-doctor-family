#!/usr/bin/env bash
# 部署葡萄个人助手家庭版到远程服务器
# 用法: SSHPASS='xxx' ./scripts/deploy.sh
set -euo pipefail

HOST="${DEPLOY_HOST:-101.201.237.149}"
USER="${DEPLOY_USER:-root}"
REMOTE_DIR="${DEPLOY_DIR:-/opt/grape-doctor}"
PORT="${DEPLOY_PORT:-8765}"
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

echo "==> 远程安装并启动 systemd 服务…"
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

systemctl daemon-reload
systemctl enable grape-doctor >/dev/null
systemctl restart grape-doctor
sleep 2
systemctl --no-pager --full status grape-doctor | head -18
curl -sf http://127.0.0.1:${PORT}/api/health
echo
echo "访问地址: http://${HOST}:${PORT}"
EOF
