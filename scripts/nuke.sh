#!/usr/bin/env bash
# Wipe the box's contents but keep the box: shred keys and secrets, remove home
# directories, project clones, worktrees, Docker state, and the tailnet
# identity. Passphrase-protected so neither a fat-fingered command nor a
# misfiring agent triggers it by accident -- only the hash lives on the box
# (/etc/seance/nuke.sha256, from tfvars); the passphrase exists only in your
# head. It gates this script, not the capability: the dev user has passwordless
# sudo, so anything running as that user could do the same damage by hand.
#
# The box's own key pair is left in place, so break-glass access survives.
#
# Usage: sudo seance-nuke      (interactive, twice-confirmed)
set -euo pipefail

[[ $EUID -eq 0 ]] || { echo "run with sudo" >&2; exit 1; }
source /etc/seance/seance.env 2>/dev/null || true
DEV_USER="${SEANCE_USER:-dev}"
HASH_FILE=/etc/seance/nuke.sha256
[[ -f "$HASH_FILE" ]] || { echo "no $HASH_FILE; refusing" >&2; exit 1; }

read -rsp "nuke passphrase: " pass; echo
if [[ "$(printf %s "$pass" | sha256sum | cut -d' ' -f1)" != "$(cat "$HASH_FILE")" ]]; then
  echo "wrong passphrase" >&2; exit 1
fi
read -rp "This wipes /home, /srv/projects, /srv/worktrees, Docker, and leaves the tailnet. Type 'nuke' to proceed: " confirm
[[ "$confirm" == "nuke" ]] || { echo "aborted"; exit 1; }

# Every step is best-effort on purpose. find exits 1 on a missing starting
# path, and with set -euo pipefail that would abort the wipe half-done --
# leaving secrets on disk after the script had already claimed to be running.
shred_files() { # shred_files <find args...>
  find "$@" -print0 2>/dev/null | xargs -0 -r shred -u 2>/dev/null || true
}

echo "[nuke] tailscale logout"
tailscale logout || true

echo "[nuke] docker"
if command -v docker >/dev/null; then
  docker ps -q 2>/dev/null | xargs -r docker kill >/dev/null 2>&1 || true
  docker system prune -af --volumes >/dev/null 2>&1 || true
fi

echo "[nuke] shred key material"
shred_files /home -path '*/.ssh/*' -type f
shred_files /home -path '*/.config/seance/*' -type f
shred_files /home -path '*/.aws/*' -type f
shred_files /root/.ssh -type f
shred_files /root/.aws -type f
shred_files /etc/seance/secrets /etc/seance/ca /etc/seance/tls -type f
rm -rf /etc/seance/secrets /etc/seance/ca /etc/seance/tls
rm -f /etc/nginx/conf.d/seance-*.conf
systemctl stop nginx 2>/dev/null || true

echo "[nuke] remove homes, projects and worktrees"
rm -rf /home/* /srv/projects /srv/worktrees /opt/seance

# Your authorized SSH public keys are not secret, and they are the way back in
# once a re-provision rejoins the tailnet. Put them back for dev and ubuntu.
if [[ -s /etc/seance/ssh_authorized_keys ]]; then
  echo "[nuke] restore authorized_keys"
  for u in ubuntu "$DEV_USER"; do
    id "$u" >/dev/null 2>&1 || continue
    h="$(getent passwd "$u" | cut -d: -f6)"
    [[ -n "$h" ]] || continue
    install -d -m 0700 -o "$u" -g "$u" "$h/.ssh"
    install -m 0600 -o "$u" -g "$u" /etc/seance/ssh_authorized_keys "$h/.ssh/authorized_keys"
    echo "  $h/.ssh/authorized_keys"
  done
fi

echo "[nuke] logs"
journalctl --rotate --vacuum-time=1s >/dev/null 2>&1 || true
rm -f /var/log/seance-bootstrap.log
rm -f /var/lib/seance/bootstrapped

echo "[nuke] done. The box is clean and still running. Credentials live in the"
echo "sanctum account, not in user-data, so a re-provision restores it fully --"
echo "the instance role survives the wipe and can still assume the sanctum role:"
echo "  git clone <repo> /opt/seance && sudo /opt/seance/scripts/bootstrap.sh"
echo "That re-pulls the secrets and rejoins the tailnet. With a deSEC token the"
echo "Let's Encrypt cert just re-issues; on the private-CA fallback it mints a NEW"
echo "root, so devices that trusted the old one must trust the new."
