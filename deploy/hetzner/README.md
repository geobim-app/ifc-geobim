# Deploy ifc.geobim.app (Hetzner)

ifc.geobim.app wird **auf dem Server gebaut**: Apache liefert
`/var/www/ifclite-fork/apps/viewer/dist` direkt aus. Vercel spielt keine Rolle.

```
lokal ändern → Commit → git push (feat/cesium-ion-export)
  → ssh ifc-deploy deploy     → ifc.geobim.app
```

Ein eigener Schlüssel (`~/.ssh/ifc_geobim_deploy`) darf per Forced Command nur
drei Befehle auslösen, keine Shell, keine Weiterleitungen:

| Befehl | Wirkung |
|---|---|
| `ssh ifc-deploy status` | nur lesen: Commit, Branch, lokale Änderungen, Alter von `dist`, ob der Ion-Token gesetzt ist, und welcher Commit tatsächlich ausgeliefert wird (`dist/.build-commit`; nach `rollback` steht dort `ACHTUNG … Build ≠ HEAD`) |
| `ssh ifc-deploy deploy` | `git fetch` + `merge --ff-only` von `origin/feat/cesium-ion-export`, `pnpm install`, WASM (`build:wasm`) und Workspace-Pakete neu bauen, Viewer nach `dist.next` bauen (alte Chunks ≤ 14 Tage bleiben für offene Tabs erhalten), dann Tausch mit `dist` (alter Stand bleibt als `dist.prev`) |
| `ssh ifc-deploy rollback` | `dist` und `dist.prev` zurücktauschen |

Die Seite bleibt während des Builds erreichbar; getauscht wird erst danach.

## Einrichtung (einmalig, auf dem Server als root)

### 1. Skripte hochladen (vom PC, PowerShell)

```powershell
cd C:\Users\christof\Documents\git\ifc-geobim\deploy\hetzner
scp ifc-geobim-deploy ifc-geobim-deploy-ssh root@168.119.232.12:/tmp/
```

### 2. Auf dem Server installieren

```bash
ssh root@168.119.232.12

install -o root -g root -m 755 /tmp/ifc-geobim-deploy     /usr/local/bin/ifc-geobim-deploy
install -o root -g root -m 755 /tmp/ifc-geobim-deploy-ssh /usr/local/bin/ifc-geobim-deploy-ssh
rm /tmp/ifc-geobim-deploy /tmp/ifc-geobim-deploy-ssh

# Testlauf als root (nur lesen)
/usr/local/bin/ifc-geobim-deploy status
```

`status` muss Branch `feat/cesium-ion-export` und den Commit zeigen. Meldet es
`node: command not found` o. ä.: `which node corepack` als root prüfen und den
Pfad oben im Skript bei `PATH` ergänzen.

### 3. Deploy-User und sudo-Regel

Gibt es den User `deploy` schon (von geobim.app), wird er mitbenutzt:

```bash
id deploy || adduser --disabled-password --gecos "" deploy

cat > /etc/sudoers.d/ifc-geobim-deploy <<'EOF'
deploy ALL=(root) NOPASSWD: /usr/local/bin/ifc-geobim-deploy status, /usr/local/bin/ifc-geobim-deploy deploy, /usr/local/bin/ifc-geobim-deploy rollback
EOF
chmod 440 /etc/sudoers.d/ifc-geobim-deploy
visudo -c
```

sudo erlaubt genau diese drei Aufrufe, nichts sonst.

### 4. Schlüssel eintragen

Eine Zeile an `~deploy/.ssh/authorized_keys` anhängen:

```bash
install -d -o deploy -g deploy -m 700 ~deploy/.ssh
touch ~deploy/.ssh/authorized_keys
chown deploy:deploy ~deploy/.ssh/authorized_keys
chmod 600 ~deploy/.ssh/authorized_keys

echo 'restrict,command="/usr/local/bin/ifc-geobim-deploy-ssh" ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIC0AkGNPzU2yNuD3sSM1qF1NMvgmJbYE111USviWkgLC claude ifc.geobim.app deploy (christof-pc)' >> ~deploy/.ssh/authorized_keys
```

Falls `/etc/ssh/sshd_config` (oder `sshd_config.d/`) `AllowUsers` setzt,
muss `deploy` darin stehen.

### 5. Ion-Token auf dem Server

```bash
nano /var/www/ifclite-fork/apps/viewer/.env.local   # VITE_CESIUM_ION_TOKEN=eyJ...
```

### 6. Test vom PC

```powershell
ssh ifc-deploy status      # Statuszeilen, KEIN Shell-Prompt
ssh ifc-deploy whoami      # muss "Erlaubt: status | deploy | rollback" melden
ssh ifc-deploy deploy      # erster echter Deploy
```

## Typische Fehler

| Meldung | Ursache |
|---|---|
| `Permission denied (publickey)` | Zeile fehlt/kaputt in `~deploy/.ssh/authorized_keys`, Rechte, `AllowUsers` |
| `sudo: a password is required` | sudoers-Datei fehlt oder Aufruf weicht ab (`visudo -c`) |
| `Not possible to fast-forward` | Branch wurde neu geschrieben (Rebase) oder auf dem Server liegt ein lokaler Commit — einmalig als root `git -C /var/www/ifclite-fork reset --hard origin/feat/cesium-ion-export`, nachdem geprüft ist, dass dort nichts Eigenes liegt |
| `Lokale Änderungen … Abbruch` | jemand hat im Checkout Dateien geändert — erst ansehen, nicht überschreiben |
| `dubious ownership` | Checkout gehört nicht root — Skript läuft als root, `git config --global --add safe.directory /var/www/ifclite-fork` |

## Sperren

Zeile in `~deploy/.ssh/authorized_keys` löschen → Schlüssel sofort wirkungslos.
