interface EncryptedCreds { iv: string; content: string; }
interface SavedData {
    users: { [discordId: string]: { user: EncryptedCreds, pass: EncryptedCreds } };
    knownProjectIds: number[];
}