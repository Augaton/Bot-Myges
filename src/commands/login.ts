import {
    ActionRowBuilder, ChatInputCommandInteraction, ModalBuilder, ModalSubmitInteraction,
    MessageFlags, SlashCommandBuilder, TextInputBuilder, TextInputStyle,
} from 'discord.js';
import { Command } from '../core/command';
import { GesAPI } from '../myges/ges-api';
import { BadCredentialsError, MyGesError } from '../myges/errors';
import { decrypt, encrypt, fingerprint } from '../crypto';
import { loadData, openSession, resetAlertHistory, saveData } from '../core/store';
import type { SavedData } from '../core/store';
import { forgetUser } from '../core/mygesData';
import { runProjectCheck } from '../tasks/projects';
import { log, logError } from '../utils/logger';

export const LOGIN_MODAL_ID = 'loginModal';

// --- ANTI-BRUTEFORCE ---
// Chaque soumission teste un mot de passe auprès de MyGes : sans limite, le bot
// servirait de relais pour deviner un mot de passe, et des échecs répétés
// peuvent faire verrouiller le compte MyGes visé.
// Les essais sont comptés par compte Discord ET par identifiant MyGes : ouvrir
// plusieurs comptes Discord ne permet pas d'insister sur un même identifiant.
// Revers assumé : 5 échecs sur un identifiant bloquent aussi pendant 15 min son
// vrai titulaire s'il n'est pas encore connecté au bot, ce qui vaut mieux qu'un
// compte MyGes verrouillé. Un essai pendant une panne de MyGes ne compte pas.
const MAX_ATTEMPTS = 5;
const WINDOW_MS = 15 * 60 * 1000;
const attempts = new Map<string, number[]>();

/**
 * Enregistre une tentative pour chaque clé ; renvoie le délai d'attente restant
 * (ms) si l'une d'elles a atteint la limite (rien n'est alors enregistré).
 */
function throttle(keys: string[]): number {
    const now = Date.now();
    // Ménage : la map ne garde que les clés ayant servi récemment.
    for (const [key, list] of attempts) {
        if (list.every((t) => now - t >= WINDOW_MS)) attempts.delete(key);
    }
    const recent = keys.map((key) => (attempts.get(key) ?? []).filter((t) => now - t < WINDOW_MS));
    const wait = Math.max(0, ...recent.map((list) => (list.length >= MAX_ATTEMPTS ? WINDOW_MS - (now - list[0]) : 0)));
    if (!wait) keys.forEach((key, i) => attempts.set(key, [...recent[i], now]));
    return wait;
}

/** Retire le dernier essai enregistré pour chaque clé. */
function forgive(keys: string[]) {
    for (const key of keys) attempts.get(key)?.pop();
}

/** Forme canonique d'un identifiant MyGes : « P.Nom » et « p.nom » sont un même compte. */
const accountKey = (username: string) => username.normalize('NFKC').toLowerCase();

/** Vrai si les identifiants enregistrés sont ceux du même compte MyGes. */
function sameAccount(creds: SavedData['users'][string], username: string): boolean {
    try {
        return accountKey(decrypt(creds.user)) === accountKey(username);
    } catch {
        return false; // anciens identifiants illisibles : on ne peut rien supposer
    }
}

const command: Command = {
    data: new SlashCommandBuilder()
        .setName('login')
        .setDescription('Connexion à MyGes pour accéder à tes données personnalisées'),

    execute: async (interaction: ChatInputCommandInteraction) => {
        const modal = new ModalBuilder().setCustomId(LOGIN_MODAL_ID).setTitle('Connexion MyGes 🔐');

        const userInput = new TextInputBuilder()
            .setCustomId('usernameInput')
            .setLabel('Identifiant (p.nom)')
            .setPlaceholder('p.nom')
            .setStyle(TextInputStyle.Short)
            .setMaxLength(100)
            .setRequired(true);

        const passInput = new TextInputBuilder()
            .setCustomId('passwordInput')
            .setLabel('Mot de passe')
            .setPlaceholder('Ton mot de passe')
            .setStyle(TextInputStyle.Short) // Masqué à l'envoi, mais visible à la frappe (limitation Discord)
            .setMaxLength(200)
            .setRequired(true);

        const row1 = new ActionRowBuilder<TextInputBuilder>().addComponents(userInput);
        const row2 = new ActionRowBuilder<TextInputBuilder>().addComponents(passInput);
        modal.addComponents(row1, row2);

        await interaction.showModal(modal);
    },
};

// Traitement de la soumission du formulaire de connexion.
export async function handleLoginModal(interaction: ModalSubmitInteraction) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const username = interaction.fields.getTextInputValue('usernameInput').trim();
    const password = interaction.fields.getTextInputValue('passwordInput');

    // Reconnexion au compte MyGes déjà enregistré (mot de passe changé…) : seul
    // le compteur du compte Discord s'applique. Sinon, un tiers qui épuiserait
    // les essais sur cet identifiant empêcherait son titulaire de se reconnecter.
    // (loadData en premier : il prépare aussi la clé de l'empreinte ci-dessous.)
    const saved = loadData().users[interaction.user.id];
    const usernameKey = `myges:${accountKey(username)}`;

    // Jamais l'identifiant saisi en clair dans les journaux : un mot de passe
    // tapé dans le mauvais champ y resterait. Son empreinte suffit à repérer
    // des essais groupés sur un même compte.
    const who = `${interaction.user.id}, identifiant ${fingerprint(accountKey(username)).slice(0, 8)}`;

    const throttleKeys = saved && sameAccount(saved, username) ? [interaction.user.id] : [interaction.user.id, usernameKey];
    const wait = throttle(throttleKeys);
    if (wait > 0) {
        log('AUTH', `Connexion refusée (trop de tentatives) : ${who}`);
        await interaction.editReply({
            content: `⏳ **Trop de tentatives de connexion.** Réessaie dans ${Math.ceil(wait / 60_000)} min.`,
        });
        return;
    }

    try {
        const token = await GesAPI.login(username, password);

        // Sauvegarde Disque Chiffrée (avant la session pour que __refresh
        // puisse relire les identifiants en cas de 401)
        const data = loadData();
        const previous = data.users[interaction.user.id];
        data.users[interaction.user.id] = {
            user: encrypt(username),
            pass: encrypt(password),
        };
        // Autre compte MyGes que le précédent : ce que les alertes ont déjà vu
        // ne le concerne pas (toutes ses notes partiraient en MP d'un coup).
        const alerts = data.alerts[interaction.user.id];
        if (previous && alerts && !sameAccount(previous, username)) resetAlertHistory(alerts);
        saveData(data);

        // Sauvegarde Session (auto-rafraîchissante). Le cache peut contenir les
        // données d'un autre compte MyGes utilisé auparavant : on l'oublie.
        forgetUser(interaction.user.id);
        openSession(interaction.user.id, token);
        // Le compteur du compte Discord, lui, est gardé : des connexions
        // réussies en boucle sollicitent MyGes tout autant.
        attempts.delete(usernameKey);

        await interaction.editReply({
            content: `✅ **Connexion réussie !**\nBonjour **${username}**, je suis connecté à ton compte MyGes.\nTu peux maintenant utiliser \`/agenda\`, \`/notes\`, etc.\n\n🔔 Je t'enverrai aussi en MP tes **nouvelles notes**, un **rappel avant chaque rendu** de projet et les **changements de ton agenda** (cours annulé, déplacé, changement de salle). Réglable avec \`/alertes\`.`,
            allowedMentions: { parse: [] },
        });

        log('AUTH', `Connexion réussie : ${username} (${interaction.user.id})`);

        // Premier check pour charger les données (projets, etc.). Volontairement
        // non attendu : la réponse à l'utilisateur ne doit pas dépendre de l'API.
        void runProjectCheck(interaction.client);
    } catch (error) {
        // Un mot de passe refusé n'est pas une panne : le message doit le dire,
        // sinon l'utilisateur réessaie en boucle des identifiants corrects.
        const unavailable = !(error instanceof BadCredentialsError);
        // MyGes en panne : l'essai ne compte pas, aucun mot de passe n'a été testé.
        if (unavailable) forgive(throttleKeys);
        logError('AUTH', `Échec de connexion (${who})`, unavailable ? error : '(identifiants refusés)');
        await interaction.editReply({
            content: unavailable
                ? `⚠️ **MyGes ne répond pas correctement${error instanceof MyGesError ? ` (erreur ${error.status})` : ''}.**\nCe n'est pas un problème d'identifiants : réessaie dans quelques minutes.`
                : '❌ **Échec de la connexion.**\nIdentifiant ou mot de passe incorrect.',
        });
    }
}

export default command;
