// Petit logger horodaté (fuseau Europe/Paris) pour la console serveur.
// Usage : log('CMD', `/agenda par ...`)  /  logError('PROJET', 'échec', e)

function timestamp(): string {
    return new Date().toLocaleString('fr-FR', {
        timeZone: 'Europe/Paris',
        day: '2-digit',
        month: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
    });
}

// Les messages citent des textes venus de MyGes (nom de projet…) : sans sauts de
// ligne ni séquences d'échappement, ils ne peuvent ni imiter une ligne de journal,
// ni effacer ce qu'affiche `tail -f`.
const oneLine = (message: string) => message.replace(/[\p{Cc}\p{Cf}]+/gu, ' ');

export function log(scope: string, message: string, ...rest: any[]) {
    console.log(`[${timestamp()}] [${scope}] ${oneLine(message)}`, ...rest);
}

/**
 * Une erreur d'API Discord embarque l'URL de la requête, qui contient le jeton
 * de l'interaction (il permet de répondre au nom du bot pendant 15 min), et le
 * corps envoyé : seul l'essentiel en est journalisé.
 */
function redact(arg: any): any {
    if (arg && typeof arg === 'object' && 'requestBody' in arg) {
        return `${arg.name} [HTTP ${arg.status}${arg.code != null ? `, code ${arg.code}` : ''}] ${arg.method ?? ''} : ${arg.message}`;
    }
    return arg;
}

export function logError(scope: string, message: string, ...rest: any[]) {
    console.error(`[${timestamp()}] [${scope}] ${oneLine(message)}`, ...rest.map(redact));
}
