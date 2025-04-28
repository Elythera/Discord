require('dotenv').config();
const express = require('express');
const { Client, GatewayIntentBits, Collection, EmbedBuilder, Partials, REST, Routes, ActivityType } = require('discord.js');
const sqlite3 = require('sqlite3').verbose();
const app = express();
const host = process.env.HOST;
const port = process.env.PORT;

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildVoiceStates
    ],
    partials: [Partials.Message, Partials.Channel, Partials.Reaction, Partials.User]
});

const db = new sqlite3.Database('elythera.db');

const LEVEL_UP_XP = 100;
const XP_PER_MINUTE = 2;
const LEVEL_UP_CHANNEL_ID = process.env.LEVEL_UP_CHANNEL_ID;
const GUILD_ID = process.env.GUILD_ID;
const ADMIN_ROLES = process.env.ADMIN_ROLES ? process.env.ADMIN_ROLES.split(',') : [];
const ADMIN_USERS = process.env.ADMIN_USERS ? process.env.ADMIN_USERS.split(',') : [];

if (!GUILD_ID) {
    console.error('GUILD_ID is not defined in the environment variables.');
    process.exit(1);
}

db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS users (
        guild_id TEXT,
        user_id TEXT,
        xp INTEGER,
        level INTEGER,
        saison INTEGER,
        PRIMARY KEY (guild_id, user_id, saison)
    )`);
    db.run(`CREATE TABLE IF NOT EXISTS user_archive (
        guild_id TEXT,
        user_id TEXT,
        xp INTEGER,
        level INTEGER,
        saison INTEGER,
        PRIMARY KEY (guild_id, user_id, saison)
    )`);
    db.run(`CREATE TABLE IF NOT EXISTS voice_activity (
        user_id TEXT,
        guild_id TEXT,
        joined_at INTEGER,
        PRIMARY KEY (user_id, guild_id)
    )`);
});

client.commands = new Collection();

client.commands.set('level', {
    data: {
        name: 'level',
        description: 'Voir votre niveau ou celui d\'un autre membre',
        options: [
            {
                name: 'membre',
                type: 6,
                description: 'Le membre dont vous voulez voir le niveau',
                required: false,
            },
        ],
    },
    async execute(interaction) {
        const userId = interaction.options.getUser('membre')?.id || interaction.user.id;
        const guildId = interaction.guildId;

        const user = await getUser(guildId, userId);
        if (!user) {
            return interaction.reply({ content: 'Cet utilisateur n\'a pas encore de niveau.', ephemeral: true });
        }

        const xpToNextLevel = LEVEL_UP_XP - user.xp;
        const progressBar = createProgressBar(user.xp, LEVEL_UP_XP);

        const embed = new EmbedBuilder()
            .setTitle(`Niveau de ${interaction.options.getUser('membre')?.username || interaction.user.username}`)
            .setDescription(`**Niveau:** ${user.level}\n**XP:** ${user.xp}/${LEVEL_UP_XP}\n**Progression:** ${progressBar}`)
            .setThumbnail(interaction.options.getUser('membre')?.displayAvatarURL() || interaction.user.displayAvatarURL())
            .setColor(user.level >= 100 ? '#CD7F32' : '#0099ff');

        return interaction.reply({ embeds: [embed], ephemeral: true });
    },
});

client.commands.set('leaderboard', {
    data: {
        name: 'leaderboard',
        description: 'Afficher le classement des niveaux',
    },
    async execute(interaction) {
        const guildId = interaction.guildId;
        const userId = interaction.user.id;
        const leaderboard = await getLeaderboard(guildId);
        const userRank = leaderboard.findIndex(user => user.user_id === userId) + 1;

        const embed = new EmbedBuilder()
            .setTitle('Classement des Niveaux')
            .setDescription(await formatLeaderboard(interaction, leaderboard))
            .setFooter({ text: `Vous êtes classé #${userRank}` })
            .setColor('#FFD700');

        return interaction.reply({ embeds: [embed] });
    },
});

client.commands.set('setlevel', {
    data: {
        name: 'setlevel',
        description: 'Définir le niveau d\'un utilisateur (Admin seulement)',
        options: [
            {
                name: 'membre',
                type: 6,
                description: 'Le membre dont vous voulez définir le niveau',
                required: true,
            },
            {
                name: 'niveau',
                type: 4,
                description: 'Le niveau à définir',
                required: true,
            },
        ],
    },
    async execute(interaction) {
        if (!isAdmin(interaction.member)) {
            return interaction.reply({ content: 'Vous n\'avez pas la permission d\'utiliser cette commande.', ephemeral: true });
        }

        const userId = interaction.options.getUser('membre').id;
        const guildId = interaction.guildId;
        const level = interaction.options.getInteger('niveau');
        const currentSeason = await getCurrentSeason(guildId);

        await updateUserLevel(guildId, userId, level, currentSeason);
        return interaction.reply({ content: `Le niveau de <@${userId}> a été défini à ${level}.`, ephemeral: true });
    },
});

client.commands.set('setxp', {
    data: {
        name: 'setxp',
        description: 'Définir l\'XP d\'un utilisateur (Admin seulement)',
        options: [
            {
                name: 'membre',
                type: 6,
                description: 'Le membre dont vous voulez définir l\'XP',
                required: true,
            },
            {
                name: 'xp',
                type: 4,
                description: 'L\'XP à définir',
                required: true,
            },
        ],
    },
    async execute(interaction) {
        if (!isAdmin(interaction.member)) {
            return interaction.reply({ content: 'Vous n\'avez pas la permission d\'utiliser cette commande.', ephemeral: true });
        }

        const userId = interaction.options.getUser('membre').id;
        const guildId = interaction.guildId;
        const xp = interaction.options.getInteger('xp');
        const currentSeason = await getCurrentSeason(guildId);

        if (xp < 0 || xp > 99) {
            return interaction.reply({ content: 'L\'XP doit être comprise entre 0 et 99.', ephemeral: true });
        }

        const user = await getUser(guildId, userId);
        const level = Math.floor(xp / LEVEL_UP_XP);

        await updateUser(guildId, userId, xp, level, currentSeason);
        return interaction.reply({ content: `L'XP de <@${userId}> a été définie à ${xp}.`, ephemeral: true });
    },
});

client.commands.set('newseason', {
    data: {
        name: 'newseason',
        description: 'Commencer une nouvelle saison (Admin seulement)',
    },
    async execute(interaction) {
        if (!isAdmin(interaction.member)) {
            return interaction.reply({ content: 'Vous n\'avez pas la permission d\'utiliser cette commande.', ephemeral: true });
        }

        const guildId = interaction.guildId;
        await startNewSeason(guildId);
        return interaction.reply({ content: 'Nouvelle saison commencée!', ephemeral: true });
    },
});

client.once('ready', async () => {
    console.log(`Logged in as ${client.user.tag}!`);
    setInterval(updateVoiceXp, 60000);

    client.user.setActivity('https://elythera.com/', { type: ActivityType.Watching });

    const commands = client.commands.map(cmd => cmd.data);
    const rest = new REST({ version: '9' }).setToken(process.env.BOT_TOKEN);

    try {
        await rest.put(Routes.applicationGuildCommands(client.user.id, GUILD_ID), { body: commands });
        console.log('Commands registered successfully.');
    } catch (error) {
        console.error('Error registering commands:', error);
    }

    app.get('/status', (req, res) => {
        res.json({
            status: 'ok',
            message: 'Le bot est en ligne.'
        });
    });

    app.listen(port, () => {
        console.log(`Serveur de statut en cours d'exécution sur http://${host}:${port}/status`);
    });
});

client.on('interactionCreate', async interaction => {
    if (!interaction.isCommand()) return;

    const command = client.commands.get(interaction.commandName);
    if (!command) return;

    try {
        await command.execute(interaction);
    } catch (error) {
        console.error(error);
        await interaction.reply({ content: 'Il y a eu une erreur lors de l\'exécution de cette commande!', ephemeral: true });
    }
});

client.on('messageCreate', async message => {
    if (message.author.bot) return;

    const userId = message.author.id;
    const guildId = message.guildId;
    const currentSeason = await getCurrentSeason(guildId);

    let user = await getUser(guildId, userId);
    if (!user) {
        user = { xp: 0, level: 0, saison: currentSeason };
        await insertUser(guildId, userId, user.xp, user.level, user.saison);
    }

    user.xp += Math.floor(Math.random() * 10) + 1;

    if (user.xp >= LEVEL_UP_XP) {
        user.level += 1;
        user.xp -= LEVEL_UP_XP;
        await updateUser(guildId, userId, user.xp, user.level, user.saison);
        sendLevelUpMessage(message.guild, message.author, user.level);
    } else {
        await updateUser(guildId, userId, user.xp, user.level, user.saison);
    }
});

client.on('voiceStateUpdate', (oldState, newState) => {
    const userId = newState.member.user.id;
    const guildId = newState.guild.id;

    if (oldState.channelId === null && newState.channelId !== null) {
        db.run('INSERT OR REPLACE INTO voice_activity (user_id, guild_id, joined_at) VALUES (?, ?, ?)', [userId, guildId, Date.now()]);
    } else if (newState.channelId === null) {
        db.run('DELETE FROM voice_activity WHERE user_id = ? AND guild_id = ?', [userId, guildId]);
    }
});

function updateVoiceXp() {
    db.all('SELECT * FROM voice_activity', async (err, rows) => {
        if (err) {
            console.error(err);
            return;
        }

        for (const row of rows) {
            const timeInVoice = Date.now() - row.joined_at;
            const minutesInVoice = Math.floor(timeInVoice / 60000);
            const xpGained = minutesInVoice * XP_PER_MINUTE;
            const currentSeason = await getCurrentSeason(row.guild_id);

            let user = await getUser(row.guild_id, row.user_id);
            if (!user) {
                user = { xp: 0, level: 0, saison: currentSeason };
                await insertUser(row.guild_id, row.user_id, user.xp, user.level, user.saison);
            }

            user.xp += xpGained;

            if (user.xp >= LEVEL_UP_XP) {
                user.level += 1;
                user.xp -= LEVEL_UP_XP;
                await updateUser(row.guild_id, row.user_id, user.xp, user.level, user.saison);
                const guild = client.guilds.cache.get(row.guild_id);
                sendLevelUpMessage(guild, guild.members.cache.get(row.user_id), user.level);
            } else {
                await updateUser(row.guild_id, row.user_id, user.xp, user.level, user.saison);
            }

            db.run('UPDATE voice_activity SET joined_at = ? WHERE user_id = ? AND guild_id = ?', [Date.now(), row.user_id, row.guild_id]);
        }
    });
}

async function getUser(guildId, userId) {
    return new Promise((resolve, reject) => {
        db.get('SELECT * FROM users WHERE guild_id = ? AND user_id = ? AND saison = (SELECT MAX(saison) FROM users WHERE guild_id = ?)', [guildId, userId, guildId], (err, row) => {
            if (err) {
                return reject(err);
            }
            resolve(row);
        });
    });
}

async function getLeaderboard(guildId) {
    return new Promise((resolve, reject) => {
        db.all('SELECT user_id, level, xp FROM users WHERE guild_id = ? AND saison = (SELECT MAX(saison) FROM users) ORDER BY level DESC, xp DESC LIMIT 10', [guildId], (err, rows) => {
            if (err) {
                return reject(err);
            }
            resolve(rows);
        });
    });
}

async function updateUser(guildId, userId, xp, level, saison) {
    return new Promise((resolve, reject) => {
        db.run('INSERT OR REPLACE INTO users (guild_id, user_id, xp, level, saison) VALUES (?, ?, ?, ?, ?)', [guildId, userId, xp, level, saison], function (err) {
            if (err) {
                return reject(err);
            }
            resolve();
        });
    });
}

async function insertUser(guildId, userId, xp, level, saison) {
    return new Promise((resolve, reject) => {
        db.run('INSERT INTO users (guild_id, user_id, xp, level, saison) VALUES (?, ?, ?, ?, ?)', [guildId, userId, xp, level, saison], function (err) {
            if (err) {
                return reject(err);
            }
            resolve();
        });
    });
}

async function updateUserLevel(guildId, userId, level, saison) {
    const user = await getUser(guildId, userId);
    if (user) {
        return updateUser(guildId, userId, user.xp, level, saison);
    } else {
        return insertUser(guildId, userId, 0, level, saison);
    }
}

async function sendLevelUpMessage(guild, member, level) {
    const channel = guild.channels.cache.get(LEVEL_UP_CHANNEL_ID);
    if (channel) {
        channel.send(`${member} est passé au niveau ${level}! Félicitations !`);
    }
}

async function startNewSeason(guildId) {
    const currentSeason = await getCurrentSeason(guildId);
    const nextSeason = currentSeason + 1;

    await archiveUserData(guildId, currentSeason);

    db.run('UPDATE users SET xp = 0, level = 0, saison = ? WHERE guild_id = ?', [nextSeason, guildId]);
}

async function getCurrentSeason(guildId) {
    return new Promise((resolve, reject) => {
        db.get('SELECT MAX(saison) AS currentSeason FROM users WHERE guild_id = ?', [guildId], (err, row) => {
            if (err) {
                return reject(err);
            }
            resolve(row.currentSeason || 1);
        });
    });
}

async function archiveUserData(guildId, saison) {
    return new Promise((resolve, reject) => {
        db.run('INSERT INTO user_archive (guild_id, user_id, xp, level, saison) SELECT guild_id, user_id, xp, level, ? FROM users WHERE guild_id = ?', [saison, guildId], function (err) {
            if (err) {
                return reject(err);
            }
            resolve();
        });
    });
}

async function formatLeaderboard(interaction, leaderboard) {
    const promises = leaderboard.map(async (user, index) => {
        let member = client.users.cache.get(user.user_id);
        if (!member) {
            try {
                member = await interaction.client.users.fetch(user.user_id);
            } catch (error) {
                return `**${index + 1}.** Utilisateur inconnu`;
            }
        }
        if (index === 0) {
            return `🥇 **${member.username}**: Niveau ${user.level} (XP: ${user.xp})`;
        } else if (index === 1) {
            return `🥈 **${member.username}**: Niveau ${user.level} (XP: ${user.xp})`;
        } else if (index === 2) {
            return `🥉 **${member.username}**: Niveau ${user.level} (XP: ${user.xp})`;
        } else {
            return `**${index + 1}.** **${member.username}**: Niveau ${user.level} (XP: ${user.xp})`;
        }
    });

    return Promise.all(promises).then(results => results.join('\n'));
}

function createProgressBar(currentXp, maxXp) {
    const progress = Math.min(Math.max(currentXp / maxXp, 0), 1);
    const barLength = 20;
    const filledLength = Math.round(barLength * progress);
    const emptyLength = barLength - filledLength;

    const filledBar = '█'.repeat(filledLength);
    const emptyBar = '░'.repeat(emptyLength);

    return `[${filledBar}${emptyBar}]`;
}

function isAdmin(member) {
    return ADMIN_ROLES.some(roleId => member.roles.cache.has(roleId)) || ADMIN_USERS.includes(member.id);
}

client.login(process.env.BOT_TOKEN);