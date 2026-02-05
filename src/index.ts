import {ActivityType, Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, StringSelectMenuBuilder, StringSelectMenuOptionBuilder, ComponentType, TextChannel, ButtonBuilder, ButtonStyle } from 'discord.js';
import * as dotenv from 'dotenv';
import * as fs from 'fs';
import { GesAPI } from './myges/ges-api'; 
import { TimetableService } from './myges/services/timetable';
import { ProfileService } from './myges/services/profile';
import { ProjectService } from './myges/services/project';
import { SchoolService } from './myges/services/school';
import { encrypt, decrypt } from './crypto'; 

dotenv.config();

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

// CONFIGURATION
const CURRENT_YEAR = '2025'; 
const CHECK_INTERVAL = 60 * 60 * 1000; 
const ANNOUNCEMENT_CHANNEL_ID = '1468606122905571523'; // ID du channel Discord pour les annonces
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
                let timeDisplay = `${minutesLeft} min`;
                if (minutesLeft > 60) timeDisplay = `${Math.floor(minutesLeft/60)}h${minutesLeft%60}`;

                client.user?.setPresence({
                    status: 'online', // Le streaming force le violet, mais on met online par précaution
                    activities: [{ 
                        name: `${nom} (dans ${timeDisplay})`, 
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
    new SlashCommandBuilder().setName('login').setDescription('Connexion sécurisée').addStringOption(o => o.setName('user').setDescription('ID').setRequired(true)).addStringOption(o => o.setName('pass').setDescription('MDP').setRequired(true)),
    new SlashCommandBuilder().setName('logout').setDescription('Déconnexion'),
    new SlashCommandBuilder().setName('prochain').setDescription('Affiche le prochain cours à venir'),
    new SlashCommandBuilder().setName('agenda').setDescription('Voir les cours'),
    new SlashCommandBuilder().setName('notes').setDescription('Bulletin'),
    new SlashCommandBuilder().setName('absences').setDescription('Absences'),
    new SlashCommandBuilder().setName('projets').setDescription('Projets et étapes à venir'),
    new SlashCommandBuilder().setName('profil').setDescription('Mon profil'),
    new SlashCommandBuilder().setName('news').setDescription('Dernières actualités de l\'école'),
    new SlashCommandBuilder().setName('profs').setDescription('Liste de mes professeurs'),
].map(c => c.toJSON());

// --- INIT ---
client.once('ready', async () => {
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
    if (!interaction.isChatInputCommand()) return;
    const { commandName } = interaction;

    if (commandName === 'login') {
        await interaction.deferReply({ ephemeral: true });
        try {
            const token = await GesAPI.login(interaction.options.getString('user', true), interaction.options.getString('pass', true)); 
            sessions.set(interaction.user.id, token);
            const data = loadData();
            data.users[interaction.user.id] = { user: encrypt(interaction.options.getString('user', true)), pass: encrypt(interaction.options.getString('pass', true)) };
            saveData(data);
            await interaction.editReply("✅ Connexion chiffrée réussie !");
            checkNewProjects();
        } catch (error) { await interaction.editReply("❌ Identifiants incorrects."); }
    }

    if (commandName === 'logout') {
        sessions.delete(interaction.user.id);
        const data = loadData(); delete data.users[interaction.user.id]; saveData(data);
        await interaction.reply({ content: "👋 Déconnecté.", ephemeral: true });
    }

    if (commandName === 'profil') {
        const token = sessions.get(interaction.user.id);
        if (!token) return interaction.reply({ content: "❌ Pas connecté.", ephemeral: true });
        await interaction.deferReply({ ephemeral: true });
        try {
            const p = await ProfileService.getProfile(token);
            const embed = new EmbedBuilder().setTitle(`👤 ${p.firstname} ${p.name}`).setColor(0x5865F2).setThumbnail(p._links?.photo?.href || null).addFields({ name: "Email", value: p.email }, { name: "Classe", value: p.classes?.map((c:any)=>c.name).join(', ')||"?" });
            await interaction.editReply({ embeds: [embed] });
        } catch (e) { await interaction.editReply("❌ Erreur."); }
    }

    // --- PROCHAIN COURS ---
    if (commandName === 'prochain') {
        await interaction.deferReply({ ephemeral: true });
        const token = sessions.get(interaction.user.id);
        if (!token) return interaction.editReply("❌ Connecte-toi d'abord.");

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
                    { name: '⏰ Horaire', value: `<t:${timestamp}:t>`, inline: true }, // Affiche "10:30"
                    { name: '⏳ Début', value: `<t:${timestamp}:R>`, inline: true }   // Affiche "dans 15 minutes"
                )
                .setFooter({ text: `Fin du cours à ${dateFin.toLocaleTimeString('fr-FR', {hour:'2-digit', minute:'2-digit'})}` });

            await interaction.editReply({ embeds: [embed] });

        } catch (e) { 
            console.error(e); 
            interaction.editReply("❌ Erreur lors de la récupération."); 
        }
    }

    if (commandName === 'agenda') {
        await interaction.deferReply({ ephemeral: true });
        const token = sessions.get(interaction.user.id);
        if (!token) return interaction.editReply("❌ Connecte-toi.");

        const generateAgenda = async (offset: number) => {
            const today = new Date();
            const start = new Date(today); start.setDate(start.getDate() - start.getDay() + 1 + (offset * 7)); start.setHours(0,0,0,0);
            const end = new Date(start); end.setDate(end.getDate() + 6); end.setHours(23,59,59);

            try {
                const cours = await TimetableService.getTimetable(token, start, end);
                cours.sort((a:any, b:any) => a.start_date - b.start_date);
                const embed = new EmbedBuilder().setTitle(`📅 Semaine du ${start.toLocaleDateString('fr-FR')}`).setColor(0x2B2D31);

                if (!cours.length) embed.setDescription("🏖️ **Aucun cours**.");
                else {
                    const days: any = {};
                    cours.forEach((c:any) => {
                        const d = new Date(c.start_date).toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long' });
                        const dc = d.charAt(0).toUpperCase() + d.slice(1);
                        if(!days[dc]) days[dc] = []; days[dc].push(c);
                    });
                    for(const [day, list] of Object.entries(days)) {
                        let txt = "";
                        const l = list as any[];
                        for(let k=0; k<l.length; k++){
                            const c = l[k];
                            let eStr = new Date(c.end_date).toLocaleTimeString('fr-FR',{hour:'2-digit',minute:'2-digit'});
                            while(k+1 < l.length && l[k+1].name === c.name && l[k+1].type === c.type) { eStr = new Date(l[k+1].end_date).toLocaleTimeString('fr-FR',{hour:'2-digit',minute:'2-digit'}); k++; }
                            const salle = c.rooms?.[0]?.name || 'Non défini';
                            const icon = (salle.toLowerCase().includes('distanciel')||salle.toLowerCase().includes('teams')) ? '🏠' : '🏫';
                            txt += `\`${new Date(c.start_date).toLocaleTimeString('fr-FR',{hour:'2-digit',minute:'2-digit'})} - ${eStr}\` ${icon} **${c.name.replace(/^T\d+\s-\s/i, '')}**\n╰ 📍 *${salle}*\n\n`;
                        }
                        embed.addFields({ name: `📆 ${day}`, value: txt });
                    }
                }
                return embed;
            } catch (e) { return new EmbedBuilder().setTitle("Erreur").setDescription("Erreur agenda."); }
        };

        let off = 0;
        const getBtns = (o:number) => new ActionRowBuilder<ButtonBuilder>().addComponents(new ButtonBuilder().setCustomId('prev').setLabel('⬅️').setStyle(ButtonStyle.Primary), new ButtonBuilder().setCustomId('today').setLabel('Aujourd\'hui').setStyle(ButtonStyle.Secondary).setDisabled(o===0), new ButtonBuilder().setCustomId('next').setLabel('➡️').setStyle(ButtonStyle.Primary));
        const msg = await interaction.editReply({ embeds: [await generateAgenda(off)], components: [getBtns(off)] });
        const col = msg.createMessageComponentCollector({ componentType: ComponentType.Button, time: 60000 });
        col.on('collect', async i => {
            if(i.user.id !== interaction.user.id) return i.reply({content:'Non.', ephemeral:true});
            await i.deferUpdate();
            if(i.customId==='prev') off--; else if(i.customId==='next') off++; else off=0;
            await interaction.editReply({ embeds: [await generateAgenda(off)], components: [getBtns(off)] });
        });
    }

    if (commandName === 'notes') {
        await interaction.deferReply({ ephemeral: true });
        const token = sessions.get(interaction.user.id);
        if (!token) return interaction.editReply("❌ Connecte-toi.");
        try {
            const grades = await ProfileService.getGrades(token, CURRENT_YEAR);
            if (!grades.length) return interaction.editReply("Aucune note.");
            const sems = [...new Set(grades.map((g:any) => g.trimester_name))];
            const row = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(new StringSelectMenuBuilder().setCustomId('sem').setPlaceholder('Semestre...').addOptions(sems.map((s:any)=>({label:s||'Autre',value:s||'Autre',emoji:'🎓'}))));

            const resp = await interaction.editReply({ content: "Choisis :", components: [row] });
            const col = resp.createMessageComponentCollector({ componentType: ComponentType.StringSelect, time: 60000 });
            col.on('collect', async i => {
                if(i.user.id !== interaction.user.id) return;
                await i.deferUpdate();
                const sel = grades.filter((g:any) => g.trimester_name === i.values[0]);
                const embed = new EmbedBuilder().setTitle(`🎓 Bulletin - ${i.values[0]}`).setColor(0x5865F2);
                sel.forEach((g:any) => {
                    const avg = g.average ? `**${g.average}/20**` : "En cours";
                    const prof = g.teacher_last_name || "Inconnu";
                    const abs = g.absences > 0 ? `🚫 ${g.absences} abs.` : `✅ 0`;
                    embed.addFields({ name: `📘 ${(g.course||'Inconnu').replace(/^T\d+\s-\s/i, '')}`, value: `> 📊 Moyenne : ${avg}\n> 📝 CC : ${g.ccaverage??"-"} | 🎓 Exam : ${g.exam??"-"}\n> 👨‍🏫 ${prof} • ${abs}`, inline: false });
                });
                await interaction.editReply({ content: null, embeds: [embed], components: [row] });
            });
        } catch(e) { console.error(e); }
    }

    if (commandName === 'absences') {
        await interaction.deferReply({ ephemeral: true });
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
        await interaction.deferReply({ ephemeral: true });
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
        await interaction.deferReply({ ephemeral: true });
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

    if (commandName === 'profs') {
        await interaction.deferReply({ ephemeral: true });
        const token = sessions.get(interaction.user.id);
        if (!token) return interaction.editReply("❌ Connecte-toi.");

        try {
            const teachers: any = await SchoolService.getTeachers(token, CURRENT_YEAR);
            
            if (!teachers || teachers.length === 0) return interaction.editReply("Aucun professeur trouvé.");

            const embed = new EmbedBuilder().setTitle("👨‍🏫 Mes Professeurs").setColor(0xF1C40F); // Jaune

            // On regroupe par matière si possible, sinon liste simple
            let desc = "";
            teachers.forEach((t: any) => {
                const nom = `${t.firstname} ${t.lastname}`.trim();
                const email = t.email ? `📧 ${t.email}` : "";
                desc += `**${nom}**\n${email}\n\n`;
            });

            // Si c'est trop long pour une description, on coupe
            if (desc.length > 4000) desc = desc.substring(0, 4000) + "...";
            embed.setDescription(desc);

            await interaction.editReply({ embeds: [embed] });
        } catch (e) { console.error(e); interaction.editReply("❌ Erreur profs."); }
    }
});

client.login(process.env.DISCORD_TOKEN);