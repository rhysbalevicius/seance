#!/usr/bin/env bash
# seance bootstrap. Idempotent: run at first boot by user-data, re-run any
# time with `cd /opt/seance && sudo git pull && sudo scripts/bootstrap.sh`.
#
# Reads /etc/seance/seance.env (non-secret config from user-data) and the
# root-only files under /etc/seance/secrets, which it fetches from the sanctum
# account itself via seance-secrets. Nothing in this file is sensitive.
set -euo pipefail

[[ $EUID -eq 0 ]] || { echo "run as root" >&2; exit 1; }
source /etc/seance/seance.env

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEV_USER="${SEANCE_USER:-dev}"   # login account; set via dev_user in tfvars
DEV_HOME=/home/$DEV_USER
log() { echo "[bootstrap] $*"; }

# --- Base packages ----------------------------------------------------------

export DEBIAN_FRONTEND=noninteractive
alias apt-get='apt-get -o DPkg::Lock::Timeout=300'
shopt -s expand_aliases
log "apt packages"
apt-get update -y
apt-get install -y --no-install-recommends \
  build-essential ca-certificates curl git gnupg jq ripgrep sqlite3 tmux \
  unzip zip python3-pip python3-venv fonts-liberation

# AWS CLI v2 (apt ships v1)
if ! command -v aws >/dev/null || ! aws --version 2>&1 | grep -q "aws-cli/2"; then
  log "aws cli v2"
  curl -fsSL "https://awscli.amazonaws.com/awscli-exe-linux-x86_64.zip" -o /tmp/awscliv2.zip
  unzip -qo /tmp/awscliv2.zip -d /tmp
  /tmp/aws/install --update
  rm -rf /tmp/aws /tmp/awscliv2.zip
fi

# Docker (official repo: current engine + compose v2 plugin)
if ! command -v docker >/dev/null; then
  log "docker"
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] \
    https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" \
    > /etc/apt/sources.list.d/docker.list
  apt-get update -y
  apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
fi

# Node 22 (Claude Code + Playwright + most frontend work)
if ! command -v node >/dev/null || [[ "$(node -v | cut -c2-3)" -lt 22 ]]; then
  log "node 22"
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
fi

# --- Sanctum account credentials: AWS profile 'sanctum' ---------------------
# credential_process helper: the instance role (base creds via IMDSv2) assumes
# the sanctum role on demand. Every cross-account action is then just
# `aws --profile sanctum ...` -- no static keys anywhere on the box.

log "sanctum credential helper"
install -m 0755 "$REPO_DIR/scripts/seance-sanctum-creds" /usr/local/bin/seance-sanctum-creds
mkdir -p /root/.aws
cat > /root/.aws/config <<EOF
[profile sanctum]
credential_process = /usr/local/bin/seance-sanctum-creds
region = $SANCTUM_REGION
EOF

# --- Secrets from the sanctum account ---------------------------------------
# sops decrypts with a KMS key reachable only through the sanctum role, so the
# box needs no passphrase and nothing sensitive ever rides in user_data.
# Everything below this point reads the files seance-secrets writes.

if ! sops --version --disable-version-check 2>/dev/null | grep -q "${SOPS_VERSION#v}"; then
  log "sops ${SOPS_VERSION}"
  curl -fsSL "https://github.com/getsops/sops/releases/download/${SOPS_VERSION}/sops-${SOPS_VERSION}.linux.amd64" -o /tmp/sops
  install -m 0755 /tmp/sops /usr/local/bin/sops
  rm -f /tmp/sops
fi

log "secrets"
"$REPO_DIR/scripts/secrets.sh" pull

SECRETS=/etc/seance/secrets
get_secret() { # get_secret <filename>
  cat "$SECRETS/$1" 2>/dev/null || true
}

# --- Dev user ---------------------------------------------------------------
# Created BEFORE anything writes into $DEV_HOME, so useradd -m lays down skel.

if ! id "$DEV_USER" >/dev/null 2>&1; then
  log "user $DEV_USER"
  useradd -m -s /bin/bash "$DEV_USER"
fi
usermod -aG docker "$DEV_USER"
# The box is a sandbox by design (no personal documents); the agent gets full
# sudo so provisioning-ish tasks don't need a human. Remove this file if you
# ever change that stance.
echo "$DEV_USER ALL=(ALL) NOPASSWD:ALL" > /etc/sudoers.d/90-seance-dev
chmod 0440 /etc/sudoers.d/90-seance-dev
mkdir -p "$DEV_HOME/.aws"
cp /root/.aws/config "$DEV_HOME/.aws/config"
chown -R "$DEV_USER:$DEV_USER" "$DEV_HOME/.aws"

# Your SSH keys (from tfvars via user-data) go on the dev user, so you reach
# the box as dev over the tailnet. Appended, not clobbered, so a key you added
# by hand on the box survives a re-provision.
if [[ -s /etc/seance/ssh_authorized_keys ]]; then
  log "authorized_keys for $DEV_USER"
  install -d -m 0700 -o "$DEV_USER" -g "$DEV_USER" "$DEV_HOME/.ssh"
  ak="$DEV_HOME/.ssh/authorized_keys"
  touch "$ak"
  # `|| [[ -n "$key" ]]` so the last key isn't dropped when the file has no
  # trailing newline -- user_data writes the keys without one.
  while IFS= read -r key || [[ -n "$key" ]]; do
    [[ -n "$key" ]] || continue
    grep -qxF "$key" "$ak" || echo "$key" >> "$ak"
  done < /etc/seance/ssh_authorized_keys
  chown "$DEV_USER:$DEV_USER" "$ak"
  chmod 0600 "$ak"
fi

# --- Tailscale --------------------------------------------------------------

if ! command -v tailscale >/dev/null; then
  log "tailscale"
  curl -fsSL https://tailscale.com/install.sh | sh
fi
if ! tailscale status >/dev/null 2>&1; then
  TS_AUTHKEY="$(get_secret tailscale-authkey)"
  if [[ -n "$TS_AUTHKEY" ]]; then
    log "tailscale up"
    # No --ssh: access is conventional key-based SSH over the tailnet, against
    # the keys in the dev user's authorized_keys. Tailscale SSH would intercept
    # tailnet :22 and bypass those keys.
    tailscale up --authkey "$TS_AUTHKEY" --hostname "$SEANCE_NAME"
  else
    log "WARNING: no $SECRETS/tailscale-authkey; run 'tailscale up' manually"
  fi
fi

# --- Secrets -> dev environment ---------------------------------------------
# $SECRETS/env holds shell-quoted KEY=value lines. fetch-secrets copies it
# into the dev user's home; re-run it after a `seance-secrets pull`.

log "secrets"
sudo -u "$DEV_USER" "$REPO_DIR/scripts/fetch-secrets.sh" || \
  log "WARNING: fetch-secrets failed (is $SECRETS/env present?)"
if ! grep -q 'config/seance/env' "$DEV_HOME/.profile" 2>/dev/null; then
  cat >> "$DEV_HOME/.profile" <<'EOF'
# seance: session secrets pulled from the sanctum account
if [ -f "$HOME/.config/seance/env" ]; then set -a; . "$HOME/.config/seance/env"; set +a; fi
EOF
fi

# --- Git profiles -----------------------------------------------------------
# $SECRETS/git-profiles.json is a JSON array, from the git_profiles key of the
# decrypted secrets file:
#   [{"id":"personal","name":"Your Name","email":"you@example.com",
#     "ssh_key":"<an ed25519 private key, newlines and all>"}, ...]
# Each profile gets an SSH host alias gh-<id> and an includeIf gitconfig
# scoped to /srv/projects/<id>/, so identity follows directory layout.

GIT_PROFILES="$(get_secret git-profiles.json)"
if [[ -n "$GIT_PROFILES" ]]; then
  log "git profiles"
  install -d -m 0700 -o "$DEV_USER" -g "$DEV_USER" "$DEV_HOME/.ssh"
  : > "$DEV_HOME/.gitconfig"
  echo "$GIT_PROFILES" | jq -c '.[]' | while read -r p; do
    pid=$(echo "$p" | jq -r .id)
    echo "$p" | jq -r .ssh_key > "$DEV_HOME/.ssh/${pid}_ed25519"
    chmod 600 "$DEV_HOME/.ssh/${pid}_ed25519"
    if ! grep -q "Host gh-$pid" "$DEV_HOME/.ssh/config" 2>/dev/null; then
      cat >> "$DEV_HOME/.ssh/config" <<EOF
Host gh-$pid
  HostName github.com
  User git
  IdentityFile ~/.ssh/${pid}_ed25519
  IdentitiesOnly yes
  StrictHostKeyChecking accept-new
EOF
    fi
    mkdir -p "/srv/projects/$pid"
    cat > "$DEV_HOME/.gitconfig-$pid" <<EOF
[user]
  name = $(echo "$p" | jq -r .name)
  email = $(echo "$p" | jq -r .email)
EOF
    cat >> "$DEV_HOME/.gitconfig" <<EOF
[includeIf "gitdir:/srv/projects/$pid/"]
  path = ~/.gitconfig-$pid
EOF
  done
  chmod 600 "$DEV_HOME/.ssh/config" 2>/dev/null || true
fi
mkdir -p /srv/projects
chown -R "$DEV_USER:$DEV_USER" /srv/projects "$DEV_HOME/.ssh" 2>/dev/null || true
chown "$DEV_USER:$DEV_USER" "$DEV_HOME"/.gitconfig* 2>/dev/null || true

# --- Agent tooling ----------------------------------------------------------
# Which coding-agent CLIs to install comes from tfvars (AGENTS). Claude Code
# on the Max subscription needs no API key -- see README "Agent auth".

log "agent CLIs: ${AGENTS:-claude}"
sudo -u "$DEV_USER" mkdir -p "$DEV_HOME/.local/bin"   # cursor installs here; on PATH via .profile
AGENTS="${AGENTS:-claude}" "$REPO_DIR/scripts/agents.sh" install || \
  log "WARNING: one or more agent installs failed; retry with 'sudo seance-agents install <name>'"

log "herdr"
sudo -u "$DEV_USER" bash -c 'command -v herdr >/dev/null || curl -fsSL https://herdr.dev/install.sh | sh' || \
  log "WARNING: herdr install failed; install manually later"

# Playwright + headless Chromium: how the agent screenshots frontend work.
# Global install so `playwright screenshot` resolves from any cwd; system
# deps as root, browser binary under the dev user's cache.
log "playwright + chromium"
npm install -g playwright >/dev/null
playwright install-deps chromium >/dev/null 2>&1 || apt-get install -y libnss3 libatk-bridge2.0-0 libgtk-3-0 libgbm1 libasound2t64
sudo -u "$DEV_USER" playwright install chromium >/dev/null

# --- Vanity hostnames: nginx + wildcard TLS ---------------------------------
# One-time DNS at your DNS provider: A $VANITY_DOMAIN and A *.$VANITY_DOMAIN ->
# this box's Tailscale IP (seance-ca status prints the IP). Then any
# <name>.$VANITY_DOMAIN is live the moment nginx knows about it -- agents mint
# preview hostnames on the fly (seance-expose add <name> <port>). TLS is set up
# by seance-cert: a real Let's Encrypt wildcard over the deSEC DNS-01 challenge
# when a desec_token secret is present (publicly trusted, auto-renewing), else a
# self-signed private CA trusted once per device (seance-ca). See README.

if [[ -n "${VANITY_DOMAIN:-}" ]]; then
  log "vanity domain: $VANITY_DOMAIN"
  apt-get install -y nginx openssl

  "$REPO_DIR/scripts/cert.sh" ensure

  # nginx: exposed apps get vhosts in conf.d/seance-*.conf; everything else 444
  rm -f /etc/nginx/sites-enabled/default
  cat > /etc/nginx/conf.d/seance-catchall.conf <<EOF
server {
    listen 443 ssl default_server;
    server_name _;
    ssl_certificate     /etc/seance/tls/fullchain.pem;
    ssl_certificate_key /etc/seance/tls/privkey.pem;
    return 444;
}
server {
    listen 80 default_server;
    server_name _;
    return 301 https://\$host\$request_uri;
}
EOF
  systemctl enable --now nginx
  systemctl reload nginx || true
fi

# --- Helper commands on PATH ------------------------------------------------

log "helpers"
for s in expose.sh screenshot.sh push-artifact.sh secrets.sh fetch-secrets.sh clone-projects.sh worktree.sh setup-project.sh ca.sh cert.sh agents.sh collie.sh nuke.sh; do
  install -m 0755 "$REPO_DIR/scripts/$s" "/usr/local/bin/seance-${s%.sh}"
done
mkdir -p /etc/seance
install -m 0644 "$REPO_DIR/config/setup-project.prompt.md" /etc/seance/setup-project.prompt.md

# Work-item tooling. Built here rather than committed, so the repository holds
# no build output; a failure degrades wsk and leaves the rest of the box alone,
# matching how agent installs are treated above.
log "work-item tooling"
install -d -m 0755 /etc/seance/style /etc/seance/templates /etc/seance/claude
install -m 0644 "$REPO_DIR/config/style/"*        /etc/seance/style/
install -m 0644 "$REPO_DIR/config/templates/"*    /etc/seance/templates/
install -m 0644 "$REPO_DIR/config/claude/"*       /etc/seance/claude/
[ -f /etc/seance/profiles.json ] || \
  install -m 0644 "$REPO_DIR/config/profiles.example.json" /etc/seance/profiles.json
if npm --prefix "$REPO_DIR/wsk" ci --no-audit --no-fund >/dev/null 2>&1 \
   && npm --prefix "$REPO_DIR/wsk" run build >/dev/null 2>&1; then
  install -m 0755 "$REPO_DIR/scripts/wsk" /usr/local/bin/wsk
  sudo -u "$DEV_USER" /usr/local/bin/wsk install || \
    log "WARNING: wsk could not fetch its helper binaries; run 'wsk install' later"
else
  log "WARNING: wsk build failed; the box is fine, but 'wsk' is unavailable"
fi
mkdir -p /srv/worktrees && chown "$DEV_USER:$DEV_USER" /srv/worktrees
chmod 0600 /etc/seance/nuke.sha256 2>/dev/null || true

# --- collie: phone UI for herdr, at collie.$VANITY_DOMAIN -------------------
# Needs nginx (vanity block above), herdr, and seance-expose (just installed),
# so it runs here. Non-fatal: a first-boot herdr/systemd hiccup shouldn't fail
# the whole provision -- re-runnable by hand as 'sudo seance-collie'.

if [[ -n "${VANITY_DOMAIN:-}" ]]; then
  log "collie"
  /usr/local/bin/seance-collie || \
    log "WARNING: collie setup failed; run 'sudo seance-collie' after first 'herdr' login"
fi

# --- Projects ---------------------------------------------------------------
# /etc/seance/projects.json lists repos to clone. Repo URLs are not secret;
# the deploy keys that reach them come from the sanctum.

# GitHub's host key has to be known before the non-interactive clone, or ssh
# fails host-key verification (there's no TTY at boot to accept it). Idempotent.
sudo -u "$DEV_USER" bash -c 'install -d -m 0700 ~/.ssh; ssh-keygen -F github.com >/dev/null 2>&1 || ssh-keyscan -t rsa,ed25519 github.com >> ~/.ssh/known_hosts 2>/dev/null'

log "projects"
sudo -u "$DEV_USER" /usr/local/bin/seance-clone-projects || \
  log "WARNING: clone-projects failed (is /etc/seance/projects.json present?)"

mkdir -p /var/lib/seance && date -u +%FT%TZ > /var/lib/seance/bootstrapped
log "done. ssh $DEV_USER@$SEANCE_NAME (over Tailscale) and run 'herdr'."
