/**
 * spawnTicketCommand.js
 * Système de ticket d'admission "Spawn Joueur"
 * - Panneau publié dans le salon d'arrivée
 * - Formulaire modal (âge, plateforme, gamertag, source)
 * - Ticket privé spawn-joueur-username
 * - Checklist staff (voc, enregistrement, mot de passe envoyé)
 * - Envoi du mot de passe in-game en MP
 * - Finalisation : rôle + message bienvenue + log
 */

const {
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  ChannelType,
  PermissionFlagsBits,
} = require('discord.js');

const path = require('path');
const fs   = require('fs');
const { getSettings } = require('./settingsManager');

// ── Stockage en mémoire ───────────────────────────────────────────────────────
const activeSpawnTickets = new Map(); // ticketId → data

function genId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

// ── Accès aux paramètres spawn ────────────────────────────────────────────────
function getSpawnSettings() {
  return getSettings().spawnTicket || {};
}

// ── Icône de plateforme ───────────────────────────────────────────────────────
function platformEmoji(p) {
  const low = (p || '').toLowerCase();
  if (low.includes('play') || low.includes('psn') || low.includes('ps')) return '🎮';
  if (low.includes('pc') || low.includes('steam')) return '🖥️';
  if (low.includes('xbox')) return '🎮';
  return '🕹️';
}

// ── Embed infos joueur ────────────────────────────────────────────────────────
function buildInfoEmbed(data) {
  return new EmbedBuilder()
    .setColor(0x5865f2)
    .setTitle(`🐣 Nouvelle admission — ${data.username}`)
    .addFields(
      { name: '👤 Joueur', value: `<@${data.userId}>`, inline: true },
      { name: '🎂 Âge', value: data.age, inline: true },
      { name: `${platformEmoji(data.platform)} Plateforme`, value: data.platform, inline: true },
      { name: '🎮 Gamertag / ID', value: `\`${data.gamertag}\``, inline: false },
      ...(data.source ? [{ name: '🔍 Découverte', value: data.source, inline: false }] : []),
    )
    .setTimestamp()
    .setFooter({ text: `Ticket ID : ${data.ticketId}` });
}

// ── Embed checklist ───────────────────────────────────────────────────────────
function buildChecklistEmbed(data) {
  const { voc, enreg, password } = data.checks;
  const icon = (v) => v ? '✅' : '⏳';
  const all3 = voc && enreg && password;

  return new EmbedBuilder()
    .setColor(all3 ? 0x2ecc71 : 0xe67e22)
    .setTitle('📋 Checklist d\'admission')
    .setDescription(
      `${icon(voc)} **Vocal fait**\n` +
      `${icon(enreg)} **Enregistrement**\n` +
      `${icon(password)} **Mot de passe envoyé**`
    )
    .setFooter({
      text: all3
        ? '✅ Toutes les étapes complètes — tu peux finaliser !'
        : 'Coche les étapes au fur et à mesure.',
    });
}

// ── Boutons checklist + actions ───────────────────────────────────────────────
function buildChecklistComponents(data) {
  const { voc, enreg, password } = data.checks;
  const id = data.ticketId;
  const all3 = voc && enreg && password;

  const row1 = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`spwn_check::${id}::voc`)
      .setLabel(voc ? '✅ Vocal fait' : '⏳ Vocal fait')
      .setStyle(voc ? ButtonStyle.Success : ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(`spwn_check::${id}::enreg`)
      .setLabel(enreg ? '✅ Enregistrement' : '⏳ Enregistrement')
      .setStyle(enreg ? ButtonStyle.Success : ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(`spwn_check::${id}::password`)
      .setLabel(password ? '✅ Mot de passe envoyé' : '⏳ Mot de passe envoyé')
      .setStyle(password ? ButtonStyle.Success : ButtonStyle.Secondary),
  );

  const row2 = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`spwn_password::${id}`)
      .setLabel('🔑 Envoyer le mot de passe')
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId(`spwn_unlock::${id}`)
      .setLabel('🔓 Débloquer les salons')
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(`spwn_finalize::${id}`)
      .setLabel('🎉 Finaliser l\'admission')
      .setStyle(ButtonStyle.Success)
      .setDisabled(!all3),
  );

  return [row1, row2];
}

// ── Panneau d'admission ───────────────────────────────────────────────────────
async function publishSpawnPanel(interaction) {
  const embed = new EmbedBuilder()
    .setColor(0x5865f2)
    .setTitle('🐣 Spawn Joueur — Admission')
    .setDescription(
      '**Bienvenue sur Arki\' Family !** 🌿\n\n' +
      'Pour débuter ton aventure sur notre serveur ARK, clique sur le bouton ci-dessous.\n' +
      'Un membre du staff te prendra en charge dans un ticket privé.\n\n' +
      '> 🎙️ Un **vocal obligatoire** est requis pour accéder au serveur\n' +
      '> 📋 Tour rapide des règles du serveur\n' +
      '> 🔑 Obtention du mot de passe in-game\n' +
      '> 🎒 Récupération de ton kit de départ\n' +
      '> 🔓 Ouverture des salons discord'
    )
    .setFooter({ text: 'Clique sur le bouton pour commencer 👇' });

  const btn = new ButtonBuilder()
    .setCustomId('spwn_open')
    .setLabel('🐣 Commencer l\'admission')
    .setStyle(ButtonStyle.Primary);

  await interaction.channel.send({
    embeds: [embed],
    components: [new ActionRowBuilder().addComponents(btn)],
  });
  return interaction.reply({ content: '✅ Panneau d\'admission Spawn Joueur publié !', ephemeral: true });
}

// ── Ouvrir le modal ───────────────────────────────────────────────────────────
async function handleOpenSpawn(interaction) {
  const modal = new ModalBuilder()
    .setCustomId('spwn_modal')
    .setTitle('🐣 Admission Spawn Joueur');

  modal.addComponents(
    new ActionRowBuilder().addComponents(
      new TextInputBuilder()
        .setCustomId('spwn_age')
        .setLabel('Ton âge')
        .setStyle(TextInputStyle.Short)
        .setPlaceholder('Ex : 18')
        .setRequired(true)
        .setMaxLength(3),
    ),
    new ActionRowBuilder().addComponents(
      new TextInputBuilder()
        .setCustomId('spwn_platform')
        .setLabel('Ta plateforme de jeu')
        .setStyle(TextInputStyle.Short)
        .setPlaceholder('PlayStation / PC / Xbox')
        .setRequired(true)
        .setMaxLength(20),
    ),
    new ActionRowBuilder().addComponents(
      new TextInputBuilder()
        .setCustomId('spwn_gamertag')
        .setLabel('Ton Gamertag / PSN / Steam ID')
        .setStyle(TextInputStyle.Short)
        .setPlaceholder('Ex : ArkiPlayer42')
        .setRequired(true)
        .setMaxLength(64),
    ),
    new ActionRowBuilder().addComponents(
      new TextInputBuilder()
        .setCustomId('spwn_source')
        .setLabel('Comment tu nous as trouvé ?')
        .setStyle(TextInputStyle.Short)
        .setPlaceholder('Ex : Discord, un ami, réseaux sociaux…')
        .setRequired(false)
        .setMaxLength(100),
    ),
  );

  await interaction.showModal(modal);
}

// ── Traitement modal → création du ticket ─────────────────────────────────────
async function handleModalSubmit(interaction) {
  await interaction.deferReply({ ephemeral: true });

  const settings = getSpawnSettings();
  const age      = interaction.fields.getTextInputValue('spwn_age').trim();
  const platform = interaction.fields.getTextInputValue('spwn_platform').trim();
  const gamertag = interaction.fields.getTextInputValue('spwn_gamertag').trim();
  const source   = interaction.fields.getTextInputValue('spwn_source').trim();
  const guild    = interaction.guild;

  const discordUsername = interaction.user.username;
  const displayName = interaction.member?.nickname
    || interaction.user.globalName
    || interaction.member?.displayName
    || discordUsername;

  const safeName = discordUsername
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 20) || 'joueur';

  const channelName = `spawn-joueur-${safeName}`;
  const ticketId = genId();

  // Permissions
  const permOverwrites = [
    { id: guild.id, deny: [PermissionFlagsBits.ViewChannel] },
    {
      id: interaction.user.id,
      allow: [
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.ReadMessageHistory,
        PermissionFlagsBits.AttachFiles,
      ],
    },
  ];

  for (const roleId of (settings.adminRoleIds || [])) {
    permOverwrites.push({
      id: roleId,
      allow: [
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.ReadMessageHistory,
        PermissionFlagsBits.ManageMessages,
      ],
    });
  }

  // Créer le salon
  let ticketChannel;
  try {
    ticketChannel = await guild.channels.create({
      name: channelName,
      type: ChannelType.GuildText,
      parent: settings.ticketCategoryId || null,
      permissionOverwrites: permOverwrites,
      reason: `Admission spawn de ${discordUsername}`,
    });
  } catch (err) {
    console.error('[SpawnTicket] Erreur création salon:', err);
    return interaction.editReply({
      content: `❌ Impossible de créer le ticket : ${err.message}\n\nVérifie la catégorie configurée dans le dashboard (Tickets → Spawn Joueur).`,
    });
  }

  const data = {
    ticketId,
    channelId: ticketChannel.id,
    userId: interaction.user.id,
    username: displayName,
    discordUsername,
    age,
    platform,
    gamertag,
    source: source || null,
    checks: { voc: false, enreg: false, password: false },
    status: 'open',
    createdAt: Date.now(),
    checklistMessageId: null,
  };
  activeSpawnTickets.set(ticketId, data);

  // Message de bienvenue joueur + note italique bienveillante
  await ticketChannel.send({
    content:
      `👋 Bienvenue <@${interaction.user.id}> ! Un membre du staff va te prendre en charge rapidement. 🌿\n` +
      `-# *Un petit bonjour ou quelques mots dans le ticket, c'est toujours bien plus agréable qu'un ticket silencieux — l'équipe sera ravie de te lire !* 😊`,
    embeds: [buildInfoEmbed(data)],
  });

  // Message automatique configurable (texte + image) — publié avant la checklist
  const autoText = (settings.autoMessageText || '').trim();
  const autoImg  = (settings.autoMessageImageUrl || '').trim();
  if (autoText || autoImg) {
    const autoEmbed = new EmbedBuilder().setColor(0x5865f2);
    if (autoText) autoEmbed.setDescription(autoText);

    const msgPayload = { embeds: [autoEmbed] };

    if (autoImg) {
      // Si c'est un chemin local /uploads/..., on attache le fichier directement
      if (autoImg.startsWith('/uploads/')) {
        const filePath = path.join(__dirname, 'web', 'public', autoImg);
        if (fs.existsSync(filePath)) {
          const { AttachmentBuilder } = require('discord.js');
          const fileName = path.basename(filePath);
          const attachment = new AttachmentBuilder(filePath, { name: fileName });
          autoEmbed.setImage(`attachment://${fileName}`);
          msgPayload.files = [attachment];
        }
      } else {
        // URL externe
        autoEmbed.setImage(autoImg);
      }
    }

    await ticketChannel.send(msgPayload).catch((e) => {
      console.error('[SpawnTicket] Erreur auto-message:', e.message);
    });
  }

  // Checklist staff — tout en bas pour un accès facile
  const checklistMsg = await ticketChannel.send({
    embeds: [buildChecklistEmbed(data)],
    components: buildChecklistComponents(data),
  });
  data.checklistMessageId = checklistMsg.id;

  // Notification admin (canal dédié) — avec lien direct du ticket
  if (settings.notifChannelId) {
    const notifCh = guild.channels.cache.get(settings.notifChannelId);
    if (notifCh) {
      const notifText = (settings.notifText || '🐣 Un nouveau joueur vient d\'ouvrir un ticket de spawn !').trim();
      notifCh.send({
        content: `${notifText}\n> 📬 **Ticket :** <#${ticketChannel.id}>`,
      }).catch((e) => {
        console.error('[SpawnTicket] Erreur notification admin:', e.message);
      });
    } else {
      console.warn('[SpawnTicket] Salon de notification introuvable (ID:', settings.notifChannelId, ')');
    }
  }

  // Log d'arrivée (salon log détaillé)
  if (settings.logChannelId) {
    const logCh = guild.channels.cache.get(settings.logChannelId);
    if (logCh) {
      logCh.send({
        embeds: [new EmbedBuilder()
          .setColor(0x5865f2)
          .setDescription(`🐣 Nouveau spawn : <@${interaction.user.id}> (${platform}) → <#${ticketChannel.id}>`)
          .setTimestamp()
        ],
      }).catch(() => {});
    }
  }

  await interaction.editReply({
    content: `✅ Ton ticket d'admission a été créé : <#${ticketChannel.id}>\nUn membre du staff arrive très vite !`,
  });
}

// ── Toggle case checklist ─────────────────────────────────────────────────────
async function handleCheck(interaction, ticketId, step) {
  const data = activeSpawnTickets.get(ticketId);
  if (!data) return interaction.reply({ content: '❌ Ticket introuvable.', ephemeral: true });

  data.checks[step] = !data.checks[step];

  try {
    const msg = await interaction.channel.messages.fetch(data.checklistMessageId);
    await msg.edit({
      embeds: [buildChecklistEmbed(data)],
      components: buildChecklistComponents(data),
    });
  } catch (err) {
    console.error('[SpawnTicket] Erreur MAJ checklist:', err);
  }

  await interaction.deferUpdate();
}

// ── Envoyer le mot de passe in-game en MP ────────────────────────────────────
async function handleSendPassword(interaction, ticketId) {
  const data = activeSpawnTickets.get(ticketId);
  if (!data) return interaction.reply({ content: '❌ Ticket introuvable.', ephemeral: true });

  const settings = getSpawnSettings();
  const password = settings.mapPassword || '';

  if (!password) {
    return interaction.reply({
      content: '⚠️ Aucun mot de passe configuré. Va dans le Dashboard → Tickets → Spawn Joueur pour l\'ajouter.',
      ephemeral: true,
    });
  }

  try {
    const member = await interaction.guild.members.fetch(data.userId);
    await member.send({
      embeds: [new EmbedBuilder()
        .setColor(0x2ecc71)
        .setTitle('🔑 Mot de passe in-game — Arki\' Family')
        .setDescription(
          `Voici le mot de passe pour accéder aux maps :\n\n` +
          `## \`${password}\`\n` +
          `-# *Tout en MAJUSCULE, sauf le « i » en minuscule*\n\n` +
          `*Ne partage ce mot de passe avec personne.*`
        )
        .setFooter({ text: 'Arki\' Family' })
      ],
    });

    await interaction.channel.send({
      embeds: [new EmbedBuilder()
        .setColor(0x2ecc71)
        .setDescription(`🔑 Le mot de passe in-game a été envoyé en message privé à <@${data.userId}>.`)
      ],
    });

    await interaction.reply({ content: '✅ Mot de passe envoyé en MP.', ephemeral: true });
  } catch (err) {
    await interaction.reply({
      content: `❌ Impossible d'envoyer le MP — le joueur a peut-être désactivé ses MPs.\n\`${err.message}\``,
      ephemeral: true,
    });
  }
}

// ── Débloquer les salons Discord ─────────────────────────────────────────────
async function handleUnlock(interaction, ticketId) {
  const data = activeSpawnTickets.get(ticketId);
  if (!data) return interaction.reply({ content: '❌ Ticket introuvable.', ephemeral: true });

  const settings = getSpawnSettings();
  if (!settings.memberRoleId) {
    return interaction.reply({
      content: '⚠️ Aucun rôle configuré. Va dans le Dashboard → Tickets → Spawn Joueur → "Rôle à retirer pour débloquer les salons".',
      ephemeral: true,
    });
  }

  try {
    const member = await interaction.guild.members.fetch(data.userId);
    await member.roles.remove(settings.memberRoleId);

    await interaction.channel.send({
      embeds: [new EmbedBuilder()
        .setColor(0x2ecc71)
        .setDescription(`🔓 Les salons Discord ont été débloqués pour <@${data.userId}> !`)
      ],
    });

    await interaction.reply({ content: '✅ Rôle retiré — salons débloqués.', ephemeral: true });
  } catch (err) {
    await interaction.reply({
      content: `❌ Impossible de retirer le rôle : \`${err.message}\``,
      ephemeral: true,
    });
  }
}

// ── Finaliser l'admission ─────────────────────────────────────────────────────
async function handleFinalize(interaction, ticketId) {
  const data = activeSpawnTickets.get(ticketId);
  if (!data) return interaction.reply({ content: '❌ Ticket introuvable.', ephemeral: true });

  const { voc, enreg, password } = data.checks;
  if (!voc || !enreg || !password) {
    return interaction.reply({
      content: '⚠️ Toutes les étapes de la checklist doivent être cochées avant de finaliser.',
      ephemeral: true,
    });
  }

  if (data.status === 'finalized') {
    return interaction.reply({ content: '⚠️ Cette admission a déjà été finalisée.', ephemeral: true });
  }

  await interaction.deferReply({ ephemeral: true });

  const settings = getSpawnSettings();
  const guild    = interaction.guild;
  const staffName = interaction.member?.displayName || interaction.user.username;

  // Retirer le rôle bloquant si configuré (double sécurité avec le bouton dédié)
  if (settings.memberRoleId) {
    try {
      const member = await guild.members.fetch(data.userId);
      await member.roles.remove(settings.memberRoleId);
    } catch (err) {
      console.error('[SpawnTicket] Erreur retrait rôle bloquant:', err);
    }
  }

  // Message dans le salon bienvenue
  if (settings.welcomeChannelId) {
    const welcomeCh = guild.channels.cache.get(settings.welcomeChannelId);
    if (welcomeCh) {
      await welcomeCh.send({
        content: `<@${data.userId}>`,
        embeds: [new EmbedBuilder()
          .setColor(0x2ecc71)
          .setTitle('🎉 Bienvenue dans la famille !')
          .setDescription(
            `**${data.username}** vient de rejoindre l'aventure sur **Arki' Family** !\n\n` +
            `${platformEmoji(data.platform)} Plateforme : **${data.platform}**\n` +
            `🎮 Gamertag : **${data.gamertag}**\n\n` +
            `Souhaite-lui la bienvenue ! 🥳`
          )
          .setTimestamp()
        ],
      }).catch(() => {});
    }
  }

  // Log d'admission complète
  if (settings.logChannelId) {
    const logCh = guild.channels.cache.get(settings.logChannelId);
    if (logCh) {
      const dur = `${Math.floor((Date.now() - data.createdAt) / 60000)} min`;
      logCh.send({
        embeds: [new EmbedBuilder()
          .setColor(0x2ecc71)
          .setTitle('✅ Admission complète')
          .addFields(
            { name: 'Joueur', value: `<@${data.userId}>`, inline: true },
            { name: 'Staff', value: staffName, inline: true },
            { name: 'Durée', value: dur, inline: true },
            { name: 'Plateforme', value: data.platform, inline: true },
            { name: 'Gamertag', value: data.gamertag, inline: true },
          )
          .setTimestamp()
        ],
      }).catch(() => {});
    }
  }

  data.status = 'finalized';

  // Message final dans le ticket — bouton fermeture (pas suppression directe)
  await interaction.channel.send({
    embeds: [new EmbedBuilder()
      .setColor(0x2ecc71)
      .setTitle('✅ Admission finalisée !')
      .setDescription(
        `Félicitations <@${data.userId}> ! Tu fais maintenant partie d'**Arki' Family** 🎉\n\n` +
        `Le ticket peut maintenant être fermé. Il restera visible par le staff jusqu'à sa suppression.`
      )
    ],
    components: [new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`spwn_close::${ticketId}`)
        .setLabel('🔒 Fermer le ticket')
        .setStyle(ButtonStyle.Secondary),
    )],
  });

  await interaction.editReply({ content: '✅ Admission finalisée avec succès !' });
}

// ── Demander confirmation de fermeture ────────────────────────────────────────
async function handleClose(interaction, ticketId) {
  await interaction.reply({
    embeds: [new EmbedBuilder()
      .setColor(0xe67e22)
      .setTitle('⚠️ Fermer ce ticket ?')
      .setDescription(
        'Le joueur n\'aura plus accès à ce salon.\n' +
        'Le staff pourra encore le consulter et le supprimer quand il le souhaite.'
      )
    ],
    components: [new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`spwn_close_confirm::${ticketId}`)
        .setLabel('✅ Oui, fermer le ticket')
        .setStyle(ButtonStyle.Danger),
      new ButtonBuilder()
        .setCustomId(`spwn_close_cancel::${ticketId}`)
        .setLabel('❌ Annuler')
        .setStyle(ButtonStyle.Secondary),
    )],
    ephemeral: true,
  });
}

// ── Confirmer la fermeture ────────────────────────────────────────────────────
async function handleCloseConfirm(interaction, ticketId) {
  const data = activeSpawnTickets.get(ticketId);
  const adminName = interaction.member?.displayName || interaction.user.username;
  const userId = data?.userId;

  // Retirer l'accès visuel du joueur
  if (userId) {
    try {
      await interaction.channel.permissionOverwrites.edit(userId, {
        ViewChannel: false,
        SendMessages: false,
      });
    } catch (e) {
      console.error('[SpawnTicket] Impossible de modifier les permissions du joueur:', e.message);
    }
  }

  // Renommer le salon avec le préfixe ferme-
  try {
    const currentName = interaction.channel.name;
    const newName = `ferme-${currentName}`.slice(0, 100);
    await interaction.channel.edit({ name: newName, reason: `Ticket fermé par ${adminName}` });
  } catch (e) {
    console.error('[SpawnTicket] Impossible de renommer le salon ticket:', e.message);
  }

  // Mettre à jour le message éphémère de confirmation
  try {
    await interaction.update({
      embeds: [new EmbedBuilder()
        .setColor(0x95a5a6)
        .setTitle('🔒 Ticket fermé')
        .setDescription(`Fermé par **${adminName}**.\nLe joueur ne voit plus ce salon.`)
      ],
      components: [],
    });
  } catch (e) {}

  // Message public dans le salon avec bouton de suppression
  try {
    await interaction.channel.send({
      embeds: [new EmbedBuilder()
        .setColor(0x95a5a6)
        .setTitle('🔒 Ticket fermé')
        .setDescription(
          `Ce ticket a été fermé par **${adminName}**.\n` +
          `Le joueur n'a plus accès à ce salon.\n\n` +
          `Le staff peut continuer à écrire ici. Supprime le ticket quand tu es prêt(e).`
        )
        .setTimestamp()
      ],
      components: [new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(`spwn_delete::${ticketId}`)
          .setLabel('🗑️ Supprimer le ticket')
          .setStyle(ButtonStyle.Danger),
      )],
    });
  } catch (e) {
    console.error('[SpawnTicket] Impossible d\'envoyer le message de fermeture:', e.message);
  }
}

// ── Annuler la fermeture ──────────────────────────────────────────────────────
async function handleCloseCancel(interaction) {
  await interaction.update({
    embeds: [new EmbedBuilder()
      .setColor(0x2ecc71)
      .setDescription('✅ Fermeture annulée.')
    ],
    components: [],
  });
}

// ── Supprimer le ticket (définitif) ──────────────────────────────────────────
async function handleDeleteTicket(interaction, ticketId) {
  const adminName = interaction.member?.displayName || interaction.user.username;

  try {
    await interaction.update({
      embeds: [new EmbedBuilder()
        .setColor(0xe74c3c)
        .setTitle('🗑️ Suppression en cours…')
        .setDescription('Ce salon sera supprimé dans 3 secondes.')
      ],
      components: [],
    });
  } catch (e) {}

  setTimeout(async () => {
    try {
      await interaction.channel.delete(`Ticket supprimé par ${adminName}`);
      activeSpawnTickets.delete(ticketId);
    } catch (err) {
      console.error('[SpawnTicket] Erreur suppression salon:', err);
    }
  }, 3000);
}

// ── Commande slash ────────────────────────────────────────────────────────────
async function handleSpawnTicketCommand(interaction) {
  if (interaction.commandName !== 'spawn-panel') return;
  return publishSpawnPanel(interaction);
}

// ── Dispatcher interactions ───────────────────────────────────────────────────
async function handleSpawnTicketInteraction(interaction) {
  if (interaction.isModalSubmit() && interaction.customId === 'spwn_modal') {
    return handleModalSubmit(interaction);
  }

  if (!interaction.isButton()) return;
  const id = interaction.customId;

  if (id === 'spwn_open') return handleOpenSpawn(interaction);

  if (id.startsWith('spwn_check::')) {
    const parts = id.split('::');
    return handleCheck(interaction, parts[1], parts[2]);
  }

  if (id.startsWith('spwn_password::')) {
    return handleSendPassword(interaction, id.split('::')[1]);
  }

  if (id.startsWith('spwn_finalize::')) {
    return handleFinalize(interaction, id.split('::')[1]);
  }

  if (id.startsWith('spwn_unlock::')) {
    return handleUnlock(interaction, id.split('::')[1]);
  }

  if (id.startsWith('spwn_close::')) {
    return handleClose(interaction, id.split('::')[1]);
  }

  if (id.startsWith('spwn_close_confirm::')) {
    return handleCloseConfirm(interaction, id.split('::')[1]);
  }

  if (id.startsWith('spwn_close_cancel::')) {
    return handleCloseCancel(interaction);
  }

  if (id.startsWith('spwn_delete::')) {
    return handleDeleteTicket(interaction, id.split('::')[1]);
  }
}

module.exports = {
  handleSpawnTicketCommand,
  handleSpawnTicketInteraction,
  publishSpawnPanel,
};
