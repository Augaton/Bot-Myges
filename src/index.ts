import { 
    ActivityType, Client, GatewayIntentBits, REST, Routes, 
    SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, 
    StringSelectMenuBuilder, StringSelectMenuOptionBuilder, 
    ComponentType, TextChannel, ButtonBuilder, ButtonStyle,
    Events, MessageFlags, AttachmentBuilder,
    ModalBuilder, TextInputBuilder, TextInputStyle
} from 'discord.js';
import * as dotenv from 'dotenv';
import * as fs from 'fs';
import { GesAPI } from './myges/ges-api'; 
import { TimetableService } from './myges/services/timetable';
import { ProfileService } from './myges/services/profile';
import { ProjectService } from './myges/services/project';
import { SchoolService } from './myges/services/school';
import { encrypt, decrypt } from './crypto'; 
import { connect } from 'http2';

dotenv.config();

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

// CONFIGURATION
const CURRENT_YEAR = '2025'; 
const CHECK_INTERVAL = 60 * 60 * 1000; 
const ANNOUNCEMENT_CHANNEL_ID = '1420030852154392709'; // ID du channel Discord pour les annonces
const DB_FILE = './saved_data.json';

// --- GESTION DES DONNÉES ---
interface EncryptedCreds { iv: string; content: string; }
interface SavedData {
    users: { [discordId: string]: { user: EncryptedCreds, pass: EncryptedCreds } };
    knownProjectIds: number[];
}

const sessions = new Map<string, any>();

function loadData(): SavedData {
    if (!fs.existsSync(DB_FILE)) return { users: {}, knownProjectIds: [] };
    return JSON.parse(fs.readFileSync(DB_FILE, 'utf-8'));
}

function saveData(data: SavedData) {
    fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2));
}

// --- UTILITAIRE : Trouver la prochaine étape ---
function getNextStep(project: any) {
    const now = Date.now();
    
    // Si pas d'étapes, on regarde la date de fin globale
    if (!project.steps || project.steps.length === 0) {
        if (project.end_date && parseInt(project.end_date) > now) {
            return {
                date: parseInt(project.end_date),
                type: "Rendu Final",
                desc: "Fin du projet"
            };
        }
        return null; // Projet fini ou sans date
    }

    // On cherche les étapes FUTURES
    const futureSteps = project.steps.filter((s: any) => s.psp_limit_date >= now);
    
    if (futureSteps.length === 0) return null; // Plus d'étapes futures

    // On trie pour avoir la plus proche
    futureSteps.sort((a: any, b: any) => a.psp_limit_date - b.psp_limit_date);
    
    return {
        date: futureSteps[0].psp_limit_date,
        type: futureSteps[0].psp_type || "Étape",
        desc: futureSteps[0].psp_desc || ""
    };
}

function formatToFrenchTime(date: Date) {
    return date.toLocaleTimeString('fr-FR', { 
        hour: '2-digit', 
        minute: '2-digit', 
        timeZone: 'Europe/Paris' 
    });
}

// --- FONCTION STATUT DYNAMIQUE (Intelligente) ---
async function updateBotStatus() {
    const userId = sessions.keys().next().value;
    
    // Si personne n'est co : Absent (Jaune) + "En attente"
    if (!userId) {
        return client.user?.setPresence({
            status: 'idle', // 🌙 Absent
            activities: [{ name: "En attente...", type: ActivityType.Playing }]
        });
    }

    const token = sessions.get(userId);
    const start = new Date();
    const end = new Date(); 
    end.setDate(end.getDate() + 7);

    try {
        const cours = await TimetableService.getTimetable(token, start, end);
        const now = Date.now();
        
        const futurs = cours.filter((c: any) => new Date(c.start_date).getTime() > now);
        futurs.sort((a: any, b: any) => new Date(a.start_date).getTime() - new Date(b.start_date).getTime());

        if (futurs.length > 0) {
            const next = futurs[0];
            const diffMs = new Date(next.start_date).getTime() - now;
            const diffHours = diffMs / (1000 * 60 * 60);
            
            // --- CAS 1 : REPOS (> 48h) ---
            if (diffHours > 48) {
                client.user?.setPresence({
                    status: 'idle', // 🌙 Met le point Jaune (Absent)
                    activities: [{ name: "Repos 😴", type: ActivityType.Listening }]
                });
            } 
            // --- CAS 2 : STREAMING (< 48h) ---
            else {
                const minutesLeft = Math.ceil(diffMs / 60000);
                const nom = next.name.replace(/^T\d+\s-\s/i, '').substring(0, 30); 
                let timeDisplay = minutesLeft > 60 
                    ? `${Math.floor(minutesLeft/60)}h${(minutesLeft%60).toString().padStart(2, '0')}` 
                    : `${minutesLeft}min`;

                client.user?.setPresence({
                    status: 'online',
                    activities: [{ 
                        name: `${next.name.replace(/^T\d+\s-\s/i, '').substring(0, 30)} (dans ${timeDisplay})`, 
                        type: ActivityType.Streaming, 
                        url: "https://www.twitch.tv/discord" 
                    }]
                });
            }
        } else {
            // Pas de cours du tout : Absent
            client.user?.setPresence({
                status: 'idle', // 🌙
                activities: [{ name: "Vacances 🏖️", type: ActivityType.Listening }]
            });
        }
    } catch (e) { 
        console.error("Erreur statut:", e);
    }
}

// --- RECONNEXION AUTO ---
async function autoLoginUsers() {
    const data = loadData();
    const userIds = Object.keys(data.users);
    if (userIds.length === 0) return;
    console.log(`🔄 Reconnexion de ${userIds.length} utilisateurs...`);
    for (const userId of userIds) {
        try {
            const encryptedUser = data.users[userId];
            const token = await GesAPI.login(decrypt(encryptedUser.user), decrypt(encryptedUser.pass));
            sessions.set(userId, token);
            console.log(`✅ ${userId} reconnecté.`);
        } catch (e) { console.error(`❌ Echec reconnexion ${userId}`); }
        await new Promise(r => setTimeout(r, 2000));
    }
}

// --- ALERTE PROJETS ---
async function checkNewProjects() {
    console.log("🔄 Vérification projets...");
    const data = loadData();
    let hasNewData = false;
    const channel = await client.channels.fetch(ANNOUNCEMENT_CHANNEL_ID).catch(()=>null) as TextChannel;
    
    if (!channel) return;

    for (const [userId, token] of sessions) {
        try {
            const projects = await ProjectService.getProjects(token, CURRENT_YEAR);
            for (const p of projects) {
                if (!data.knownProjectIds.includes(p.project_id)) {
                    
                    const nextStep = getNextStep(p);
                    const dateStr = nextStep ? new Date(nextStep.date).toLocaleDateString('fr-FR') : 'Non définie';
                    const typeStep = nextStep ? nextStep.type : 'Lancement';

                    const embed = new EmbedBuilder()
                        .setTitle("🚨 NOUVEAU PROJET !")
                        .setDescription(`Nouveau projet en **${p.course_name}**`)
                        .setColor(0xFF0000)
                        .addFields(
                            { name: 'Nom', value: p.name, inline: true },
                            { name: `📅 ${typeStep}`, value: dateStr, inline: true },
                            { name: 'Objectif', value: p.project_teaching_goals ? p.project_teaching_goals.substring(0, 500) : "Voir MyGes" }
                        )
                        .setFooter({ text: "Alerte MyGes" })
                        .setTimestamp();

                    await channel.send({ embeds: [embed] });
                    data.knownProjectIds.push(p.project_id);
                    hasNewData = true;
                }
            }
        } catch (e) { }
        await new Promise(r => setTimeout(r, 5000));
    }
    if (hasNewData) saveData(data);
}

// --- COMMANDES ---
const commands = [
    new SlashCommandBuilder().setName('login').setDescription('Connexion sécurisée via formulaire popup'),
    new SlashCommandBuilder().setName('logout').setDescription('Déconnexion'),
    new SlashCommandBuilder().setName('prochain').setDescription('Affiche le prochain cours à venir'),
    new SlashCommandBuilder().setName('agenda').setDescription('Voir les cours'),
    new SlashCommandBuilder().setName('notes').setDescription('Bulletin'),
    new SlashCommandBuilder().setName('absences').setDescription('Absences'),
    new SlashCommandBuilder().setName('projets').setDescription('Projets et étapes à venir'),
    new SlashCommandBuilder().setName('profil').setDescription('Mon profil'),
    new SlashCommandBuilder().setName('news').setDescription('Dernières actualités de l\'école'),
    new SlashCommandBuilder().setName('profs').setDescription('Liste de mes professeurs'),
    new SlashCommandBuilder().setName('trombi').setDescription('Affiche le trombinoscope de ta classe'),
    new SlashCommandBuilder().setName('campus').setDescription('Affiche les différents campus de l\'ESGI (Pour le moment que les codes d\'accés'),
    new SlashCommandBuilder().setName('changelog').setDescription('Affiche les dernières nouveautés du bot (v2.0)'),
    new SlashCommandBuilder().setName('help').setDescription('Affiche la liste de toutes les commandes'),
    new SlashCommandBuilder().setName('ping').setDescription('État du bot et de l\'API MyGes'),
].map(c => c.toJSON());

// --- INIT ---
client.once(Events.ClientReady, async () => {
    console.log(`🤖 Bot connecté : ${client.user?.tag}`);
    await autoLoginUsers();
    updateBotStatus(); // Lancement immédiat
    const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN!);
    try { await rest.put(Routes.applicationCommands(client.user!.id), { body: commands }); } catch (e) { console.error(e); }
    setInterval(checkNewProjects, CHECK_INTERVAL);
    setInterval(updateBotStatus, 5 * 60 * 1000); // Mise à jour toutes les 5 min
});

// --- INTERACTIONS ---
client.on('interactionCreate', async interaction => {
    if (interaction.isChatInputCommand()) {
        const { commandName } = interaction;

        if (commandName === 'login') {

            const modal = new ModalBuilder()
                .setCustomId('loginModal')
                .setTitle('Connexion MyGes 🔐');

            const userInput = new TextInputBuilder()
                .setCustomId('usernameInput')
                .setLabel("Identifiant (p.nom)")
                .setPlaceholder("p.nom")
                .setStyle(TextInputStyle.Short)
                .setRequired(true);

            const passInput = new TextInputBuilder()
                .setCustomId('passwordInput')
                .setLabel("Mot de passe")
                .setPlaceholder("Ton mot de passe")
                .setStyle(TextInputStyle.Short) // Masqué à l'envoi, mais visible à la frappe (limitation Discord)
                .setRequired(true);

            // Chaque champ dans sa ligne
            const row1 = new ActionRowBuilder<TextInputBuilder>().addComponents(userInput);
            const row2 = new ActionRowBuilder<TextInputBuilder>().addComponents(passInput);

            modal.addComponents(row1, row2);

            await interaction.showModal(modal);
        }

        if (commandName === 'logout') {
            sessions.delete(interaction.user.id);
            const data = loadData(); delete data.users[interaction.user.id]; saveData(data);
            await interaction.reply({ content: "👋 Déconnecté.", flags: MessageFlags.Ephemeral });
        }

        if (commandName === 'profil') {
            const token = sessions.get(interaction.user.id);
            if (!token) return interaction.reply({ content: "❌ Pas connecté.", flags: MessageFlags.Ephemeral });
            await interaction.deferReply({ flags: MessageFlags.Ephemeral });
            try {
                const p = await ProfileService.getProfile(token);
                const embed = new EmbedBuilder().setTitle(`👤 ${p.firstname} ${p.name}`).setColor(0x5865F2).setThumbnail(p._links?.photo?.href || null).addFields({ name: "Email", value: p.email }, { name: "Classe", value: p.classes?.map((c:any)=>c.name).join(', ')||"?" });
                await interaction.editReply({ embeds: [embed] });
            } catch (e) { await interaction.editReply("❌ Erreur."); }
        }

        // --- PROCHAIN COURS ---
        if (commandName === 'prochain') {
            await interaction.deferReply({ flags: MessageFlags.Ephemeral });
            const token = sessions.get(interaction.user.id);
            if (!token) return interaction.editReply("❌ Connecte-toi d'abord. (/login)");

            try {
                // On regarde sur 7 jours glissants pour gérer les week-ends
                const start = new Date();
                const end = new Date();
                end.setDate(end.getDate() + 7); 

                // Récupération des cours
                const cours = await TimetableService.getTimetable(token, start, end);
                
                // 1. On ne garde que ceux dans le futur (Start > Maintenant)
                const now = Date.now();
                const futurs = cours.filter((c: any) => new Date(c.start_date).getTime() > now);

                if (futurs.length === 0) {
                    return interaction.editReply("🎉 Aucun cours prévu dans les 7 prochains jours ! Repos.");
                }

                // 2. On trie pour avoir le plus proche en premier
                futurs.sort((a: any, b: any) => new Date(a.start_date).getTime() - new Date(b.start_date).getTime());

                // 3. On prend le gagnant
                const c = futurs[0];
                const dateDebut = new Date(c.start_date);
                const dateFin = new Date(c.end_date);
                
                // Nettoyage des données
                const nomCours = c.name.replace(/^T\d+\s-\s/i, '');
                const salle = c.rooms?.[0]?.name || 'Non défini';
                const isDistanciel = salle.toLowerCase().includes('distanciel') || salle.toLowerCase().includes('teams');
                const icon = isDistanciel ? '🏠' : '🏫';
                
                // Timestamp Discord (pour l'affichage "dans X minutes")
                const timestamp = Math.floor(dateDebut.getTime() / 1000);

                const embed = new EmbedBuilder()
                    .setTitle("🏃 Prochain Cours")
                    .setColor(0x2ECC71) // Vert émeraude
                    .setDescription(`**${nomCours}**`)
                    .addFields(
                        { name: '📍 Salle', value: `${icon} **${salle}**`, inline: true },
                        { name: '⏰ Horaire', value: `<t:${timestamp}:t>`, inline: true },
                        { name: '⏳ Début', value: `<t:${timestamp}:R>`, inline: true }
                    )
                    .setFooter({ text: `Fin du cours à ${formatToFrenchTime(dateFin)}` });

                await interaction.editReply({ embeds: [embed] });

            } catch (e) { 
                console.error(e); 
                interaction.editReply("❌ Erreur lors de la récupération."); 
            }
        }

        if (commandName === 'agenda') {
            await interaction.deferReply({ flags: MessageFlags.Ephemeral });
            const token = sessions.get(interaction.user.id);
            if (!token) return interaction.editReply("❌ Connecte-toi d'abord. (/login)");

            // Fonction pour formater l'heure HH:MM (Paris)
            const formatTime = (dateStr: number | string) => {
                return new Date(dateStr).toLocaleTimeString('fr-FR', {
                    hour: '2-digit', 
                    minute: '2-digit',
                    timeZone: 'Europe/Paris'
                });
            };

            const generateAgenda = async (offset: number) => {
                const today = new Date();
                const start = new Date(today);
                const dayOfWeek = start.getDay(); // 0 (Dim) - 6 (Sam)
                const diffToMonday = dayOfWeek === 0 ? -6 : 1 - dayOfWeek; // Si Dimanche, on recule de 6 jours, sinon on va à Lundi
                
                start.setDate(start.getDate() + diffToMonday + (offset * 7));
                start.setHours(0, 0, 0, 0);

                const end = new Date(start);
                end.setDate(end.getDate() + 6);
                end.setHours(23, 59, 59);

                try {
                    const cours = await TimetableService.getTimetable(token, start, end);
                    
                    // Tri chronologique
                    cours.sort((a: any, b: any) => new Date(a.start_date).getTime() - new Date(b.start_date).getTime());

                    const embed = new EmbedBuilder()
                        .setTitle(`📅 Emploi du temps`)
                        .setDescription(`Semaine du **${start.toLocaleDateString('fr-FR')}** au **${end.toLocaleDateString('fr-FR')}**`)
                        .setColor(0x2B2D31)
                        .setTimestamp();

                    if (!cours.length) {
                        embed.setDescription("🏖️ **Aucun cours cette semaine !** Profites-en.");
                        embed.setImage("https://media.giphy.com/media/l0HlHFRbmaZtBRhXG/giphy.gif"); // Optionnel : petit GIF vacances
                    } else {
                        // Regroupement par Jour
                        const days: { [key: string]: any[] } = {};
                        
                        cours.forEach((c: any) => {
                            const dateObj = new Date(c.start_date);
                            // Format: "Lundi 10 Février"
                            const dayKey = dateObj.toLocaleDateString('fr-FR', { 
                                weekday: 'long', 
                                day: 'numeric', 
                                month: 'long',
                                timeZone: 'Europe/Paris'
                            });
                            // Capitalisation (lundi -> Lundi)
                            const dayCap = dayKey.charAt(0).toUpperCase() + dayKey.slice(1);
                            
                            if (!days[dayCap]) days[dayCap] = [];
                            days[dayCap].push(c);
                        });

                        // Construction des champs
                        for (const [dayName, dayCourses] of Object.entries(days)) {
                            let dayContent = "";

                            // Fusion visuelle des cours qui se suivent (optionnel, ici on liste tout proprement)
                            (dayCourses as any[]).forEach((c) => {
                                // Heures
                                const sStr = formatTime(c.start_date);
                                const eStr = formatTime(c.end_date);

                                // Nom du cours nettoyé (Enlever T1/T2...)
                                let courseName = c.name.replace(/^(T\d+\s-\s)/i, '').trim();
                                
                                // Lieu / Modalité
                                let location = "Salle inconnue";
                                let icon = "🏫"; // Par défaut

                                if (c.modality === 'Distanciel') {
                                    location = "Distanciel";
                                    icon = "🏠";
                                } else if (c.rooms && c.rooms.length > 0) {
                                    location = c.rooms[0].name;
                                }

                                // Professeur
                                const prof = c.teacher ? ` • 👨‍🏫 ${c.teacher.replace('M. ', '').replace('Mme ', '')}` : "";
                                dayContent += `\`${sStr} - ${eStr}\` ${icon} **${courseName}**\n└ *${location}${prof}*\n\n`;
                            });

                            embed.addFields({ name: `📆 ${dayName}`, value: dayContent });
                        }
                    }
                    return embed;
                } catch (e) {
                    console.error(e);
                    return new EmbedBuilder().setTitle("Erreur").setDescription("Impossible de récupérer l'agenda.").setColor(0xFF0000);
                }
            };

            let off = 0;
            
            // Boutons de navigation
            const getBtns = (o: number) => new ActionRowBuilder<ButtonBuilder>().addComponents(
                new ButtonBuilder().setCustomId('prev_week').setLabel('⬅️ Semaine préc.').setStyle(ButtonStyle.Secondary),
                new ButtonBuilder().setCustomId('today_week').setLabel('Aujourd\'hui').setStyle(ButtonStyle.Primary).setDisabled(o === 0),
                new ButtonBuilder().setCustomId('next_week').setLabel('Semaine suiv. ➡️').setStyle(ButtonStyle.Secondary)
            );

            const msg = await interaction.editReply({ 
                embeds: [await generateAgenda(off)], 
                components: [getBtns(off)] 
            });

            const col = msg.createMessageComponentCollector({ componentType: ComponentType.Button, time: 60000 });

            col.on('collect', async i => {
                if (i.user.id !== interaction.user.id) return i.reply({ content: 'Pas ton agenda !', flags: MessageFlags.Ephemeral });
                
                await i.deferUpdate(); // Important pour ne pas bloquer le bouton

                if (i.customId === 'prev_week') off--;
                else if (i.customId === 'next_week') off++;
                else if (i.customId === 'today_week') off = 0;

                await interaction.editReply({ 
                    embeds: [await generateAgenda(off)], 
                    components: [getBtns(off)] 
                });
            });
        }

        if (commandName === 'notes') {
            await interaction.deferReply({ flags: MessageFlags.Ephemeral });
            const token = sessions.get(interaction.user.id);
            if (!token) return interaction.editReply("❌ Connecte-toi d'abord. (/login)");

            try {
                const grades: any[] = await ProfileService.getGrades(token, CURRENT_YEAR);
                if (!grades || grades.length === 0) return interaction.editReply("Aucune note disponible.");

                const sems = [...new Set(grades.map((g: any) => g.trimester_name))].filter(Boolean);
                
                // Menu de sélection du semestre
                const selectMenu = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
                    new StringSelectMenuBuilder()
                        .setCustomId('sem_select')
                        .setPlaceholder('📅 Choisis ton trimestre')
                        .addOptions(sems.map((s: any) => ({ label: s, value: s, emoji: '🎓' })))
                );

                const initialMsg = await interaction.editReply({ 
                    content: "Veuillez sélectionner un trimestre :", 
                    components: [selectMenu] 
                });

                const menuCollector = initialMsg.createMessageComponentCollector({ 
                    componentType: ComponentType.StringSelect, 
                    time: 60000 
                });

                menuCollector.on('collect', async menuInter => {
                    if (menuInter.user.id !== interaction.user.id) return;
                    
                    const semesterName = menuInter.values[0];
                    const selectedGrades = grades.filter((g: any) => g.trimester_name === semesterName);
                    
                    // Tri par nom de matière
                    selectedGrades.sort((a, b) => (a.course || "").localeCompare(b.course || ""));

                    let index = 0;

                    // --- FONCTION GÉNÉRATION DE LA CARTE ---
                    const generateGradeCard = (i: number) => {
                        const g = selectedGrades[i];
                        
                        // Nettoyage du nom (ex: "T1 - anglais" -> "Anglais")
                        const courseName = (g.course || "Matière inconnue").replace(/^T\d+\s-\s/i, '');
                        const prof = g.teacher_last_name ? `👨‍🏫 ${g.teacher_first_name || ""} ${g.teacher_last_name}` : "";

                        // Calcul de la couleur selon la moyenne
                        let color = 0x95A5A6; // Gris par défaut
                        let mention = "";
                        let avgDisplay = "N/A";

                        // On utilise g.average s'il existe (note finale validée)
                        // Sinon on regarde s'il y a une moyenne CC (ccaverage)
                        let finalNote = g.average;
                        
                        if (finalNote !== null && finalNote !== undefined) {
                            const note = parseFloat(finalNote);
                            avgDisplay = `${note.toFixed(2)}/20`;
                            if (note >= 16) { color = 0xF1C40F; mention = "🏆 Excellent"; }
                            else if (note >= 14) { color = 0x2ECC71; mention = "✅ Bien"; }
                            else if (note >= 10) { color = 0x0099FF; mention = "👌 Validé"; }
                            else { color = 0xE74C3C; mention = "⚠️ Rattrapage"; }
                        } else if (g.ccaverage > 0) {
                            // Si pas de moyenne générale mais une moyenne CC
                            avgDisplay = `~${g.ccaverage}/20 (CC)`;
                            color = 0x3498DB; // Bleu (En cours)
                        }

                        // --- LOGIQUE D'AFFICHAGE DES NOTES CC (TABLEAU DE NOMBRES) ---
                        let ccContent = "-";
                        
                        if (g.grades && Array.isArray(g.grades) && g.grades.length > 0) {
                            // Ici g.grades = [12.5, 14, 8] par exemple
                            const details = g.grades.map((val: number, idx: number) => {
                                return `• Note ${idx + 1} : **${val}/20**`;
                            }).join('\n');
                            
                            ccContent = `${details}\n\n👉 **Moy. CC : ${g.ccaverage ?? "?"}/20**`;
                        } else if (g.ccaverage !== null && g.ccaverage !== 0) {
                            ccContent = `**${g.ccaverage}/20**`;
                        } else {
                            ccContent = "Aucune note";
                        }

                        // Absences
                        const absText = g.absences > 0 ? `🚫 **${g.absences}** abs.` : "✅ 0";

                        const embed = new EmbedBuilder()
                            .setTitle(`📘 ${courseName}`)
                            .setDescription(`${prof}\n*${semesterName}*`)
                            .setColor(color)
                            .addFields(
                                { name: '📊 Moyenne Générale', value: `# ${avgDisplay}\n${mention}`, inline: false },
                                { name: '📝 Contrôle Continu', value: ccContent, inline: true },
                                { name: '🎓 Examen Final', value: g.exam ? `**${g.exam}/20**` : "-", inline: true },
                                { name: 'Assiduité', value: absText, inline: true }
                            )
                            .setFooter({ text: `Matière ${i + 1} / ${selectedGrades.length} • Crédits: ${g.ects || "?"}` });

                        return embed;
                    };

                    const getNavButtons = (idx: number) => new ActionRowBuilder<ButtonBuilder>().addComponents(
                        new ButtonBuilder().setCustomId('prev_g').setLabel('⬅️').setStyle(ButtonStyle.Secondary).setDisabled(idx === 0),
                        new ButtonBuilder().setCustomId('next_g').setLabel('➡️').setStyle(ButtonStyle.Secondary).setDisabled(idx === selectedGrades.length - 1)
                    );

                    await menuInter.update({ 
                        content: null, 
                        embeds: [generateGradeCard(index)], 
                        components: [getNavButtons(index)] 
                    });

                    const buttonCollector = initialMsg.createMessageComponentCollector({ 
                        componentType: ComponentType.Button, 
                        time: 120000 
                    });

                    buttonCollector.on('collect', async btnInter => {
                        if (btnInter.user.id !== interaction.user.id) return btnInter.reply({ content: "Non.", flags: MessageFlags.Ephemeral });
                        await btnInter.deferUpdate();

                        if (btnInter.customId === 'prev_g') index--;
                        else if (btnInter.customId === 'next_g') index++;

                        if (index < 0) index = 0;
                        if (index >= selectedGrades.length) index = selectedGrades.length - 1;

                        await interaction.editReply({
                            embeds: [generateGradeCard(index)],
                            components: [getNavButtons(index)]
                        });
                    });
                });

            } catch(e) { 
                console.error(e); 
                interaction.editReply("❌ Erreur notes."); 
            }
        }

        if (commandName === 'absences') {
            await interaction.deferReply({ flags: MessageFlags.Ephemeral });
            const token = sessions.get(interaction.user.id);
            if (!token) return interaction.editReply("❌ Connecte-toi.");
            const abs = await ProfileService.getAbsences(token, CURRENT_YEAR);
            const embed = new EmbedBuilder().setTitle(`🚫 Absences (${abs.length})`).setColor(0xFF0000);
            if(!abs.length) embed.setDescription("Aucune absence !");
            else abs.slice(0,10).forEach((a:any) => embed.addFields({name: a.course_name, value: `📅 ${new Date(a.date).toLocaleDateString()} - ${a.justified?'✅':'❌ INJUSTIFIÉE'}`}));
            await interaction.editReply({ embeds: [embed] });
        }

        // --- PROJETS (AVEC LOGIQUE DES ÉTAPES) ---
        if (commandName === 'projets') {
            await interaction.deferReply({ flags: MessageFlags.Ephemeral });
            const token = sessions.get(interaction.user.id);
            if (!token) return interaction.editReply("❌ Connecte-toi.");

            try {
                const projects = await ProjectService.getProjects(token, CURRENT_YEAR);
                const now = Date.now();
                
                // On filtre les projets terminés (sauf s'ils ont une soutenance future)
                const activeProjects: any[] = [];
                
                projects.forEach((p: any) => {
                    const nextStep = getNextStep(p);
                    // Si une étape future existe, on garde le projet
                    if (nextStep) {
                        // On injecte les infos de l'étape directement dans l'objet projet pour l'affichage
                        p._nextStep = nextStep; 
                        activeProjects.push(p);
                    }
                });

                if (activeProjects.length === 0) return interaction.editReply("🎉 Aucun projet en cours !");

                // Tri : Du plus urgent au moins urgent
                activeProjects.sort((a, b) => a._nextStep.date - b._nextStep.date);

                const embed = new EmbedBuilder().setTitle("📂 Projets et Deadlines").setColor(0xFFA500);

                activeProjects.slice(0, 10).forEach((p: any) => {
                    const step = p._nextStep;
                    const dateRendu = new Date(step.date).toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long' });
                    const desc = p.project_teaching_goals ? (p.project_teaching_goals.substring(0, 80) + '...') : "Pas de description";
                    
                    // Calcul du temps restant
                    const diffDays = Math.ceil((step.date - now) / (1000 * 60 * 60 * 24));
                    const alertEmoji = diffDays <= 3 ? "🔥" : (diffDays <= 7 ? "⚠️" : "⏳");

                    embed.addFields({
                        name: `${alertEmoji} ${p.name}`,
                        value: `📚 **${p.course_name}**\n🎯 **Prochaine étape : ${step.type}**\n📅 Pour le ${dateRendu} (dans ${diffDays}j)\n> *${desc}*`
                    });
                });

                await interaction.editReply({ embeds: [embed] });

            } catch (e) { console.error(e); await interaction.editReply("❌ Erreur projets."); }
        }

        if (commandName === 'news') {
            await interaction.deferReply({ flags: MessageFlags.Ephemeral });
            const token = sessions.get(interaction.user.id);
            if (!token) return interaction.editReply("❌ Connecte-toi.");

            try {
                const newsData: any = await SchoolService.getNews(token);
                // L'API renvoie souvent une pagination { content: [...] }
                const newsList = newsData.content || newsData;

                if (!newsList || newsList.length === 0) return interaction.editReply("Aucune actualité.");

                const embed = new EmbedBuilder().setTitle("📰 Actualités de l'école").setColor(0x00AEEF);

                // On prend les 5 dernières
                newsList.slice(0, 5).forEach((n: any) => {
                    const date = new Date(n.date).toLocaleDateString('fr-FR');
                    // On coupe le titre s'il est trop long
                    let title = n.title || "Sans titre";
                    if (title.length > 250) title = title.substring(0, 250) + "...";
                    
                    embed.addFields({ name: `📅 ${date} - ${title}`, value: `> ${n.author || 'Administration'}` });
                });

                await interaction.editReply({ embeds: [embed] });
            } catch (e) { console.error(e); interaction.editReply("❌ Erreur news."); }
        }

        // --- PROFS (MODE TROMBINOSCOPE) ---
        if (commandName === 'profs') {
            await interaction.deferReply({ flags: MessageFlags.Ephemeral });
            const token = sessions.get(interaction.user.id);
            if (!token) return interaction.editReply("❌ Connecte-toi d'abord. (/login)");

            try {
                const teachers: any[] = await SchoolService.getTeachers(token, CURRENT_YEAR);
                
                if (!teachers || teachers.length === 0) return interaction.editReply("Aucun professeur trouvé pour cette année.");

                // Tri alphabétique par nom de famille
                teachers.sort((a, b) => a.lastname.localeCompare(b.lastname));

                let index = 0;

                // Fonction d'affichage d'un prof
                const showTeacher = async (i: number) => {
                    const t = teachers[i];
                    
                    // Extraction de l'URL de la photo (même structure que pour les élèves)
                    let photoUrl = null;
                    if (t.links && Array.isArray(t.links)) {
                        const photoObj = t.links.find((l: any) => l.rel === 'photo');
                        if (photoObj) photoUrl = photoObj.href;
                    }

                    let files: AttachmentBuilder[] = [];

                    const embed = new EmbedBuilder()
                        .setTitle("👨‍🏫 Mes Professeurs")
                        .setDescription(`Professeur ${i + 1}/${teachers.length}`)
                        .setColor(0xF1C40F) // Jaune
                        .addFields(
                            { name: 'Nom', value: `**${t.firstname} ${t.lastname}**`, inline: true },
                            { name: 'Email', value: t.email ? `📧 ${t.email}` : "Non renseigné", inline: false }
                        )
                        .setFooter({ text: `ID: ${t.uid || "N/A"}` });

                    // Gestion de l'image (Téléchargement sécurisé)
                    if (photoUrl) {
                        try {
                            // On tente d'abord en public, sinon avec le token
                            let response = await fetch(photoUrl);
                            
                            if (!response.ok) {
                                response = await fetch(photoUrl, {
                                    headers: { 'Authorization': `${token.token_type} ${token.access_token}` }
                                });
                            }

                            if (response.ok) {
                                const buffer = Buffer.from(await response.arrayBuffer());
                                const attachment = new AttachmentBuilder(buffer, { name: 'teacher.jpg' });
                                files = [attachment];
                                embed.setImage('attachment://teacher.jpg');
                            }
                        } catch (err) {
                            console.error("Erreur image prof:", err);
                        }
                    } else {
                        // Si pas de photo, on peut mettre une image par défaut ou rien
                        // embed.setThumbnail('https://i.imgur.com/3Z5Q5z.png'); // Exemple d'avatar générique
                    }

                    const buttons = new ActionRowBuilder<ButtonBuilder>().addComponents(
                        new ButtonBuilder().setCustomId('prev_t').setLabel('⬅️').setStyle(ButtonStyle.Primary).setDisabled(i === 0),
                        new ButtonBuilder().setCustomId('next_t').setLabel('➡️').setStyle(ButtonStyle.Primary).setDisabled(i === teachers.length - 1)
                    );

                    return { embeds: [embed], components: [buttons], files: files };
                };

                // Premier affichage
                const payload = await showTeacher(index);
                const msg = await interaction.editReply(payload);

                // Collecteur
                const collector = msg.createMessageComponentCollector({ componentType: ComponentType.Button, time: 300000 }); // 5 min

                collector.on('collect', async i => {
                    if (i.user.id !== interaction.user.id) return i.reply({ content: "Pas touche !", flags: MessageFlags.Ephemeral });
                    
                    await i.deferUpdate();

                    if (i.customId === 'prev_t') index--;
                    else if (i.customId === 'next_t') index++;

                    // Bornage
                    if (index < 0) index = 0;
                    if (index >= teachers.length) index = teachers.length - 1;

                    const newPayload = await showTeacher(index);
                    await interaction.editReply(newPayload);
                });

            } catch (e) { 
                console.error(e); 
                interaction.editReply("❌ Erreur lors de la récupération des professeurs."); 
            }
        }

        if (commandName === 'trombi') {
            await interaction.deferReply({ flags: MessageFlags.Ephemeral });
            const token = sessions.get(interaction.user.id);
            if (!token) return interaction.editReply("❌ Connecte-toi d'abord. (/login)");

            try {
                // 1. Récupérer les classes
                const classes: any[] = await SchoolService.getMyClasses(token, CURRENT_YEAR);
                if (!classes || classes.length === 0) return interaction.editReply("❌ Aucune classe trouvée.");

                const maClasse = classes[0];
                const classId = maClasse.id || maClasse.class_id || maClasse.puid;
                
                // 2. Récupérer les élèves
                const students: any[] = await SchoolService.getClassmates(token, classId);
                if (!students || students.length === 0) return interaction.editReply("❌ Aucun élève trouvé.");

                // Tri alphabétique
                students.sort((a, b) => a.lastname.localeCompare(b.lastname));

                let index = 0;

                const showStudent = async (i: number) => {
                    const s = students[i];
                    
                    // --- CORRECTION DU PARSING ICI ---
                    // On cherche l'élément dans le tableau 'links' qui a rel === 'photo'
                    let photoUrl = null;
                    if (s.links && Array.isArray(s.links)) {
                        const photoObj = s.links.find((l: any) => l.rel === 'photo');
                        if (photoObj) photoUrl = photoObj.href;
                    }
                    
                    let files: AttachmentBuilder[] = [];

                    const embed = new EmbedBuilder()
                        .setTitle(`📸 Trombinoscope - ${maClasse.name || "Classe"}`)
                        .setDescription(`Étudiant ${i + 1}/${students.length}`)
                        .setColor(0x0099FF)
                        .addFields(
                            { name: 'Nom', value: `**${s.firstname} ${s.lastname}**`, inline: true },
                            { name: 'Email', value: s.email || "Non renseigné", inline: true }
                        )
                        .setFooter({ text: `ID: ${s.uid || "N/A"}` });

                    // TÉLÉCHARGEMENT DE L'IMAGE
                    if (photoUrl) {
                        try {
                            // Note : Comme l'URL contient "public", on essaie d'abord sans token
                            // Si ça échoue, on pourrait réessayer avec, mais souvent "public" = accès direct.
                            // Cependant, Discord a parfois du mal avec ces liens, donc on le télécharge nous-mêmes.
                            const response = await fetch(photoUrl);

                            if (response.ok) {
                                const buffer = Buffer.from(await response.arrayBuffer());
                                const attachment = new AttachmentBuilder(buffer, { name: 'profile.jpg' });
                                files = [attachment];
                                embed.setImage('attachment://profile.jpg');
                            } else {
                                // Fallback : Si l'accès public échoue, on tente avec le token
                                const responseAuth = await fetch(photoUrl, {
                                    headers: { 'Authorization': `${token.token_type} ${token.access_token}` }
                                });
                                if (responseAuth.ok) {
                                    const buffer = Buffer.from(await responseAuth.arrayBuffer());
                                    const attachment = new AttachmentBuilder(buffer, { name: 'profile.jpg' });
                                    files = [attachment];
                                    embed.setImage('attachment://profile.jpg');
                                }
                            }
                        } catch (err) {
                            console.error("Erreur image:", err);
                        }
                    }

                    const buttons = new ActionRowBuilder<ButtonBuilder>().addComponents(
                        new ButtonBuilder().setCustomId('prev_s').setLabel('⬅️').setStyle(ButtonStyle.Primary).setDisabled(i === 0),
                        new ButtonBuilder().setCustomId('next_s').setLabel('➡️').setStyle(ButtonStyle.Primary).setDisabled(i === students.length - 1)
                    );

                    return { embeds: [embed], components: [buttons], files: files };
                };

                const payload = await showStudent(index);
                const msg = await interaction.editReply(payload);

                const collector = msg.createMessageComponentCollector({ componentType: ComponentType.Button, time: 300000 });

                collector.on('collect', async i => {
                    if (i.user.id !== interaction.user.id) return i.reply({ content: "Pas touche !", flags: MessageFlags.Ephemeral });
                    await i.deferUpdate();

                    if (i.customId === 'prev_s') index--;
                    else if (i.customId === 'next_s') index++;

                    if (index < 0) index = 0;
                    if (index >= students.length) index = students.length - 1;

                    const newPayload = await showStudent(index);
                    await interaction.editReply(newPayload);
                });

            } catch (e) {
                console.error(e);
                interaction.editReply("❌ Erreur technique.");
            }
        }

        if (commandName === 'campus') {
            await interaction.deferReply({ flags: MessageFlags.Ephemeral });

            const token = sessions.get(interaction.user.id);
            if (!token) return interaction.editReply("❌ Connecte-toi d'abord. (/login)");

            const embed = new EmbedBuilder()
                .setTitle("🏫 Campus & Codes d'accès")
                .setDescription("Retrouvez ci-dessous les adresses et les codes d'entrée des différents bâtiments du réseau.")
                .setColor(0x3498DB) // Un joli Bleu "Peter River" (plus moderne que le rouge sombre)
                .setThumbnail(client.user?.displayAvatarURL() || null)
                .addFields(
                    { 
                        name: "🏢 Nation 1 & 2", 
                        value: "📍 *242 Rue du Faubourg Saint-Antoine, 75012 Paris*\n🔑 Code : **38950**" 
                    },
                    { 
                        name: "🏢 Erard", 
                        value: "📍 *21 Rue Erard, 75012 Paris*\n🔑 Code : **2125**" 
                    },
                    { 
                        name: "🎨 Voltaire 1 (Studio Crea)", 
                        value: "📍 *1 Rue Bouvier, 75011 Paris*\n🔑 Code : **1175**" 
                    },
                    { 
                        name: "📷 Voltaire 2 (Efet)", 
                        value: "📍 *1 Rue Bouvier, 75011 Paris*\n🔑 Code : **1175**" 
                    },
                    { 
                        name: "🏛️ Rauch", 
                        value: "📍 *15 Rue Rames, 75012 Paris*\n🔑 Code : **2804**" 
                    }
                )
                .setFooter({ text: "Gardez ces codes pour vous ! 🤫" })
                .setTimestamp();

            await interaction.editReply({ embeds: [embed] });
        }

        if (commandName === 'help') {
            await interaction.deferReply({ flags: MessageFlags.Ephemeral });

            const embed = new EmbedBuilder()
                .setTitle("🤖 Guide des Commandes")
                .setDescription("Voici tout ce que je peux faire pour toi :")
                .setColor(0x5865F2) // Blurple Discord
                .setThumbnail(client.user?.displayAvatarURL() || null)
                .addFields(
                    { 
                        name: "🔐 Gestion du Compte", 
                        value: "` /login ` : Se connecter (via formulaire sécurisé)\n` /logout ` : Se déconnecter\n` /profil ` : Voir mon profil étudiant" 
                    },
                    { 
                        name: "📅 Organisation", 
                        value: "` /agenda ` : Emploi du temps de la semaine\n` /prochain ` : Le prochain cours à venir (Compte à rebours)\n` /projets ` : Liste des projets et deadlines" 
                    },
                    { 
                        name: "🎓 Scolarité", 
                        value: "` /notes ` : Bulletin de notes et moyennes\n` /absences ` : Liste des absences" 
                    },
                    { 
                        name: "🏫 Vie de l'École", 
                        value: "` /trombi ` : Voir les élèves de ta classe\n` /profs ` : Liste et emails de tes intervenants\n` /campus ` : Codes d'accès et adresses\n` /news ` : Actualités de l'école" 
                    },
                    { 
                        name: "⚙️ Système", 
                        value: "` /ping ` : Vérifier l'état du bot et de MyGes\n` /changelog ` : Voir les dernières mises à jour" 
                    }
                )
                .setFooter({ text: "Bot développé avec ❤️" });

            await interaction.editReply({ embeds: [embed] });
        }

        // --- PING (Latence & État API) ---
        if (commandName === 'ping') {
            await interaction.deferReply();
            const sent = await interaction.fetchReply();
            
            const roundtripLatency = sent.createdTimestamp - interaction.createdTimestamp;
            const wsLatency = client.ws.ping;

            // Test Latence API MyGes
            let apiStatus = "🔴 Hors Ligne";
            let apiColor = 0xFF0000;
            let apiTime = 0;
            let apiMsg = "L'API ne répond pas.";

            try {
                const start = Date.now();
                // On ping la racine de l'API Kordis
                const response = await fetch('https://api.kordis.fr', { method: 'HEAD' });
                apiTime = Date.now() - start;
                
                if (response.status < 500) { // Si c'est 200, 401 ou 403, le serveur est vivant
                    apiStatus = "🟢 En Ligne";
                    apiColor = 0x2ECC71;
                    apiMsg = "Opérationnel";
                } else {
                    apiStatus = "🟠 Instable"; // Erreur 5xx
                    apiColor = 0xE67E22;
                }
            } catch (e) {
                console.error("Erreur ping API:", e);
            }

            const embed = new EmbedBuilder()
                .setTitle("🏓 Pong !")
                .setColor(apiColor)
                .addFields(
                    { 
                        name: "🤖 Bot Discord", 
                        value: `**Latence :** ${roundtripLatency}ms\n**WebSocket :** ${wsLatency}ms`, 
                        inline: true 
                    },
                    { 
                        name: "🌐 API MyGes", 
                        value: `**État :** ${apiStatus}\n**Réponse :** ${apiTime}ms`, 
                        inline: true 
                    }
                )
                .setFooter({ text: apiMsg });

            await interaction.editReply({ embeds: [embed] });
        }


        // --- CHANGELOG ---
        if (commandName === 'changelog') {
            await interaction.deferReply({ flags: MessageFlags.Ephemeral });

            const embed = new EmbedBuilder()
                .setTitle("📢 Mise à jour v2.1 - \"Secure & Helpful\"")
                .setDescription("Une mise à jour axée sur la **sécurité** et l'**utilitaire**. Voici les nouveautés :")
                .setColor(0xFF00FF) // Magenta pour le style "Update"
                .setThumbnail(client.user?.displayAvatarURL() || null)
                .addFields(
                    { 
                        name: "🔐 Login Sécurisé (Modale)", 
                        value: "> **Fini les mots de passe dans le chat !**\n> La commande `/login` ouvre désormais un **formulaire popup** privé et sécurisé. Vos identifiants sont chiffrés." 
                    },
                    { 
                        name: "🆘 Nouveau Menu d'Aide (/help)", 
                        value: "> Perdu ? La commande `/help` affiche un **guide complet** et catégorisé de toutes les fonctionnalités du bot." 
                    },
                    { 
                        name: "🏓 Diagnostic Réseau (/ping)", 
                        value: "> MyGes rame ? Vérifiez-le avec `/ping`. Le bot analyse sa latence et **teste l'état de l'API de l'école** en temps réel (🟢 En ligne / 🔴 Hors ligne)." 
                    },
                    { 
                        name: "🏫 Campus V2 (/campus)", 
                        value: "> Ajout des **adresses postales** précises pour chaque bâtiment (Nation, Erard, Voltaire...).\n> Nouveau design bleu plus lisible." 
                    },
                    {
                        name: "⚙️ Optimisations",
                        value: "• Correction des avertissements Discord (Deprecation Warnings).\n• Amélioration de la stabilité de la connexion."
                    }
                )
                .setFooter({ text: "Merci d'utiliser le bot ! 🚀" })
                .setTimestamp();

            await interaction.editReply({ embeds: [embed] });
        }

        
    }
    else if (interaction.isModalSubmit()) { 
        if (interaction.customId === 'loginModal') {
            // On met le bot en attente (Ephemeral)
            await interaction.deferReply({ flags: MessageFlags.Ephemeral });

            // Récupération des données saisies dans le formulaire
            const username = interaction.fields.getTextInputValue('usernameInput');
            const password = interaction.fields.getTextInputValue('passwordInput');

            try {
                // Tentative de connexion API
                const token = await GesAPI.login(username, password);
                
                // Sauvegarde Session
                sessions.set(interaction.user.id, token);
                
                // Sauvegarde Disque Chiffrée
                const data = loadData();
                data.users[interaction.user.id] = { 
                    user: encrypt(username), 
                    pass: encrypt(password) 
                };
                saveData(data);

                await interaction.editReply({ 
                    content: `✅ **Connexion réussie !**\nBonjour **${username}**, je suis connecté à ton compte MyGes.\nTu peux maintenant utiliser \`/agenda\`, \`/notes\`, etc.` 
                });

                // Premier check pour charger les données (projets, etc.)
                checkNewProjects();
                updateBotStatus();

            } catch (error) {
                console.error(error);
                await interaction.editReply({ 
                    content: "❌ **Échec de la connexion.**\nVérifie tes identifiants.\n*(Si le problème persiste, MyGes est peut-être en maintenance)*" 
                });
            }
        }
    }
});

client.login(process.env.DISCORD_TOKEN);