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
npm ci --ignore-scripts # installe exactement le package-lock (devDependencies comprises, pour le build)
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
| `OWNER_IDS` | non | ID(s) Discord du/des propriétaire(s), séparés par des virgules. Peuvent utiliser `/config` sur tout serveur, même sans être admin. Absent ou vide : aucun propriétaire. |
| `DB_FILE` | non | Fichier de persistance (défaut : `<racine>/saved_data.json`). |
| `CAMPUS_FILE` | non | Codes d'accès des campus (défaut : `<racine>/campus.json`). |
| `PANEL_PUBLIC_URL` | non | Adresse `https://` du panel, donnée par `/panel` et l'annonce de mise à jour. Absente : `/panel` dit que le panel n'est pas disponible, et l'annonce ne donne pas de lien. |

Le `.env` est lu nativement par Node depuis la **racine du projet** (plus de
dépendance `dotenv`) ; une variable déjà définie dans l'environnement est prioritaire.

Le fuseau horaire est **forcé à `Europe/Paris`** au démarrage : un serveur
réglé en UTC ne décale plus l'agenda. Rien à configurer.

⚠️ **`ENCRYPTION_KEY` et `saved_data.json` ne doivent jamais être sur le même
support de sauvegarde non chiffré** : la clé déchiffre tous les mots de passe
MyGes stockés.

Au démarrage, le bot ramène `.env`, `saved_data.json` et `campus.json` en mode 600,
ce qui rattrape un envoi par SFTP. Il signale aussi une copie
`saved_data.json.bak-avant-scrypt` restante, à supprimer : elle n'est pas effacée
par `/logout`.

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
- les **nouvelles absences** → MP (premier passage silencieux, lui aussi) ;
- les **échéances de projets et de TP** → MP 24 h puis 2 h avant ;
- les **changements d'agenda** sur la semaine à venir (cours annulé, déplacé,
  ajouté, changement de salle) → MP (premier passage silencieux, lui aussi) ;
- le **programme du matin** → MP vers 7 h avec les cours du jour (désactivé par défaut).

Chacun règle ses alertes avec `/alertes` (toutes activées par défaut, sauf le
programme du matin). Les notes et absences déjà vues sont mémorisées sous forme
d'empreintes HMAC, jamais en clair ; les cours à venir déjà vus sont chiffrés comme les
identifiants. Aucun intent Discord supplémentaire n'est nécessaire pour envoyer des MP.

## Limites

| Quoi | Limite |
|---|---|
| Commandes | 10 par 30 s et par personne |
| Clics dans un panneau | 20 par 30 s et par personne |
| Partage dans un salon | 3 par minute et par personne, droit d'écrire requis |
| `/login` | 5 essais par 15 min (par compte Discord et par identifiant MyGes), 30 échecs par 15 min en tout |
| Téléchargements `/documents` | 1 par personne, 3 en tout |
| Rendus en attente | 16, les suivants sont refusés |

## Documents (`/documents`)

Les fichiers transitent par la mémoire du bot, jamais par le disque : ils sont
téléchargés depuis MyGes puis envoyés en message éphémère, plafonnés à la limite
d'envoi du salon (10 Mo sur un serveur sans boost) et à 25 Mo dans tous les cas.

## Journaux

- Sous **systemd** : `journalctl -u botmyges` (voir plus bas).
- Avec **`npm start`** (superviseur intégré) : la sortie du bot est aussi écrite
  dans `logs/bot-AAAA-MM-JJ.log` (heure de Paris), un fichier par jour, 14 jours
  conservés. `tail -f logs/bot-$(date +%F).log` pour suivre en direct.
  Comme `saved_data.json`, ils ne sont lisibles que par le compte du bot
  (dossier 700, fichiers 600). Les identifiants MyGes saisis dans `/login` n'y
  figurent jamais en clair, ni les jetons d'interaction Discord.

En cas de crash ou de lenteur, les lignes utiles sont `[SANTÉ]` (RAM, chaque
heure), `[DISCORD] Passerelle…`, `[MYGES] … nouvelle tentative` et `[SUPERVISEUR]`.

## Codes d'accès des campus (`campus.json`)

Le dépôt GitHub est public : les codes ne sont plus dans le code source. Ils sont
lus dans `campus.json` (ignoré par git), au format de `campus.example.json` :

```json
{ "nation": "…", "erard": "…", "voltaire1": "…", "voltaire2": "…", "rauch": "…" }
```

**À copier sur le serveur** (il n'est pas envoyé par git). Sans ce fichier,
`/campus` affiche les adresses avec « code non renseigné ». Le fichier est relu à
chaque appel : pas besoin de redémarrer après modification.

`/campus` n'affiche ces codes qu'à un étudiant dont l'agenda MyGes contient un cours
sur l'un de ces campus (3 semaines passées, 6 à venir). Si MyGes ne répond pas, rien
n'est affiché. Un refus inattendu laisse la ligne `[CAMPUS] Accès refusé…`, qui cite
les campus vus : à reporter dans `OUR_CAMPUSES` (`src/commands/campus.ts`) si l'un
d'eux manque.

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
PrivateDevices=true
ProtectSystem=strict
ProtectHome=true
ProtectKernelTunables=true
ProtectKernelModules=true
ProtectControlGroups=true
RestrictSUIDSGID=true
RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6
LockPersonality=true
CapabilityBoundingSet=
UMask=0077
ReadWritePaths=/opt/botdiscordmyges
# Pas de MemoryDenyWriteExecute : le JIT de V8 en a besoin.

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

## Panel étudiant

Site web où un étudiant consulte son agenda, ses notes, ses absences, ses projets,
ses actualités et ses documents. Il se connecte avec son identifiant MyGES : le mot
de passe sert une seule fois à obtenir un jeton auprès de MyGES, puis il est oublié.
Par défaut, rien n'est écrit sur disque et un redémarrage déconnecte l'étudiant ; la case
« Rester connecté » change cela (voir plus bas).

Seuls les comptes dont MyGES indique le rôle `student` peuvent entrer.

**Le HTTPS est obligatoire.** Sans lui, le mot de passe circulerait en clair. Le panel
refuse de démarrer sur une adresse joignable depuis le réseau sans certificat, et son
cookie `Secure` n'est de toute façon pas accepté en HTTP simple.

| Variable | Défaut | Rôle |
|---|---|---|
| `PANEL_HOST` | `127.0.0.1` | Adresse d'écoute. `0.0.0.0` pour ouvrir le panel directement sur l'adresse IP. |
| `PANEL_PORT` | `3000` | Port d'écoute. |
| `PANEL_TLS_CERT` | absent | Certificat (`fullchain.pem`). Relu toutes les 6 h, sans redémarrage. |
| `PANEL_TLS_KEY` | absent | Clé privée (`privkey.pem`), en mode 600. |
| `PANEL_FEEDS_DIR` | `panel_feeds` à la racine | Abonnements d'agenda chiffrés, écrits par le bot, servis par le panel. Les deux doivent voir le même dossier. |
| `PANEL_SESSIONS_FILE` | `panel_sessions.json` à la racine | Sessions « Rester connecté », en mode 600. Le supprimer déconnecte tout le monde. |
| `PANEL_TRUST_PROXY` | absent | `1` uniquement derrière un proxy, pour limiter les essais par visiteur. |

Seules ces variables sont lues dans le `.env` : le processus du panel ne charge ni
`DISCORD_TOKEN` ni `ENCRYPTION_KEY`. Pour une séparation complète, fais-le tourner
sous un compte système distinct, sans droit de lecture sur le `.env`.

```bash
npm run panel           # build + lancement supervisé, journal dans logs/panel-AAAA-MM-JJ.log
```

Essai en local, sans certificat : `npm run panel`, puis `http://localhost:3000` (et pas
`127.0.0.1`, seul `localhost` permet le cookie sans HTTPS).

### Sur Pelican (ou Pterodactyl)

Le panel tourne avec le bot, sur un seul serveur Pelican : `node index.js` (ou `npm start`)
lance les deux, chacun dans son processus, dès que `PANEL_PORT` est renseigné. nginx, sur la
machine, apporte le HTTPS et une page « indisponible » quand le panel est arrêté.

```
Navigateur ──HTTPS──> nginx :8443 ──HTTP──> 172.18.0.1:8788 ──> conteneur ──> panel
```

1. Dans Pelican, ajoute une allocation **`127.0.0.1:8788`** et rattache-la au serveur du bot,
   en plus de son port principal. Pelican la publie sur l'interface Docker (`172.18.0.1` par
   défaut), jamais sur l'IP publique : c'est elle qui garde le port privé. Une allocation
   sur `0.0.0.0` ou sur l'IP publique exposerait le port. Vérifie après démarrage :

```bash
sudo docker ps --format '{{.Ports}}' | grep 8788   # attendu : 172.18.0.1:8788->8788/tcp
```

L'adresse affichée (`172.18.0.1` par défaut, parfois `172.19.0.1`) est celle à mettre dans
nginx. Une erreur ici se voit tout de suite : nginx affiche la page « indisponible ».

2. Ajoute au `.env` du bot. `0.0.0.0` est voulu : `127.0.0.1` serait la boucle locale du
   conteneur, injoignable pour nginx.

```bash
PANEL_HOST=0.0.0.0
PANEL_PORT=8788
PANEL_TRUST_PROXY=1
```

3. Obtiens le certificat (étapes 1 à 3 de la section suivante), puis installe nginx :

```bash
sudo mkdir -p /var/www/panel-myges
sudo cp deploy/nginx/panel-down.html /var/www/panel-myges/
sudo cp deploy/nginx/panel.conf /etc/nginx/sites-available/panel-myges   # puis adapte l'adresse
sudo ln -s /etc/nginx/sites-available/panel-myges /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
```

4. Démarre le bot, puis vérifie, **depuis une autre machine** :

```bash
curl -I https://203.0.113.10:8443/    # 200, ou 503 si le panel est arrêté
curl -m 5 http://203.0.113.10:8788/   # doit échouer : le port ne doit pas être public
```

Si la seconde commande répond, le port est public : corrige l'allocation. En mode proxy, le
panel refuse de toute façon ces accès directs (403) et n'affiche pas son formulaire.

### Sur une adresse IP et un port, avec nginx

Let's Encrypt délivre des certificats gratuits pour une adresse IP. Ils durent 6 jours et
demandent **Certbot 5.4 ou plus**. Si le serveur a une version plus ancienne, ne la remplace
pas : elle gère peut-être le certificat d'un autre site. Installe la récente à part, avec ses
propres dossiers, pour que les deux ne se croisent jamais :

```bash
sudo apt install python3-venv
sudo python3 -m venv /opt/certbot
sudo /opt/certbot/bin/pip install --upgrade pip certbot
/opt/certbot/bin/certbot --version   # 5.4 ou plus
```

**1. Laisser nginx répondre à Let's Encrypt sur le port 80.** Ce bloc ne concerne que les
requêtes adressées à l'IP : les sites appelés par leur domaine ne changent pas. Crée
`/etc/nginx/sites-available/panel-acme`, en remplaçant `203.0.113.10` par l'adresse du serveur :

```nginx
server {
    listen 80;
    server_name 203.0.113.10;
    location /.well-known/acme-challenge/ { root /var/www/certbot; }
    location / { return 404; }
}
```

```bash
sudo mkdir -p /var/www/certbot
sudo ln -s /etc/nginx/sites-available/panel-acme /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
```

**2. Demander le certificat.** Vérifie les options avec `/opt/certbot/bin/certbot --help`.

```bash
sudo /opt/certbot/bin/certbot certonly --webroot -w /var/www/certbot \
  --preferred-profile shortlived --ip-address 203.0.113.10 \
  --deploy-hook 'systemctl reload nginx' \
  --config-dir /etc/letsencrypt-ip --work-dir /var/lib/letsencrypt-ip --logs-dir /var/log/letsencrypt-ip
sudo ls /etc/letsencrypt-ip/live/   # donne le dossier exact du certificat
```

**3. Automatiser le renouvellement.** Sans lui, le certificat expire en 6 jours. Crée
`/etc/cron.d/panel-cert`, sur une seule ligne :

```
17 */6 * * * root /opt/certbot/bin/certbot renew -q --config-dir /etc/letsencrypt-ip --work-dir /var/lib/letsencrypt-ip --logs-dir /var/log/letsencrypt-ip
```

Puis vérifie que le renouvellement passe :

```bash
sudo /opt/certbot/bin/certbot renew --dry-run --config-dir /etc/letsencrypt-ip --work-dir /var/lib/letsencrypt-ip --logs-dir /var/log/letsencrypt-ip
```

**4. Ouvrir le panel sur le port choisi.** Le fichier est dans `deploy/nginx/panel.conf`. Le
port du panel y est `8788`, sur l'interface Docker `172.18.0.1` ; l'adresse publique est à adapter. Ouvre ensuite le port `8443` dans le pare-feu.

Un sous-domaine de n'importe quel domaine (`panel.exemple.fr`, un enregistrement DNS A
vers le serveur) donne un certificat de 90 jours et une adresse plus facile à
reconnaître, sans rien changer au site principal.

Sans nginx, le panel sait aussi servir le HTTPS lui-même : `PANEL_HOST=0.0.0.0`, avec
`PANEL_TLS_CERT` et `PANEL_TLS_KEY` vers une copie du certificat lisible par son compte.

Sous systemd, duplique le service du bot avec `ExecStart=/usr/bin/node dist/panel/server.js`,
sans `EnvironmentFile` : les variables du panel sont lues dans le `.env`.

| Limite | Valeur |
|---|---|
| Échecs de connexion, par 15 min | 5 par identifiant et par réseau, 20 par réseau, 20 par identifiant, 300 en tout |
| Connexions réussies | 10 par compte et par 15 min |
| Session | 3 par compte, 30 min d'inactivité, 12 h au plus, jamais au-delà du jeton MyGES |
| « Rester connecté » | Jusqu'à l'expiration du jeton MyGES (7 jours environ), 30 jours au plus |
| Requêtes | 120 par minute et par compte |
| Téléchargements | 1 par compte, 3 en tout, 25 Mo au plus, 5 min au plus |

« Rester connecté » est une case décochée par défaut. Le mot de passe n'est jamais gardé. Le jeton
MyGES l'est, chiffré avec une clé tirée du cookie de l'étudiant : le serveur ne garde que l'empreinte
de ce cookie, donc `panel_sessions.json` seul ne donne ni jeton, ni nom, ni identifiant. Il survit aux
redémarrages. Une déconnexion efface l'entrée. Quand le jeton expire, l'étudiant se reconnecte.

`/abonnement` donne un lien d'abonnement d'agenda (`https://<adresse>/agenda/<secret>.ics`). Le bot
garde le secret chiffré avec sa clé, comme les identifiants, et prépare toutes les 30 minutes les 12
prochaines semaines, chiffrées avec ce secret, dans `PANEL_FEEDS_DIR`. Le panel sert ce fichier sans
la clé du bot : le fichier seul ne donne rien. Le lien est un secret : nginx ne doit pas l'écrire dans
ses journaux (`location /agenda/` avec `access_log off` et `error_log /dev/null crit`, voir
`deploy/nginx/panel.conf` : panel arrêté, nginx écrirait sinon la requête entière dans `error.log`). « Nouveau
lien » remplace l'ancien, « Supprimer » le coupe ; `/logout` et un changement de compte aussi.

« Déconnecter mes autres appareils » (dans Mon profil) ferme les autres sessions du compte. Pour
celles gardées sur disque et pas encore relues, le fichier garde une marque de révocation : une
empreinte salée du compte et une date, jamais le compte en clair. La marque disparaît au bout de
30 jours, quand toutes les sessions qu'elle visait ont expiré.

Un réseau est un /24 en IPv4 et un /64 en IPv6. Ces compteurs vivent en mémoire : un
redémarrage les remet à zéro. Au-delà de 300 échecs par 15 min, plus personne ne peut
se connecter jusqu'à la fin de la fenêtre, mais les sessions ouvertes continuent.

## Déploiement via SFTP

Le serveur exécute `dist/`, pas `src/` : un `.ts` téléversé seul ne change rien
tant que le build n'a pas été rejoué.

1. **Build sur le serveur** (recommandé) : envoyer `src/`, puis
   `npm ci && npm run build` et redémarrer le bot.
2. **Build en local** : téléverser aussi `dist/` (ignoré par git, pas par le SFTP),
   puis redémarrer.
