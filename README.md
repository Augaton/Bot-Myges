# 🎓 MyGES Discord Bot

Un bot Discord performant conçu pour automatiser la gestion de classe et la consultation des données **MyGES** (notes, planning, absences). Ce projet utilise **TypeScript** pour la robustesse, avec un point d'entrée JavaScript pour une compatibilité maximale avec les environnements d'hébergement.

---

## 🚀 Structure du Projet

Le bot est structuré de manière à séparer la logique de développement de l'exécution :

* **`index.js`** : Point d'entrée à la racine. Il initialise `ts-node` pour permettre l'exécution directe du TypeScript sans étape de compilation manuelle complexe dans le conteneur.
* **`src/`** : Contient l'intégralité du code source en `.ts`.
* **`package.json`** : Gère les dépendances (Discord.js, MyGES API, etc.).

---

## 🛠️ Installation sur Pterodactyl (Egg Discord)

Ce bot est optimisé pour l'egg [stanislasbdx/pterodactyl-egg-discord](https://github.com/stanislasbdx/pterodactyl-egg-discord).

### 2. Variables d'environnement

Créez un fichier `.env` à la racine ou renseignez les variables dans l'onglet **Startup** :

| Variable | Description |
| --- | --- |
| `DISCORD_TOKEN` | Le token de votre application Discord Developer Portal. |
| `ENCRYPTION_KEY` | Clé d'encryption pour les logins (32 caractères !). |

N'oublier pas également qu'il y a des configurations a faire dans `config.ts` !

---

## 📦 Dépendances Principales

* **discord.js** : Interaction avec l'API Discord.
* **myges** : Wrapper pour l'API MyGES.
* **typescript** & **ts-node** : Pour le développement et l'exécution fluide du TS.
* **dotenv** : Gestion des variables de configuration.

---

## 🛠 Développement Local

Si vous souhaitez modifier le bot sur votre machine avant de le push :

1. **Cloner le dépôt** :
```bash
git clone https://github.com/votre-repo/myges-bot.git
cd myges-bot

```


2. **Installer les dépendances** :
```bash
npm install

```


3. **Lancer en mode dev** :
```bash
npm run dev

```



---

## 📝 Exemple du `index.js` (Racine)

Pour que l'egg Pterodactyl fonctionne sans compiler manuellement chaque fichier, votre `index.js` doit ressembler à ceci :

```javascript
// Enregistrement de ts-node pour lire le TypeScript à la volée
require('ts-node').register();

// Redirection vers le fichier principal du bot
require('./src/bot.ts');

```

---

> **Note :** Ce bot n'est pas affilié à Réseau GES.

---
