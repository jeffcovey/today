#!/bin/bash
# Setup script for DigitalOcean droplet
# This script is run once on a fresh droplet to install all dependencies

set -e

echo "🚀 Setting up Today app on DigitalOcean droplet..."

# Update system
echo "📦 Updating system packages..."
apt-get update
apt-get upgrade -y

# Install Node.js 20.x
echo "📦 Installing Node.js..."
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt-get install -y nodejs

# Install required system packages
echo "📦 Installing system dependencies..."
apt-get install -y \
    git \
    sqlite3 \
    build-essential \
    python3 \
    curl \
    jq \
    bc \
    tmux \
    syncthing

# Install Claude CLI globally
echo "📦 Installing Claude CLI..."
npm install -g @anthropic-ai/claude-code

# Install dotenvx globally
echo "📦 Installing dotenvx..."
npm install -g @dotenvx/dotenvx

# Create deployment directory
echo "📁 Creating deployment directory..."
mkdir -p /opt/today
mkdir -p /opt/today/.data
mkdir -p /opt/today/vault

# Set up systemd service
echo "⚙️ Setting up systemd service..."
if [ -f /opt/today/config/today-scheduler.service ]; then
    cp /opt/today/config/today-scheduler.service /etc/systemd/system/
    systemctl daemon-reload
    systemctl enable today-scheduler
    echo "✅ Systemd service installed"
fi

# Create a simple update script
cat > /usr/local/bin/update-today << 'EOF'
#!/bin/bash
cd /opt/today
git pull
npm install --production
systemctl restart today-scheduler
echo "✅ Today app updated and restarted"
EOF
chmod +x /usr/local/bin/update-today

# Setup tmux to default to /opt/today
echo "⚙️ Configuring tmux..."
cat > /root/.tmux.conf << 'EOF'
# Default to /opt/today directory for new windows and panes
set -g default-command 'cd /opt/today && exec bash'
EOF

# Setup convenient bash aliases
echo "⚙️ Setting up bash aliases..."
cat >> /root/.bashrc << 'EOF'

# Today app aliases
alias today='cd /opt/today'
alias logs='journalctl -u today-scheduler -f'
alias status='systemctl status today-scheduler'
EOF

echo "✅ Setup complete!"
echo ""
echo "Next steps:"
echo "1. Deploy your code: bin/deploy-do deploy"
echo "2. Copy your secrets: bin/deploy-do secrets"
echo "3. Start the scheduler: systemctl start today-scheduler"
echo ""
echo "Useful commands:"
echo "- Check logs: journalctl -u today-scheduler -f"
echo "- Check status: systemctl status today-scheduler"
echo "- Update app: update-today"