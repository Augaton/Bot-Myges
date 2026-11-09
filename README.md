# Bot-Myges

Bot Discord tout-en-un pour MyGES : agenda, notes, absences et projets directement sur Discord, avec des alertes en message privé. Une même instance peut servir plusieurs serveurs.

Écrit en TypeScript avec [discord.js](https://discord.js.org/).

## Commandes

| Commande | Rôle |
| --- | --- |
| `/login`, `/logout` | Se connecter à MyGES, ou se déconnecter et supprimer ses données |
| `/panel` | Lien vers le panel étudiant |
| `/documents` | Supports de cours et documents annuels |
| `/agenda` | Cours du jour ou de la semaine, avec navigation |
| `/prochain` | Prochain cours à venir |
| `/export` | Emploi du temps en `.ics`, pour Google Agenda ou Apple Calendrier |
| `/notes` | Notes et moyennes par matière, en vue graphique |
| `/absences` | Absences enregistrées sur MyGES |
| `/projets` | Projets en cours et prochaines étapes |
| `/profil` | Informations du profil MyGES |
| `/profs`, `/trombi` | Professeurs et trombinoscope de la classe |
| `/news` | Dernières actualités de l'école |
| `/campus` | Adresses et codes d'accès des campus |
| `/alertes` | Réglage des alertes en message privé |
| `/config` | Réglages du serveur, réservés aux administrateurs |
| `/help`, `/ping`, `/changelog` | Aide, état du bot et de MyGES, dernières mises à jour |

## Panel étudiant

Un site web, séparé du bot, pour consulter son agenda, ses notes, ses absences, ses projets, les actualités et ses documents. L'étudiant se connecte avec son identifiant MyGES : le mot de passe sert une seule fois à obtenir un jeton, il n'est jamais enregistré. La case « Rester connecté » garde ce jeton, chiffré, jusqu'à son expiration (7 jours environ). Ce service n'a aucun lien officiel avec MyGES ni le Réseau GES.

On y trouve aussi sa classe et ses intervenants avec leurs photos, relayées sans être enregistrées, les événements de l'école, l'agenda au mois et un export en `.ics`. Il s'installe sur un téléphone comme une application, sans rien garder hors ligne. Seuls les comptes étudiants peuvent y entrer. Il démarre avec le bot quand `PANEL_PORT` est renseigné, ou seul avec `npm run panel`, et demande un certificat HTTPS, possible sur une simple adresse IP : voir [DEPLOY.md](DEPLOY.md).

## Alertes en message privé

Le bot passe toutes les 15 minutes, avec au plus une lecture de MyGES par heure et par personne. Chacun règle ses alertes avec `/alertes` :

- les nouvelles notes ;
- les rappels de projets, 24 h puis 2 h avant l'échéance ;
- les changements d'agenda de la semaine à venir : cours annulé, déplacé, ajouté ou changement de salle ;
- le programme du matin vers 7 h, désactivé par défaut.

## Sécurité

Pour accéder à MyGES, le bot garde les identifiants de chaque utilisateur sur la machine qui l'héberge. Ils sont chiffrés en AES-256-GCM avec une clé dérivée par scrypt, mais l'hébergeur détient cette clé. Ne te connecte donc qu'à une instance dont tu fais confiance à l'hébergeur. `/logout` supprime tes données.

## Installation

Il faut Node.js 22.18 ou plus.

```bash
npm ci
```

Crée un fichier `.env` à la racine du projet :

```env
DISCORD_TOKEN=token_du_bot
ENCRYPTION_KEY=au_moins_32_caracteres
```

Lance ensuite le bot :

```bash
npm start
```

[DEPLOY.md](DEPLOY.md) détaille les variables d'environnement, le lancement avec systemd et les codes d'accès des campus.

## Tests

```bash
npm test
```
