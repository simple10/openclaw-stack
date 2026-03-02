#!/usr/bin/env bash
# install.sh — Bootstrap script for OpenClaw VPS deployment
# Handles the mechanical setup before Claude takes over for interactive configuration.
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/simple10/openclaw-stack/main/install.sh | bash
#   — or —
#   git clone <repo> && cd openclaw-stack && bash install.sh
#
# Idempotent — safe to re-run. Skips steps that are already done.

set -euo pipefail

REPO_URL="https://github.com/simple10/openclaw-stack.git"
REPO_DIR="openclaw-stack"
DEFAULT_SSH_USER="ubuntu"
DEFAULT_SSH_KEY_PATH="$HOME/.ssh/vps1_openclaw_ed25519"

# ── Helpers ──────────────────────────────────────────────────────

info()  { printf '\033[1;34m→\033[0m %s\n' "$*"; }
ok()    { printf '\033[1;32m✓\033[0m %s\n' "$*"; }
warn()  { printf '\033[1;33m!\033[0m %s\n' "$*"; }
err()   { printf '\033[1;31m✗\033[0m %s\n' "$*" >&2; }
ask()   { printf '\033[1;36m?\033[0m %s ' "$1"; read -r "$2"; }

sed_env() {
  # Replace a KEY=value line in .env. Handles empty and populated values.
  local key="$1" val="$2" file=".env"
  if grep -q "^${key}=" "$file" 2>/dev/null; then
    sed -i.bak "s|^${key}=.*|${key}=${val}|" "$file" && rm -f "$file.bak"
  else
    echo "${key}=${val}" >> "$file"
  fi
}

try_ssh() {
  local key="$1" user="$2" ip="$3"
  ssh -i "$key" -o BatchMode=yes -o ConnectTimeout=5 -o StrictHostKeyChecking=accept-new \
    -p 22 "${user}@${ip}" echo "ok" 2>/dev/null
}

# ── Step 1: Prerequisites ────────────────────────────────────────

info "Checking prerequisites..."

missing=()
command -v git  >/dev/null 2>&1 || missing+=(git)
command -v node >/dev/null 2>&1 || missing+=(node)
command -v npm  >/dev/null 2>&1 || missing+=(npm)

if [[ ${#missing[@]} -gt 0 ]]; then
  err "Missing required tools: ${missing[*]}"
  echo "  Install them and re-run this script."
  [[ " ${missing[*]} " == *" node "* ]] && echo "  Node.js ≥22 required: https://nodejs.org"
  exit 1
fi

# Check node version ≥22
node_major=$(node -v | sed 's/v//' | cut -d. -f1)
if [[ "$node_major" -lt 22 ]]; then
  err "Node.js ≥22 required (found $(node -v))"
  echo "  https://nodejs.org"
  exit 1
fi

ok "Prerequisites: git, node $(node -v), npm $(npm -v)"

# ── Step 2: Clone repo (skip if already inside it) ───────────────

if [[ -f "stack.yml.example" && -f ".env.example" ]]; then
  ok "Already inside the repo — skipping clone"
elif [[ -d "$REPO_DIR" ]]; then
  ok "Repo directory exists — entering $REPO_DIR"
  cd "$REPO_DIR"
else
  info "Cloning repository..."
  git clone "$REPO_URL" "$REPO_DIR"
  cd "$REPO_DIR"
  ok "Cloned into $REPO_DIR"
fi

# ── Step 3: npm install ──────────────────────────────────────────

if [[ -d "node_modules" ]]; then
  ok "node_modules exists — skipping npm install"
else
  info "Installing dependencies..."
  npm install
  ok "Dependencies installed"
fi

# ── Step 4: Copy example files ───────────────────────────────────

copy_example() {
  local src="$1" dst="$2"
  if [[ -f "$dst" ]]; then
    ok "$dst already exists — skipping"
  else
    cp "$src" "$dst"
    ok "Created $dst"
  fi
}

info "Setting up config files..."
copy_example ".env.example" ".env"
copy_example "stack.yml.example" "stack.yml"
copy_example "workers/ai-gateway/wrangler.jsonc.example" "workers/ai-gateway/wrangler.jsonc"
copy_example "workers/log-receiver/wrangler.jsonc.example" "workers/log-receiver/wrangler.jsonc"

# ── Step 5: VPS IP address ───────────────────────────────────────

echo ""
info "VPS Configuration"

ask "VPS IP address:" VPS_IP
# Basic IPv4 validation
if ! [[ "$VPS_IP" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  err "Invalid IPv4 address: $VPS_IP"
  exit 1
fi
sed_env "VPS_IP" "$VPS_IP"
ok "VPS_IP=$VPS_IP"

# ── Step 6: Hostname ─────────────────────────────────────────────

ask "VPS hostname [${VPS_IP}]:" HOSTNAME
HOSTNAME="${HOSTNAME:-$VPS_IP}"
sed_env "HOSTNAME" "$HOSTNAME"
ok "HOSTNAME=$HOSTNAME"

# ── Step 7: Root username ────────────────────────────────────────

ask "Initial SSH user [${DEFAULT_SSH_USER}]:" SSH_USER
SSH_USER="${SSH_USER:-$DEFAULT_SSH_USER}"
sed_env "SSH_USER" "$SSH_USER"
ok "SSH_USER=$SSH_USER"

# ── Step 8: SSH key setup ────────────────────────────────────────

# Pre-flight: detect stale known_hosts entry (e.g., VPS reinstalled, IP reused)
if ssh-keygen -F "$VPS_IP" >/dev/null 2>&1; then
  probe_err=$(ssh -o BatchMode=yes -o ConnectTimeout=5 -o StrictHostKeyChecking=yes \
    -p 22 "probe@${VPS_IP}" true 2>&1 || true)
  if echo "$probe_err" | grep -qi "REMOTE HOST IDENTIFICATION HAS CHANGED"; then
    warn "The SSH fingerprint for $VPS_IP has changed since your last connection."
    echo "  This is normal if you reinstalled the VPS or the IP was reassigned."
    ask "Remove the old fingerprint and continue? (y/n) [y]:" REMOVE_FP
    REMOVE_FP="${REMOVE_FP:-y}"
    if [[ "$REMOVE_FP" =~ ^[Yy] ]]; then
      ssh-keygen -R "$VPS_IP" 2>/dev/null
      ok "Removed stale fingerprint for $VPS_IP"
    else
      err "Cannot continue with a mismatched host key. Remove it manually:"
      echo "  ssh-keygen -R $VPS_IP"
      exit 1
    fi
  fi
fi

echo ""
ask "Do you already have passwordless SSH access to this VPS? (y/n) [n]:" HAS_SSH
HAS_SSH="${HAS_SSH:-n}"

SSH_KEY=""

if [[ "$HAS_SSH" =~ ^[Yy] ]]; then
  # Try to find a working key
  info "Looking for SSH keys in ~/.ssh/..."
  found_keys=()
  for pub in "$HOME"/.ssh/*.pub; do
    [[ -f "$pub" ]] || continue
    priv="${pub%.pub}"
    [[ -f "$priv" ]] || continue
    found_keys+=("$priv")
  done

  if [[ ${#found_keys[@]} -eq 0 ]]; then
    warn "No SSH key pairs found in ~/.ssh/"
    ask "Full path to your SSH private key:" SSH_KEY
  else
    info "Found ${#found_keys[@]} key(s). Testing connectivity..."
    for key in "${found_keys[@]}"; do
      info "  Trying $(basename "$key")..."
      if try_ssh "$key" "$SSH_USER" "$VPS_IP"; then
        SSH_KEY="$key"
        ok "  Connected with $(basename "$key")"
        break
      fi
    done

    if [[ -z "$SSH_KEY" ]]; then
      warn "None of the keys in ~/.ssh/ connected successfully."
      ask "Full path to your SSH private key:" SSH_KEY
    fi
  fi

  # Verify the manually-specified key works
  if [[ -n "$SSH_KEY" && ! -f "$SSH_KEY" ]]; then
    err "Key file not found: $SSH_KEY"
    exit 1
  fi

  if [[ -n "$SSH_KEY" ]] && ! try_ssh "$SSH_KEY" "$SSH_USER" "$VPS_IP"; then
    err "Could not connect to ${SSH_USER}@${VPS_IP} with $SSH_KEY"
    echo "  Check that the key is authorized on the VPS and the IP/user are correct."
    exit 1
  fi

else
  # Generate a new key
  if [[ -f "$DEFAULT_SSH_KEY_PATH" ]]; then
    warn "Key already exists at $DEFAULT_SSH_KEY_PATH — reusing"
    SSH_KEY="$DEFAULT_SSH_KEY_PATH"
  else
    info "Generating SSH key..."
    ssh-keygen -t ed25519 -f "$DEFAULT_SSH_KEY_PATH" -C "openclaw-stack" -N ""
    SSH_KEY="$DEFAULT_SSH_KEY_PATH"
    ok "Key created: $SSH_KEY"
  fi

  # Copy to VPS
  info "Copying public key to VPS (you may be prompted for a password)..."
  if ssh-copy-id -i "${SSH_KEY}.pub" -o StrictHostKeyChecking=accept-new -o ConnectTimeout=10 -p 22 "${SSH_USER}@${VPS_IP}"; then
    ok "Public key installed on VPS"
  else
    warn "ssh-copy-id failed. Your provider may have disabled password auth."
    echo ""
    echo "  Add this public key via your VPS provider's dashboard:"
    echo ""
    cat "${SSH_KEY}.pub"
    echo ""
    ask "Press Enter once you've added the key..." _
  fi

  # Verify
  info "Verifying SSH connectivity..."
  if ! try_ssh "$SSH_KEY" "$SSH_USER" "$VPS_IP"; then
    err "Could not connect to ${SSH_USER}@${VPS_IP} with $SSH_KEY"
    echo "  Make sure the public key is authorized on the VPS."
    exit 1
  fi
fi

ok "SSH connectivity verified"
sed_env "SSH_KEY" "$SSH_KEY"
ok "SSH_KEY=$SSH_KEY"

# ── Step 9: Final verification ───────────────────────────────────

echo ""
info "Final connectivity check..."
if try_ssh "$SSH_KEY" "$SSH_USER" "$VPS_IP"; then
  ok "SSH connection to ${SSH_USER}@${VPS_IP} — working"
else
  err "Final SSH verification failed"
  exit 1
fi

# ── Step 10: Summary ─────────────────────────────────────────────

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
ok "Bootstrap complete!"
echo ""
echo "  VPS:       ${SSH_USER}@${VPS_IP}"
echo "  SSH Key:   ${SSH_KEY}"
echo "  Hostname:  ${HOSTNAME}"
echo ""
echo "  Config files created:"
echo "    .env"
echo "    stack.yml"
echo "    workers/ai-gateway/wrangler.jsonc"
echo "    workers/log-receiver/wrangler.jsonc"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

# ── Step 11: Launch Claude onboarding ────────────────────────────

echo ""
if command -v claude >/dev/null 2>&1; then
  info "Launching Claude Code for guided configuration..."
  echo ""
  claude "onboard"
else
  info "Next: Install Claude Code, then run:"
  echo ""
  echo "    cd $(pwd)"
  echo "    claude \"onboard\""
  echo ""
  echo "  This will walk you through domain, Telegram, and stack setup."
  echo ""
fi
