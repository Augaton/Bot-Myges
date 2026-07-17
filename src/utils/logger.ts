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

export function log(scope: string, message: string, ...rest: any[]) {
    console.log(`[${timestamp()}] [${scope}] ${message}`, ...rest);
}

export function logError(scope: string, message: string, ...rest: any[]) {
    console.error(`[${timestamp()}] [${scope}] ${message}`, ...rest);
}
