// src/session.ts

// On change <string, string> par <string, any> pour accepter l'objet Token entier
const sessions = new Map<string, any>(); 

export const SessionStore = {
    // Sauvegarder le token (on accepte 'any')
    setToken: (discordId: string, token: any) => {
        sessions.set(discordId, token);
    },

    // Récupérer le token (ça renverra l'objet complet)
    getToken: (discordId: string) => {
        return sessions.get(discordId);
    },

    // Déconnecter
    logout: (discordId: string) => {
        sessions.delete(discordId);
    },

    // Vérifier si connecté
    isLoggedIn: (discordId: string) => {
        return sessions.has(discordId);
    }
};

// Export direct de la map si tu l'utilises ailleurs
export { sessions };