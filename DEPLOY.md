# Déploiement

## Prérequis serveur

- **Node.js ≥ 22.18** (`engines` dans `package.json`), testé sur 22 et prévu pour 26.
  Un `.nvmrc` fixe la version : `nvm use`.
- Aucune toolchain de compilation native n'est nécessaire : `@napi-rs/canvas`
  livre des binaires précompilés (N-API, ABI stable d'une version de Node à l'autre).
- Gestionnaire de paquets : **npm uniquement** (`package-lock.json`). `yarn.lock`
  a été supprimé.

## Installation / mise à jour

```bash
npm ci                  # installe exactement le package-lock (devDependencies comprises, pour le build)
npm run build           # compile src/ → dist/ (TypeScript 7)
npm start               # build + lancement supervisé (voir plus bas)
```

Vérifications :

```bash
npm test                # build + tests (node:test, aucune dépendance)
npm run typecheck       # vérification de types sans émettre
```

Développement local (recompile et relance à chaque modification) :

```bash
npm run dev
```

⚠️ `npm run dev` se connecte avec le token du `.env` : si le bot de production
tourne avec le même token, les deux instances répondront aux commandes.

## Lancement : superviseur intégré ou systemd

`npm start` (= `node index.js`) lance le bot via un **petit superviseur** : si le
bot s'arrête sur une erreur, il est relancé automatiquement (1 s, puis 2 s, 4 s…
jusqu'à 60 s ; le délai repart de 1 s après 5 min de fonctionnement stable).
Une erreur de configuration (token invalide, `ENCRYPTION_KEY` incorrecte) arrête
tout sans relancer en boucle. Utile sur un panel, dans `screen`/`tmux`, etc.

Le bot s'arrête de lui-même (pour être relancé) dans trois cas : exception non
interceptée, session Discord invalidée, ou passerelle Discord injoignable depuis
plus de 15 min. **Il doit donc toujours tourner sous un superviseur** : celui
d'`index.js`, ou systemd ci-dessous.

## Variables d'environnement

| Variable | Requis | Rôle |
|---|---|---|
| `DISCORD_TOKEN` | oui | Token du bot. Absent → le processus refuse de démarrer. |
| `ENCRYPTION_KEY` | oui | Au moins 32 caractères (exactement 32 pour relire des données antérieures à la v3.4). Sert à chiffrer les identifiants MyGes. |
| `OWNER_IDS` | non | ID(s) Discord du/des propriétaire(s), séparés par des virgules. Défaut : `456653480048852995`. Peuvent utiliser `/config` sur tout serveur, même sans être admin. |
| `DB_FILE` | non | Fichier de persistance (défaut : `<racine>/saved_data.json`). |
| `CAMPUS_FILE` | non | Codes d'accès des campus (défaut : `<racine>/campus.json`). |

Le `.env` est lu nativement par Node depuis la **racine du projet** (plus de
dépendance `dotenv`) ; une variable déjà définie dans l'environnement est prioritaire.

Le fuseau horaire est **forcé à `Europe/Paris`** au démarrage : un serveur
réglé en UTC ne décale plus l'agenda. Rien à configurer.

⚠️ **`ENCRYPTION_KEY` et `saved_data.json` ne doivent jamais être sur le même
support de sauvegarde non chiffré** : la clé déchiffre tous les mots de passe
MyGes stockés.

```bash
chmod 600 .env saved_data.json campus.json
```

## Chiffrement des identifiants (v3.4)

La clé de chiffrement n'est plus `ENCRYPTION_KEY` telle quelle mais une clé
**dérivée par scrypt** (sel aléatoire propre à l'installation, enregistré dans
`saved_data.json` sous `crypto`). Au premier démarrage en v3.4, les identifiants
existants sont **rechiffrés automatiquement** (log `[STORE] Chiffrement renforcé…`).

- Une copie du fichier d'origine est gardée : `saved_data.json.bak-avant-scrypt`
  (mode 600). Elle contient les identifiants à l'ancien format : supprime-la
  une fois la v3.4 validée.
- **Retour arrière en v3.3** : arrêter le bot, remettre la copie à la place de
  `saved_data.json`, puis relancer l'ancienne version (elle ne sait pas lire le
  nouveau format).
- Ne jamais changer `ENCRYPTION_KEY` ni supprimer la clé `crypto` du fichier :
  tous les utilisateurs devraient refaire `/login`.

## Alertes en MP

Toutes les 15 min, le bot vérifie pour chaque utilisateur connecté (au plus une
lecture MyGes par heure et par personne) :

- les **nouvelles notes** → MP (premier passage silencieux : l'historique n'est pas envoyé) ;
- les **échéances de projets** → MP 24 h puis 2 h avant.

Chacun règle ses alertes avec `/alertes` (activées par défaut). Les notes déjà
vues sont mémorisées sous forme d'empreintes HMAC, jamais en clair. Aucun
intent Discord supplémentaire n'est nécessaire pour envoyer des MP.

## Codes d'accès des campus (`campus.json`)

Le dépôt GitHub est public : les codes ne sont plus dans le code source. Ils sont
lus dans `campus.json` (ignoré par git), au format de `campus.example.json` :

```json
{ "nation": "…", "erard": "…", "voltaire1": "…", "voltaire2": "…", "rauch": "…" }
```

**À copier sur le serveur** (il n'est pas envoyé par git). Sans ce fichier,
`/campus` affiche les adresses avec « code non renseigné ». Le fichier est relu à
chaque appel : pas besoin de redémarrer après modification.

## Service systemd

```ini
[Unit]
Description=Bot Discord MyGes
After=network-online.target

[Service]
Type=simple
User=botmyges
WorkingDirectory=/opt/botdiscordmyges
# systemd joue déjà le rôle de superviseur : on lance le bot directement.
ExecStart=/usr/bin/node dist/index.js
Restart=always
RestartSec=10
# Erreur de configuration (code 78) : inutile de relancer en boucle.
RestartPreventExitStatus=78
KillSignal=SIGTERM
TimeoutStopSec=20
Environment=NODE_ENV=production
# Limite l'emballement mémoire de glibc avec les threads de rendu (canvas).
Environment=MALLOC_ARENA_MAX=2
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

## Diagnostic

- Toutes les heures, une ligne `[SANTÉ]` donne la RAM, le nombre de sessions et
  le ping : une RAM qui grimpe d'heure en heure se repère tout de suite.
- Les coupures de la passerelle Discord sont journalisées (`[DISCORD] Passerelle…`).
- `/ping` affiche la version, l'uptime et la RAM du bot.
- Les erreurs MyGes passagères (5xx) sont rejouées automatiquement et
  journalisées en `[MYGES] … nouvelle tentative`.

## Déploiement via SFTP

Le serveur exécute `dist/`, pas `src/` : un `.ts` téléversé seul ne change rien
tant que le build n'a pas été rejoué.

1. **Build sur le serveur** (recommandé) : envoyer `src/`, puis
   `npm ci && npm run build` et redémarrer le bot.
2. **Build en local** : téléverser aussi `dist/` (ignoré par git, pas par le SFTP),
   puis redémarrer.
