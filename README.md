# Bot-Myges

Bot Discord tout-en-un pour MyGES : agenda, notes, absences et projets directement sur Discord, avec des alertes en message privé. Une même instance peut servir plusieurs serveurs.

Écrit en TypeScript avec [discord.js](https://discord.js.org/).

## Commandes

| Commande | Rôle |
| --- | --- |
| `/login`, `/logout` | Se connecter à MyGES, ou se déconnecter et supprimer ses données |
| `/panel` | Lien vers le panel étudiant, et ton lien d'abonnement : ton calendrier suit ton agenda tout seul |
| `/agenda` | Cours du jour ou de la semaine en image, avec navigation ; le prochain cours en tête |
| `/notes` | Notes et moyennes par matière, en vue graphique ; option `annee` pour une année passée |
| `/alertes` | Réglage des alertes en message privé |
| `/campus` | Adresses et codes d'accès des campus |
| `/help` | Les commandes, l'état de MyGES et les nouveautés de la version |
| `/config` | Réglages du serveur, réservés aux administrateurs : salons des alertes et des mises à jour, tableau de bord |
| `/serveurs` | Serveurs où est le bot et leur configuration, en lecture seule (propriétaire, `OWNER_IDS`) |

Absences, projets, documents, profil, annuaire, actualités et événements se consultent dans le panel.

### Tableau de bord

Avec `/config`, un administrateur publie dans le salon de son choix un message à boutons : Se connecter, Agenda, Notes, Panel, Alertes, Campus, Aide et Se déconnecter. Chaque bouton lance la commande pour celui qui clique, et la réponse n'est visible que par lui : personne n'a de commande à retenir. Se déconnecter demande une confirmation. Choisir à nouveau le salon republie le message en bas ; un salon où les membres ne peuvent pas écrire le garde visible. Le bot met le message à jour à chaque démarrage.

## Panel étudiant

Un site web, séparé du bot, pour consulter son agenda, ses notes, ses absences, ses projets, les actualités et ses documents. L'étudiant se connecte avec son identifiant MyGES : le mot de passe sert une seule fois à obtenir un jeton, il n'est jamais enregistré. La case « Rester connecté » garde ce jeton, chiffré, jusqu'à son expiration (7 jours environ). Depuis Mon profil, on peut déconnecter ses autres appareils. Un étudiant déjà connecté au bot n'a même pas à se connecter : le bouton « Ouvrir le panel » de `/panel` l'y fait entrer directement, avec un lien personnel qui sert une fois, dans les 10 minutes. Ce service n'a aucun lien officiel avec MyGES ni le Réseau GES.

L'agenda colore chaque cours selon son campus, avec l'adresse et l'itinéraire, en grille sur ordinateur comme sur téléphone. Les documents s'ouvrent en aperçu avant d'être téléchargés : PDF, images, texte et code, contenu des archives ZIP. Notes, absences et documents se consultent aussi pour les années passées. On y trouve aussi les étudiants de toutes ses promotions et ses intervenants avec leurs photos, relayées sans être enregistrées, les événements de l'école, l'agenda au mois et un export en `.ics`. Il s'installe sur un téléphone comme une application, sans rien garder hors ligne. Seuls les comptes étudiants peuvent y entrer. Il démarre avec le bot quand `PANEL_PORT` est renseigné, ou seul avec `npm run panel`, et demande un certificat HTTPS, possible sur une simple adresse IP : voir [DEPLOY.md](DEPLOY.md).

## Alertes en message privé

Le bot passe toutes les 15 minutes, avec au plus une lecture de MyGES par heure et par personne, et une par jour pour qui a fermé ses MP. Une alerte qu'une panne de Discord empêche de remettre repart au passage suivant. Chacun règle ses alertes avec `/alertes` :

- les nouvelles notes ;
- les rappels de projets, 24 h puis 2 h avant l'échéance ;
- les changements d'agenda de la semaine à venir : cours annulé, déplacé, ajouté ou changement de salle ;
- le programme du matin vers 7 h, désactivé par défaut.

## Sécurité

Pour accéder à MyGES, le bot garde les identifiants de chaque utilisateur sur la machine qui l'héberge. Ils sont chiffrés en AES-256-GCM avec une clé dérivée par scrypt, mais l'hébergeur détient cette clé. Ne te connecte donc qu'à une instance dont tu fais confiance à l'hébergeur. `/logout` supprime tes données. Si MyGES refuse ton mot de passe enregistré, le bot ne le réessaie qu'une fois par jour, et supprime tes données au bout de 30 jours de refus sans nouveau `/login`.

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
