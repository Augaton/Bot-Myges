import { GesAPI } from '../myges/ges-api';
import { decrypt } from '../crypto';
import { loadData, makeSession, sessions } from '../core/store';
import { log, logError } from '../utils/logger';

// --- RECONNEXION AUTO au démarrage du bot ---
export async function autoLoginUsers() {
    const data = loadData();
    const userIds = Object.keys(data.users);
    if (userIds.length === 0) {
        log('AUTH', 'Aucun utilisateur enregistré à reconnecter.');
        return;
    }
    log('AUTH', `Reconnexion de ${userIds.length} utilisateur(s)...`);
    let ok = 0;
    for (const userId of userIds) {
        try {
            const encryptedUser = data.users[userId];
            const token = await GesAPI.login(decrypt(encryptedUser.user), decrypt(encryptedUser.pass));
            sessions.set(userId, makeSession(userId, token));
            ok++;
            log('AUTH', `${userId} reconnecté.`);
        } catch (e) {
            logError('AUTH', `Échec reconnexion ${userId}`);
        }
        await new Promise((r) => setTimeout(r, 2000));
    }
    log('AUTH', `Reconnexion terminée : ${ok}/${userIds.length} session(s) active(s).`);
}
