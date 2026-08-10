# Déploiement — serveur Node.js 26

## Ce qui a changé

Le bot ne s'exécute plus via `ts-node`. Le TypeScript est **compilé en amont**
(`npm run build` → `dist/`) et le serveur ne lance que du JavaScript. C'est ce
qui rend la montée vers Node 26 (et les suivantes) sans risque : `ts-node`
s'appuie sur des API internes de Node qui bougent à chaque version majeure.

| Avant | Après |
|---|---|
| `node index.js` → `ts-node` → `src/index.ts` | `npm run build` puis `npm start` → `dist/index.js` |
| `ts-node` en dépendance d'exécution | supprimé |
| `saved_data.json` relatif au dossier courant | résolu depuis la racine du projet |

`index.js` reste utilisable (`node index.js`) : il charge `dist/` et affiche un
message explicite si le build manque.

## Prérequis serveur

- **Node.js ≥ 22.18** (`engines` dans `package.json`), **testé et prévu pour 26**.
  Un `.nvmrc` fixe la version : `nvm use`.
- Aucune toolchain de compilation native n'est nécessaire : `@napi-rs/canvas`
  livre des binaires précompilés et utilise **N-API**, dont l'ABI est stable
  d'une version majeure de Node à l'autre. Rien à recompiler après un upgrade.

## Installation / mise à jour

```bash
nvm install 26 && nvm use          # ou la version de ton gestionnaire
npm ci                             # installe exactement le package-lock
npm run build                      # génère dist/
npm start                          # lance le bot (rebuild automatique via prestart)
```

Développement local (Node exécute le TypeScript nativement, sans ts-node) :

```bash
npm run dev        # node --watch src/index.ts
npm run typecheck  # vérification de types sans émettre
```

## Variables d'environnement

| Variable | Requis | Rôle |
|---|---|---|
| `DISCORD_TOKEN` | oui | Token du bot. Absent → le processus refuse de démarrer. |
| `ENCRYPTION_KEY` | oui | Exactement 32 caractères ASCII. Chiffre les identifiants MyGes. |
| `DB_FILE` | non | Chemin du fichier de persistance (défaut : `<racine>/saved_data.json`). |

⚠️ **`ENCRYPTION_KEY` et `saved_data.json` ne doivent jamais être sur le même
support de sauvegarde non chiffré** : la clé déchiffre tous les mots de passe
MyGes stockés. Sur le serveur :

```bash
chmod 600 .env saved_data.json
```

Le bot écrit désormais `saved_data.json` en mode `0600` de lui-même.

## Service systemd

```ini
[Unit]
Description=Bot Discord MyGes
After=network-online.target

[Service]
Type=simple
User=botmyges
WorkingDirectory=/opt/botdiscordmyges
ExecStart=/usr/bin/node dist/index.js
Restart=always
RestartSec=10
# Le bot gère SIGTERM : il ferme proprement la passerelle Discord.
KillSignal=SIGTERM
TimeoutStopSec=20
Environment=NODE_ENV=production
EnvironmentFile=/opt/botdiscordmyges/.env

# Durcissement
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=/opt/botdiscordmyges

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now botmyges
journalctl -u botmyges -f
```

## ⚠️ Impact sur ton déploiement SFTP actuel

`.vscode/sftp.json` est en `uploadOnSave: true` : jusqu'ici tu envoyais les
`.ts` et le serveur les exécutait via ts-node. **Ça ne suffit plus** — le serveur
lance `dist/`. Deux options :

1. **Build sur le serveur** (recommandé) : tu continues d'envoyer `src/`, puis
   sur le serveur `npm ci && npm run build && systemctl restart botmyges`.
2. **Build en local** : ajoute `dist` à ce qui est téléversé (il est dans
   `.gitignore`, ce qui n'empêche pas le SFTP de l'envoyer) et redémarre le service.

Dans les deux cas, un `src/*.ts` téléversé seul ne change plus rien au
comportement du bot tant que le build n'a pas été rejoué.

## Note sur le gestionnaire de paquets

Le dépôt contient **`package-lock.json` et `yarn.lock`**. Seul `package-lock.json`
est à jour. Choisis-en un et supprime l'autre (ainsi que `.yarnrc`), sinon les
versions installées diffèrent selon l'outil utilisé sur le serveur.
