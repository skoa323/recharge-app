#!/bin/bash
# ================================================================
# 充值代理服务 · Ubuntu/Debian VPS 一键部署脚本
# ================================================================
# 使用方法:
#   1. 在服务器上 root 用户执行: bash deploy.sh
#   2. 脚本会询问你的域名、API Key、访问口令
#   3. 执行完成后,访问 https://你的域名 即可
# ================================================================

set -e

echo ""
echo "============================================================"
echo "  ChatGPT 代理充值服务 · 一键部署"
echo "============================================================"
echo ""

# 1. 收集配置
read -p "请输入你的域名(已解析到本机 IP,例:recharge.example.com): " DOMAIN
read -p "请输入上游 API Key(ak_live_xxx): " API_KEY
read -p "请输入访问口令(用户访问页面时要输入,自己想一个长随机串): " ACCESS_PASS
read -p "请输入服务运行端口[3000]: " PORT
PORT=${PORT:-3000}

if [ -z "$DOMAIN" ] || [ -z "$API_KEY" ] || [ -z "$ACCESS_PASS" ]; then
  echo "✗ 域名 / API Key / 访问口令 不能为空"
  exit 1
fi

echo ""
echo "确认配置:"
echo "  域名:        $DOMAIN"
echo "  API Key:     ${API_KEY:0:12}******"
echo "  访问口令:    ${ACCESS_PASS:0:3}******"
echo "  端口:        $PORT"
echo ""
read -p "确认开始部署?[Y/n] " CONFIRM
[ "$CONFIRM" = "n" ] && exit 0

# 2. 安装 Node.js 20
if ! command -v node &> /dev/null || [ "$(node -v | cut -d. -f1 | tr -d v)" -lt 18 ]; then
  echo ">>> 安装 Node.js 20..."
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt install -y nodejs
fi
echo "✓ Node.js: $(node -v)"

# 3. 安装 Caddy
if ! command -v caddy &> /dev/null; then
  echo ">>> 安装 Caddy..."
  apt install -y debian-keyring debian-archive-keyring apt-transport-https curl gnupg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' > /etc/apt/sources.list.d/caddy-stable.list
  apt update
  apt install -y caddy
fi
echo "✓ Caddy: $(caddy version | head -1)"

# 4. 部署项目文件
APP_DIR=/opt/recharge-app
echo ">>> 部署到 $APP_DIR..."

if [ ! -d "$APP_DIR" ]; then
  mkdir -p "$APP_DIR"
fi

# 假设 deploy.sh 和 package.json 在同目录,把整个项目复制过去
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cp -r "$SCRIPT_DIR/server" "$APP_DIR/"
cp -r "$SCRIPT_DIR/public" "$APP_DIR/"
cp "$SCRIPT_DIR/package.json" "$APP_DIR/"

cd "$APP_DIR"
npm install --production --silent
chown -R www-data:www-data "$APP_DIR"
echo "✓ 依赖已安装"

# 5. 创建 systemd 服务
echo ">>> 配置 systemd 服务..."
cat > /etc/systemd/system/recharge.service <<EOF
[Unit]
Description=ChatGPT Recharge Proxy
After=network.target

[Service]
Type=simple
WorkingDirectory=$APP_DIR
ExecStart=/usr/bin/node server/server.js
Restart=always
RestartSec=5
User=www-data

Environment="PORT=$PORT"
Environment="HOST=127.0.0.1"
Environment="UPSTREAM_API_KEY=$API_KEY"
Environment="UPSTREAM_UA=my-agent-client/1.0"
Environment="ACCESS_PASS=$ACCESS_PASS"
Environment="ALLOWED_ORIGIN=https://$DOMAIN"

NoNewPrivileges=true
PrivateTmp=true

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable recharge >/dev/null
systemctl restart recharge
sleep 2
echo "✓ recharge.service 已启动"

# 6. 配置 Caddy
echo ">>> 配置 Caddy 反向代理 + HTTPS..."
cat > /etc/caddy/Caddyfile <<EOF
$DOMAIN {
    reverse_proxy 127.0.0.1:$PORT
    encode gzip
    log {
        output file /var/log/caddy/recharge.log
        format json
    }
}
EOF

mkdir -p /var/log/caddy
chown caddy:caddy /var/log/caddy
systemctl reload caddy
echo "✓ Caddy 已配置(自动申请 HTTPS 证书)"

# 7. 防火墙
if command -v ufw &> /dev/null; then
  ufw allow 80/tcp >/dev/null 2>&1 || true
  ufw allow 443/tcp >/dev/null 2>&1 || true
  ufw allow 22/tcp >/dev/null 2>&1 || true
  echo "✓ 防火墙已放行 80/443/22"
fi

# 8. 完成
echo ""
echo "============================================================"
echo "  ✓ 部署完成!"
echo "============================================================"
echo ""
echo "  访问地址:  https://$DOMAIN"
echo "  访问口令:  $ACCESS_PASS"
echo ""
echo "  常用命令:"
echo "    systemctl status recharge      # 查看状态"
echo "    systemctl restart recharge     # 重启服务"
echo "    journalctl -u recharge -f      # 看实时日志"
echo "    journalctl -u recharge -n 100  # 看最近100行"
echo ""
echo "  首次访问 HTTPS 可能需要等 30 秒,Caddy 在申请证书。"
echo "============================================================"
