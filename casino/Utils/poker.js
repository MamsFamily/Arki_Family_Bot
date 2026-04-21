const {
    EmbedBuilder,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    ChannelType,
    AttachmentBuilder
} = require('discord.js');
const path = require('path');
const fs = require('fs').promises;
const inventaire = require('../config/inventaire.json');
const { generateTableImage } = require('./canvasTable');
const { deal } = require('./deck');
const {
    initGame,
    dealCards,
    startBettingRound
} = require('./pokerLogic');
const { chargerInventaire, sauvegarderInventaire, getBalance, setBalance } = require('./inventaire');
const tablesFile = path.join(__dirname, '..', 'data', 'tables.json');
const config = require("../config");
const POKER_LOGO_PATH = path.join(__dirname, '..', '..', 'assets', 'img', 'poker_logo.png');


async function executerPoker(interaction) {
    // 1) Charger les tables depuis data/tables.json
    const filePath = path.join(__dirname, '..', 'data', 'tables.json');
    let tables = [];
    try {
        const raw = await fs.readFile(filePath, 'utf8');
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) tables = parsed;
    } catch (err) {
        if (err.code !== 'ENOENT') {
            console.error('Erreur lecture tables.json :', err);
        }
        // ENOENT ou parse fail → tables reste []
    }

    // 2) Construire l’embed
    const imagePoker = new AttachmentBuilder(POKER_LOGO_PATH);
    const embed = new EmbedBuilder().setTitle('Poker').setThumbnail('attachment://poker_logo.png').setColor(config.color);
    const row = new ActionRowBuilder();

    if (tables.length === 0) {
        embed.setDescription('Prêt à jouer ? Clique sur "Créer une table" pour démarrer.');
        row.addComponents(
            new ButtonBuilder()
                .setCustomId('poker_creer_table')
                .setLabel('Créer une table')
                .setStyle(ButtonStyle.Primary)
        );
    } else {
        embed.setDescription('Tables existantes : rejoins-en une ou crée la tienne.');
        // 3) Un bouton par table
        tables.forEach(table => {
            row.addComponents(
                new ButtonBuilder()
                    .setCustomId(`poker_rejoindre_${table.threadId}`)
                    .setLabel(table.name)
                    .setStyle(ButtonStyle.Secondary)
            );
        });
        // 4) Bouton “Créer une table” en dernier
        row.addComponents(
            new ButtonBuilder()
                .setCustomId('poker_creer_table')
                .setLabel('Créer une table')
                .setStyle(ButtonStyle.Primary)
        );
    }

    // 5) Envoyer la réponse éphémère
    await interaction.reply({
        embeds: [embed],
        components: [row],
        ephemeral: true,
        files: [imagePoker]
    });
}
async function executerCreerTable(interaction) {
    await interaction.deferReply({ ephemeral: true });
    const userId = interaction.user.id;
    const displayName = interaction.member.displayName;
    const filePath = path.join(__dirname, '..', 'data', 'tables.json');

    // 1) Charger les tables existantes
    let tables = [];
    try {
        const raw = await fs.readFile(filePath, 'utf8');
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) tables = parsed;
    } catch (err) {
        if (err.code !== 'ENOENT') console.error('Lecture tables.json :', err);
    }

    // 2) Sécurité : l'utilisateur ne doit pas déjà avoir une table
    if (tables.some(t => t.participants.includes(userId))) {
        return interaction.followUp({
            content:
                '❌ Tu as déjà une table en cours. Quitte ta table actuelle avant d’en créer une nouvelle.',
            ephemeral: true
        });
    }

    // 3) Création du thread poker privé
    const thread = await interaction.channel.threads.create({
        name: `♠️poker-${displayName}`,
        autoArchiveDuration: 60,
        type: ChannelType.PrivateThread,
        reason: 'Nouvelle table poker'
    });
    await thread.members.add(userId);

    // 4) Enregistrer la nouvelle table (le créateur n'est pas en attente)
    const nouvelleTable = {
        threadId: thread.id,
        name: thread.name,
        category: 'en attente',
        participants: [userId],
        enAttenteDeLaProchainePartie: [],   // vide au départ
        dansLaPartie: []
    };
    tables.push(nouvelleTable);
    try {
        await fs.writeFile(filePath, JSON.stringify(tables, null, 2), 'utf8');
    } catch (err) {
        console.error('Écriture tables.json :', err);
    }

    // 5) Construire l'embed avec règles et file d’attente vide
    const waitingIds = nouvelleTable.enAttenteDeLaProchainePartie;
    const waitingValue =
        waitingIds.length > 0
            ? waitingIds.map((id, i) => `**${i + 1}.** <@${id}>`).join('\n')
            : 'Aucun joueur';

    const rulesEmbed = new EmbedBuilder()
        .setTitle("Règles du Texas Hold'em")
        .setColor(config.color)
        .setDescription(
            [
                "**1. Distribution :** Chaque joueur reçoit 2 cartes face cachée.",
                "**2. Flop :** 3 cartes communes sont révélées.",
                "**3. Turn :** 1 carte commune supplémentaire.",
                "**4. River :** Dernière carte commune.",
                "**5. Tours d’enchères :** Avant le Flop, après le Flop, Turn et River.",
                "**6. Objectif :** Former la meilleure main de 5 cartes.",
                "",
                "**Classement des mains** (du plus fort au plus faible) :",
                "• Quinte flush royale",
                "• Quinte flush",
                "• Carré",
                "• Full",
                "• Couleur",
                "• Quinte",
                "• Brelan",
                "• Double paire",
                "• Paire",
                "• Carte haute"
            ].join("\n")
        )
        .setThumbnail('attachment://poker_logo.png')
        .addFields({
            name: `⏱️ En attente de joueurs (${waitingIds.length}/10)`,
            value: waitingValue
        });

    // 6) Préparer les boutons
    const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId("poker_rejoindreListeAttente")
            .setLabel("Rejoindre la partie")
            .setStyle(ButtonStyle.Primary),
        new ButtonBuilder()
            .setCustomId("poker_quitter_table")
            .setLabel("Quitter la table")
            .setStyle(ButtonStyle.Danger)
    );

    // 7) Envoyer l’embed + image + boutons dans le thread
    await thread.send({
        embeds: [rulesEmbed],
        components: [row],
        files: [{ attachment: POKER_LOGO_PATH, name: 'poker_logo.png' }]
    });

    // 8) Confirmer à l’utilisateur
    await interaction.followUp({
        content: `✅ Ta table a été créée : ${thread}`,
        ephemeral: true
    });
}
async function executerRejoindreTable(interaction) {
    await interaction.deferReply({ ephemeral: true });
    const userId = interaction.user.id;
    const filePath = path.join(__dirname, '..', 'data', 'tables.json');

    // Charger toutes les tables
    let tables = [];
    try {
        const raw = await fs.readFile(filePath, 'utf8');
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) tables = parsed;
    } catch (err) {
        if (err.code !== 'ENOENT') console.error('Lecture tables.json :', err);
    }

    // Sécurité : un joueur ne peut être que dans une seule table
    if (tables.some(t => t.participants.includes(userId))) {
        return interaction.followUp({
            content: '❌ Tu es déjà dans une table. Quitte ta table actuelle avant d’en rejoindre une autre.',
            ephemeral: true
        });
    }

    // Extraire le threadId depuis le customId
    const threadId = interaction.customId.replace('poker_rejoindre_', '');
    const table = tables.find(t => t.threadId === threadId);
    if (!table) {
        return interaction.followUp({
            content: '❌ Table introuvable ou fermée.',
            ephemeral: true
        });
    }

    // Ajouter l’utilisateur aux participants
    table.participants.push(userId);
    try {
        await fs.writeFile(filePath, JSON.stringify(tables, null, 2), 'utf8');
    } catch (err) {
        console.error('Écriture tables.json :', err);
        return interaction.followUp({
            content: '❌ Impossible de rejoindre la table (erreur interne).',
            ephemeral: true
        });
    }

    // Ajouter le membre au thread Discord
    try {
        const thread = await interaction.client.channels.fetch(threadId);
        await thread.members.add(userId);
    } catch (err) {
        console.error('Ajout au thread :', err);
    }

    // Confirmer l’ajout
    await interaction.followUp({
        content: `✅ Tu as rejoint la table **${table.name}** !`,
        ephemeral: true
    });
}
async function executerQuitterTable(interaction) {
    // 1) Ack le clic
    await interaction.deferReply({ ephemeral: true })

    const userId = interaction.user.id
    const thread = interaction.channel // ThreadChannel

    // 2) Retirer le membre du thread
    try {
        await thread.members.remove(userId)
    } catch (err) {
        console.error('Erreur retrait membre du thread:', err)
    }

    // 3) Charger et retrouver la table
    let tables = []
    try {
        const raw = await fs.readFile(tablesFile, 'utf8')
        tables = JSON.parse(raw) || []
    } catch (err) {
        if (err.code !== 'ENOENT') console.error(err)
    }

    const idx = tables.findIndex(t => t.threadId === thread.id)
    if (idx === -1) {
        return interaction.followUp({
            content: '❌ Cette table n’existe pas.',
            ephemeral: true
        })
    }

    const table = tables[idx]

    // 4) Si le joueur était en plein jeu → fin de partie
    if (table.dansLaPartie.includes(userId) && table.phase != null) {
        await winPartie(thread, table, userId)
        return
    }

    // 5) Sinon : on retire le joueur de participants, enAttente, dansLaPartie
    let tableToDelete = false

    const participants = table.participants.filter(id => id !== userId)
    const enAttente = (table.enAttenteDeLaProchainePartie || [])
        .filter(id => id !== userId)
    const dansLaPartie = (table.dansLaPartie || []).filter(id => id !== userId)

    if (participants.length === 0) {
        tableToDelete = true
        tables.splice(idx, 1)
    } else {
        tables[idx] = {
            ...table,
            participants,
            enAttenteDeLaProchainePartie: enAttente,
            dansLaPartie
        }
    }

    // 6) Sauvegarder tables.json
    try {
        await fs.writeFile(tablesFile, JSON.stringify(tables, null, 2), 'utf8')
    } catch (err) {
        console.error('Erreur écriture tables.json:', err)
        return interaction.followUp({
            content: '❌ Impossible de mettre à jour la table.',
            ephemeral: true
        })
    }

    // 7) Mettre à jour l’embed “Règles…” si la table subsiste
    if (!tableToDelete) {
        try {
            const fetched = await thread.messages.fetch({ limit: 50 })
            const rulesMsg = fetched.find(
                m => m.embeds.length
                    && m.embeds[0].title === "Règles du Texas Hold'em"
            )

            if (rulesMsg) {
                const oldEmbed = rulesMsg.embeds[0]
                const waiting = tables[idx].enAttenteDeLaProchainePartie || []

                const waitingValue = waiting.length
                    ? await Promise.all(
                        waiting.map(async (id, i) => {
                            const m = await interaction.guild.members.fetch(id).catch(() => null)
                            return `**${i + 1}.** ${m?.displayName || `<@${id}>`}`
                        })
                    ).then(arr => arr.join('\n'))
                    : 'Aucun joueur'

                const baseFields = (oldEmbed.fields || []).filter(
                    f => !f.name.startsWith('⏱️ En attente de joueurs')
                )

                const newEmbed = new EmbedBuilder()
                    .setTitle(oldEmbed.title)
                    .setDescription(oldEmbed.description)
                    .setColor(config.color)
                    .setThumbnail('attachment://poker_logo.png')
                    .addFields([
                        ...baseFields,
                        {
                            name: `⏱️ En attente de joueurs (${waiting.length}/10)`,
                            value: waitingValue
                        }
                    ])

                await rulesMsg.edit({
                    embeds: [newEmbed],
                    components: rulesMsg.components,
                    files: [{ attachment: POKER_LOGO_PATH, name: 'poker_logo.png' }]
                })
            }
        } catch (err) {
            console.error('Erreur mise à jour embed file d’attente :', err)
        }
    }

    // 8) Confirmation éphémère
    await interaction.followUp({
        content: '✅ Tu as quitté la table.',
        ephemeral: true
    })

    // 9) Si plus aucun participant, suppression du thread
    if (tableToDelete) {
        try {
            await thread.send('🗑️ Suppression de la table dans 3 secondes…')
            setTimeout(() => thread.delete('Plus aucun participant'), 3000)
        } catch (err) {
            console.error('Erreur suppression du thread :', err)
        }
    }
}
async function executerRejoindreListeAttente(interaction) {
    await interaction.deferUpdate();

    const userId = interaction.user.id;
    const thread = interaction.channel;
    const filePath = path.join(__dirname, '..', 'data', 'tables.json');

    // Charger et modifier la file d’attente
    let tables = [];
    try {
        const raw = await fs.readFile(filePath, 'utf8');
        tables = JSON.parse(raw) || [];
    } catch (err) {
        if (err.code !== 'ENOENT') console.error(err);
    }
    const table = tables.find(t => t.threadId === thread.id);
    if (!table) return;

    table.enAttenteDeLaProchainePartie ||= [];
    const wasInQueue = table.enAttenteDeLaProchainePartie.includes(userId);
    if (wasInQueue) {
        table.enAttenteDeLaProchainePartie =
            table.enAttenteDeLaProchainePartie.filter(id => id !== userId);
    } else {
        if (table.enAttenteDeLaProchainePartie.length >= 10) {
            return interaction.followUp({
                content: '❌ File pleine (10/10).',
                ephemeral: true
            });
        }
        table.enAttenteDeLaProchainePartie.push(userId);
        table.participants ||= [];
        if (!table.participants.includes(userId)) table.participants.push(userId);
    }
    await fs.writeFile(filePath, JSON.stringify(tables, null, 2), 'utf8');

    // Recréation de l’embed
    const rulesMsg = interaction.message;
    const oldEmbed = rulesMsg.embeds[0];
    const waiting = table.enAttenteDeLaProchainePartie;
    const names = waiting.length
        ? await Promise.all(
            waiting.map(async (id, i) => {
                const member = await interaction.guild.members.fetch(id).catch(() => null);
                return `**${i + 1}.** ${member?.displayName || `<@${id}>`}`;
            })
        ).then(arr => arr.join('\n'))
        : 'Aucun joueur';

    const baseFields = (oldEmbed.fields || []).filter(
        f => !f.name.startsWith('⏱️ En attente de joueurs')
    );
    const newEmbed = new EmbedBuilder()
        .setTitle(oldEmbed.title)
        .setDescription(oldEmbed.description)
        .setColor(config.color)
        .setThumbnail('attachment://poker_logo.png')
        .addFields([
            ...baseFields,
            {
                name: `⏱️ En attente de joueurs (${waiting.length}/10)`,
                value: names
            }
        ]);

    // Reconstruction des boutons en masquant "Démarrer la partie"
    const inGame = Array.isArray(table.dansLaPartie) && table.dansLaPartie.length > 0;
    const buttons = [
        new ButtonBuilder()
            .setCustomId('poker_rejoindreListeAttente')
            .setLabel('Rejoindre la file')
            .setStyle(ButtonStyle.Primary),

        !inGame && new ButtonBuilder()
            .setCustomId('poker_start_partie')
            .setLabel('Démarrer la partie')
            .setStyle(ButtonStyle.Success)
            .setDisabled(waiting.length < 2),

        new ButtonBuilder()
            .setCustomId('poker_quitter_table')
            .setLabel('Quitter la table')
            .setStyle(ButtonStyle.Danger)
    ].filter(Boolean);

    const row = new ActionRowBuilder().addComponents(...buttons);

    await rulesMsg.edit({
        embeds: [newEmbed],
        components: [row],
        files: [{ attachment: POKER_LOGO_PATH, name: 'poker_logo.png' }]
    });

    return interaction.followUp({
        content: wasInQueue
            ? '❌ Tu as quitté la file d’attente.'
            : '✅ Tu as rejoint la file d’attente !',
        ephemeral: true
    });
}
async function executerStartPartie(interaction) {
    // 1) Ack le clic pour éviter “Unknown interaction”
    await interaction.deferUpdate();

    const thread = interaction.channel; // ThreadChannel
    const filePath = path.join(__dirname, '..', 'data', 'tables.json');

    // 2) Charger tables.json et retrouver la table
    let tables = [];
    try {
        const raw = await fs.readFile(filePath, 'utf8');
        tables = JSON.parse(raw) || [];
    } catch (err) {
        if (err.code !== 'ENOENT') console.error(err);
    }
    const table = tables.find(t => t.threadId === thread.id);
    if (!table) return;

    const waiting = table.enAttenteDeLaProchainePartie || [];
    if (waiting.length < 2) {
        return interaction.followUp({
            content: '❌ Il faut au moins 2 joueurs pour démarrer la partie.',
            ephemeral: true
        });
    }

    // 3) Initialisation du jeu : blinds, statuts, bets, phase, deck...
    table.dansLaPartie = [...waiting];

    // Choix des montants de blind si pas déjà définis
    const sbAmount = table.smallBlindAmount ?? 10;
    const bbAmount = table.bigBlindAmount ?? 20;
    const { initGame, dealCards, startBettingRound } = require('./pokerLogic');
    initGame(table, sbAmount, bbAmount);
    dealCards(table);
    startBettingRound(table);

    // 4) Sauvegarder l’état initialisé
    await fs.writeFile(filePath, JSON.stringify(tables, null, 2), 'utf8');

    // 5) Générer l’image du tableau
    //    On affiche pour l’instant toutes les cartes face cachée
    const players = await Promise.all(
        table.dansLaPartie.map(async (id) => {
            const member = await interaction.guild.members.fetch(id).catch(() => null);
            const name = member?.displayName || `<@${id}>`;
            const inv = inventaire[id] || [];
            const money = inv.reduce((sum, item) => sum + (item.quantite || 0), 0);

            // holeCards stockées dans table.holeCards mais on affiche back/back
            return {
                name,
                money,
                holeCards: ['back', 'back']
            };
        })
    );

    // communityCards initialement vides → on les dessine face cachée
    const communityBacks = table.communityCards.map(() => 'back');
    const buffer = await generateTableImage(players, table.pot, communityBacks);

    // 6) Envoyer l’image + bouton “Voir mes cartes”
    const viewBtn = new ButtonBuilder()
        .setCustomId('poker_voir_cartes')
        .setLabel('Voir mes cartes')
        .setStyle(ButtonStyle.Secondary);

    const rowView = new ActionRowBuilder().addComponents(viewBtn);

    await thread.send({
        files: [{ attachment: buffer, name: 'table.png' }],
        components: [rowView]
    });

    const activeIds = table.dansLaPartie.filter(
        id => table.statuses[id] === 'active'
    );
    const maxBet = Math.max(...activeIds.map(id => table.bets[id]));

    // 2) Identifier le joueur qui va parler
    const curIdx = table.currentPlayerIndex;
    const playerId = table.dansLaPartie[curIdx];

    // 3) Calculer combien il doit suivre
    const toCall = Math.max(0, maxBet - table.bets[playerId]);
    const currentId = table.dansLaPartie[table.currentPlayerIndex];
    const actionButtons = [
        new ButtonBuilder()
            .setCustomId('poker_check')
            .setLabel('Check')
            .setStyle(ButtonStyle.Secondary),

        new ButtonBuilder()
            .setCustomId('poker_call')
            .setLabel(`Suivre (${toCall})`)
            .setStyle(ButtonStyle.Primary),

        new ButtonBuilder()
            .setCustomId('poker_raise')
            .setLabel('Miser')
            .setStyle(ButtonStyle.Success),

        new ButtonBuilder()
            .setCustomId('poker_fold')
            .setLabel('Se coucher')
            .setStyle(ButtonStyle.Danger),

        // new ButtonBuilder()
        //     .setCustomId('poker_allin')
        //     .setLabel('Tapis')
        //     .setStyle(ButtonStyle.Danger)
    ];

    const rowActions = new ActionRowBuilder().addComponents(...actionButtons);

    await thread.send({
        content: `<@${currentId}> c'est à toi de jouer`,
        components: [rowActions]
    });

    // 7) Masquer le bouton “Démarrer la partie” dans l’embed des règles
    const fetched = await thread.messages.fetch({ limit: 50 });
    const rulesMsg = fetched.find(
        m => m.embeds.length && m.embeds[0].title === "Règles du Texas Hold'em"
    );
    if (rulesMsg) {
        const inGame = Array.isArray(table.dansLaPartie) && table.dansLaPartie.length > 0;
        const waitingCount = table.enAttenteDeLaProchainePartie.length;

        const buttons = [
            new ButtonBuilder()
                .setCustomId('poker_rejoindreListeAttente')
                .setLabel('Rejoindre la file')
                .setStyle(ButtonStyle.Primary),

            !inGame && new ButtonBuilder()
                .setCustomId('poker_start_partie')
                .setLabel('Démarrer la partie')
                .setStyle(ButtonStyle.Success)
                .setDisabled(waitingCount < 2),

            new ButtonBuilder()
                .setCustomId('poker_quitter_table')
                .setLabel('Quitter la table')
                .setStyle(ButtonStyle.Danger)
        ].filter(Boolean);

        const row = new ActionRowBuilder().addComponents(...buttons);
        await rulesMsg.edit({ components: [row] });
    }
}
async function executerVoirMesCartes(interaction) {
    await interaction.deferReply({ ephemeral: true });

    const userId = interaction.user.id;
    const threadId = interaction.channel.id;
    const filePath = path.join(__dirname, '..', 'data', 'tables.json');

    // 1) lire tables.json
    let tables = [];
    try {
        const raw = await fs.readFile(filePath, 'utf8');
        tables = JSON.parse(raw) || [];
    } catch (err) {
        if (err.code !== 'ENOENT') console.error(err);
    }

    // 2) retrouver la table courante
    const table = tables.find(t => t.threadId === threadId);
    if (!table || !table.dansLaPartie.includes(userId)) {
        return interaction.followUp({
            content: '❌ Tu n’es pas dans cette partie.',
            ephemeral: true
        });
    }

    // 3) récupérer les codes de cartes du joueur
    const cards = table.holeCards?.[userId] || ['back', 'back'];
    const files = cards.map(code => ({
        attachment: path.join(__dirname, '..', 'assets', 'poker', 'cards', `${code}.png`),
        name: `${code}.png`
    }));

    return interaction.followUp({
        content: '🂠 Tes cartes :',
        files,
        ephemeral: true
    });
}
async function winPartie(thread, table, quitterId = null) {
    // 1) Déterminer le vainqueur et le pot
    const winnerId = table.dansLaPartie.find(id => table.statuses[id] !== 'folded')
    const pot = table.pot

    // 2) Créditer le vainqueur
    const inv = await chargerInventaire()
    const oldBal = getBalance(inv, winnerId)
    setBalance(inv, winnerId, oldBal + pot)
    await sauvegarderInventaire(inv)

    // 3) Construire l'embed de résultat avec toutes les mains
    //    On affiche la main du gagnant en premier
    const fields = await Promise.all(
        table.dansLaPartie.map(async id => {
            const member = await thread.guild.members.fetch(id).catch(() => null)
            const name = member?.displayName || `<@${id}>`
            const isWinner = id === winnerId
            const rawCards = table.holeCards[id] || []
            // Affiche chaque carte sous forme de code, ex. "Ah", "Kd"
            const cardsDisplay = rawCards.length
                ? rawCards.join(' ')
                : '–'
            return {
                name: `${isWinner ? '🏆 ' : ''}${name}`,
                value: cardsDisplay,
                inline: true
            }
        })
    )

    const resultEmbed = new EmbedBuilder()
        .setTitle('🏆 Partie Terminée !').setThumbnail('attachment://poker_logo.png')
        .setDescription(
            `Bravo <@${winnerId}> qui remporte **${pot} ${config.iconMonnaie}** !`
        )
        .setColor(config.color)
        .addFields(fields)

    // 4) Préparer les deux boutons : quitter ou relancer
    // const quitterBtn = new ButtonBuilder()
    //     .setCustomId('poker_quitter_table')
    //     .setLabel('Quitter la table')
    //     .setStyle(ButtonStyle.Danger)

    const relaunchBtn = new ButtonBuilder()
        .setCustomId('poker_relaunch')
        .setLabel('Relancer la partie')
        .setStyle(ButtonStyle.Success)

    const row = new ActionRowBuilder().addComponents( relaunchBtn)

    // 5) Envoyer l'embed et les boutons
    await thread.send({
        embeds: [resultEmbed],
        components: [row],
        files: [new AttachmentBuilder(POKER_LOGO_PATH)]
    })
}
async function executerRelaunch(interaction) {
  // 1) On garde le clic invisible
  await interaction.deferUpdate()

  // 2) Lire et parser tables.json
  let tables
  try {
    const raw = await fs.readFile(tablesFile, 'utf8')
    tables     = JSON.parse(raw)
  } catch (err) {
    console.error('Erreur lecture tables.json', err)
    return
  }

  // 3) Récupérer la table courante
  const thread = interaction.channel
  const table  = tables.find(t => t.threadId === thread.id)
  if (!table) return

  // 4) Nettoyer le fil
  const messages = await thread.messages.fetch({ limit: 100 })
  for (const msg of messages.values()) {
    await msg.delete().catch(() => {})
  }

  // 5) Réinitialiser l’objet table
  const waitingIds = table.enAttenteDeLaProchainePartie || []
  table.category                     = 'en attente'
  table.participants                 = [...waitingIds]
  table.enAttenteDeLaProchainePartie = [...waitingIds]
  table.dansLaPartie                 = []
  delete table.pot
  delete table.statuses
  delete table.bets
  delete table.phase
  delete table.firstToAct
  delete table.currentPlayerIndex

  // 6) Persister le nouvel état
  try {
    await fs.writeFile(tablesFile, JSON.stringify(tables, null, 2), 'utf8')
  } catch (err) {
    console.error('Erreur écriture tables.json après relaunch', err)
  }

  // 7) Embed des règles + boutons
  const rulesDescription = [
    "**1. Distribution :** Chaque joueur reçoit 2 cartes face cachée.",
    "**2. Flop :** 3 cartes communes sont révélées.",
    "**3. Turn :** 1 carte commune supplémentaire.",
    "**4. River :** Dernière carte commune.",
    "**5. Tours d’enchères :** Avant le Flop, après le Flop, Turn et River.",
    "**6. Objectif :** Former la meilleure main de 5 cartes.",
    "",
    "**Classement des mains** (du plus fort au plus faible) :",
    "• Quinte flush royale",
    "• Quinte flush",
    "• Carré",
    "• Full",
    "• Couleur",
    "• Quinte",
    "• Brelan",
    "• Double paire",
    "• Paire",
    "• Carte haute"
  ].join('\n')

  const rulesEmbed = new EmbedBuilder()
    .setTitle("Règles du Texas Hold'em")
    .setColor(config.color)
    .setDescription(rulesDescription)
    .setThumbnail('attachment://poker_logo.png')
    .addFields({
      name: `⏱️ En attente de joueurs (${waitingIds.length}/10)`,
      value: waitingIds.length
        ? waitingIds.map((id, i) => `**${i + 1}.** <@${id}>`).join('\n')
        : 'Aucun joueur'
    })

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId("poker_rejoindreListeAttente")
      .setLabel("Rejoindre la partie")
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId('poker_start_partie')
      .setLabel('Démarrer la partie')
      .setStyle(ButtonStyle.Success)
      .setDisabled(waitingIds.length < 2),
    new ButtonBuilder()
      .setCustomId("poker_quitter_table")
      .setLabel("Quitter la table")
      .setStyle(ButtonStyle.Danger)
  )

  await thread.send({
    embeds:     [rulesEmbed],
    components: [row],
    files:      [new AttachmentBuilder(POKER_LOGO_PATH)]
  })
}



module.exports = {

    executerPoker,
    executerCreerTable,
    executerRejoindreTable,
    executerQuitterTable,
    executerRejoindreListeAttente,
    executerStartPartie,
    executerVoirMesCartes,
    executerRelaunch


};