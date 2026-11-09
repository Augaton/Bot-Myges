// Point d'entrée du panel (`npm run panel`). Processus distinct du bot : une panne
// de l'un n'atteint pas l'autre, et celui-ci ne charge aucun secret du bot.
import { createPanel } from './app';
import { readSettings } from './settings';
import { log, logError } from '../utils/logger';

process.env.TZ = 'Europe/Paris'; // même heure que l'école, quel que soit le serveur

process.on('unhandledRejection', (reason) => logError('PROCESS', 'Promesse rejetée non gérée :', reason));
process.on('uncaughtException', (err) => {
    logError('PROCESS', 'Exception non interceptée, redémarrage :', err);
    process.exit(1);
});

const { host, port, trustProxy, tls, sessionsFile, feedsDir } = readSettings();

// Code compris par le superviseur : relancer en boucle n'y changerait rien.
const EXIT_CONFIG = 78;

// Hors de cette machine, le mot de passe scolaire d'un étudiant circulerait en clair :
// le panel préfère ne pas démarrer. Derrière un proxy, c'est lui qui apporte le HTTPS.
if (!tls && !trustProxy && !/^(localhost$|127\.|::1$)/.test(host)) {
    logError('PANEL', `Refus de démarrer : ${host} est joignable depuis le réseau, or sans HTTPS les mots de passe circuleraient en clair. Renseigne PANEL_TLS_CERT et PANEL_TLS_KEY (voir DEPLOY.md).`);
    process.exit(EXIT_CONFIG);
}

let server: ReturnType<typeof createPanel>;
try {
    server = createPanel({ trustProxy, tls, sessionsFile, feedsDir });
} catch (e) {
    logError('PANEL', 'Démarrage impossible (certificat illisible ?) :', e);
    process.exit(EXIT_CONFIG);
}
server.listen(port, host, () => {
    log('PANEL', `Panel en ligne sur ${tls ? 'https' : 'http'}://${host}:${port}.`);
    if (!tls && !trustProxy) log('PANEL', 'Sans HTTPS ni PANEL_TRUST_PROXY : réservé à un essai sur cette machine.');
    if (!tls && trustProxy) log('PANEL', 'En HTTP derrière un proxy : ce port doit rester privé, jamais joignable depuis Internet.');
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
        server.close(() => process.exit(0));
        setTimeout(() => process.exit(0), 3_000).unref();
    });
}
