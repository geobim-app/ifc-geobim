#!/bin/bash
# Einmalige Einrichtung des eingeschränkten Deploy-Schlüssels für ifc.geobim.app.
# Auf dem Server als root ausführen:  bash /tmp/ifc-deploy-setup/setup-server.sh
# Kann gefahrlos mehrfach laufen.
set -euo pipefail

SRC="$(cd "$(dirname "$0")" && pwd)"
PUBKEY='ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIC0AkGNPzU2yNuD3sSM1qF1NMvgmJbYE111USviWkgLC claude ifc.geobim.app deploy (christof-pc)'
KEYLINE="restrict,command=\"/usr/local/bin/ifc-geobim-deploy-ssh\" $PUBKEY"

[ "$(id -u)" = 0 ] || { echo "Bitte als root ausführen" >&2; exit 1; }

echo "== 1/5 Skripte installieren"
install -o root -g root -m 755 "$SRC/ifc-geobim-deploy"     /usr/local/bin/ifc-geobim-deploy
install -o root -g root -m 755 "$SRC/ifc-geobim-deploy-ssh" /usr/local/bin/ifc-geobim-deploy-ssh

echo "== 2/5 User 'deploy'"
if id deploy >/dev/null 2>&1; then
  echo "   existiert schon, wird mitbenutzt"
else
  adduser --disabled-password --gecos "" deploy
fi

echo "== 3/5 sudo-Regel"
cat > /etc/sudoers.d/ifc-geobim-deploy <<'EOF'
deploy ALL=(root) NOPASSWD: /usr/local/bin/ifc-geobim-deploy status, /usr/local/bin/ifc-geobim-deploy deploy, /usr/local/bin/ifc-geobim-deploy rollback
EOF
chmod 440 /etc/sudoers.d/ifc-geobim-deploy
visudo -c -q || { echo "sudoers fehlerhaft — Datei wird entfernt" >&2; rm -f /etc/sudoers.d/ifc-geobim-deploy; exit 1; }

echo "== 4/5 Schlüssel in ~deploy/.ssh/authorized_keys"
DHOME="$(getent passwd deploy | cut -d: -f6)"
install -d -o deploy -g deploy -m 700 "$DHOME/.ssh"
touch "$DHOME/.ssh/authorized_keys"
chown deploy:deploy "$DHOME/.ssh/authorized_keys"
chmod 600 "$DHOME/.ssh/authorized_keys"
if grep -qF "$PUBKEY" "$DHOME/.ssh/authorized_keys"; then
  echo "   schon eingetragen"
else
  echo "$KEYLINE" >> "$DHOME/.ssh/authorized_keys"
  echo "   eingetragen"
fi

if sshd -T 2>/dev/null | grep -qiE '^allowusers'; then
  echo "   ACHTUNG: sshd hat AllowUsers gesetzt:"
  sshd -T | grep -iE '^allowusers'
  echo "   'deploy' muss dort stehen, sonst wird der Schlüssel abgewiesen."
fi

echo "== 5/5 Testlauf (nur lesen)"
/usr/local/bin/ifc-geobim-deploy status

echo
echo "Fertig. Fehlt oben der Ion-Token, jetzt eintragen:"
echo "   nano /var/www/ifclite-fork/apps/viewer/.env.local"
