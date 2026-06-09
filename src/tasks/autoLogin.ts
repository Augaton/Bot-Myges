import { GesAPI } from '../myges/ges-api';
import { decrypt } from '../crypto';
import { loadData, makeSession, sessions } from '../core/store';

// --- RECONNEXION AUTO au démarrage du bot ---
export async function autoLoginUsers() {
    const data = loadData();
    const userIds = Object.keys(data.users);
    if (userIds.length === 0) return;
    console.log(`🔄 Reconnexion de ${userIds.length} utilisateurs...`);
    for (const userId of userIds) {
        try {
            const encryptedUser = data.users[userId];
            const token = await GesAPI.login(decrypt(encryptedUser.user), decrypt(encryptedUser.pass));
            sessions.set(userId, makeSession(userId, token));
            console.log(`✅ ${userId} reconnecté.`);
        } catch (e) {
            console.error(`❌ Echec reconnexion ${userId}`);
        }
        await new Promise((r) => setTimeout(r, 2000));
    }
}
