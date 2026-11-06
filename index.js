require('dotenv').config();

const {
  Client,
  GatewayIntentBits,
  Partials,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  SlashCommandBuilder,
  REST,
  Routes,
  PermissionsBitField,
  Events,
  AuditLogEvent
} = require('discord.js');

/*
================================================
CONFIG
================================================
*/

const CONFIG = {
  token: process.env.TOKEN?.trim(),
  protectedChannelId: process.env.PROTECTED_CHANNEL_ID?.trim(),
  logGuildId: process.env.LOG_GUILD_ID?.trim(),
  logChannelId: process.env.LOG_CHANNEL_ID?.trim(),
  securityRoleId: process.env.SECURITY_ROLE_ID?.trim(),
  adminLogUserId: process.env.ADMIN_LOG_USER_ID?.trim(),
  antiBotLogChannelId: process.env.ANTI_BOT_LOG_CHANNEL_ID?.trim(),
  autoRoleLogChannelId: process.env.AUTO_ROLE_LOG_CHANNEL_ID?.trim(),
  timeoutMinutes: Math.max(1, Number(process.env.TIMEOUT_MINUTES || 60)),
  reason: process.env.TIMEOUT_REASON || 'إرسال رسالة داخل روم الحماية',
  footerIcon: process.env.FOOTER_ICON_URL?.trim() || ''
};

if (
  !CONFIG.token ||
  !CONFIG.protectedChannelId ||
  !CONFIG.logGuildId ||
  !CONFIG.logChannelId ||
  !CONFIG.securityRoleId ||
  !CONFIG.adminLogUserId
) {
  console.error(
    '❌ تأكد من TOKEN و PROTECTED_CHANNEL_ID و LOG_GUILD_ID و LOG_CHANNEL_ID و SECURITY_ROLE_ID و ADMIN_LOG_USER_ID في .env'
  );

  process.exit(1);
}

/*
================================================
CLIENT
================================================
*/

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildModeration,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ],

  partials: [
    Partials.Channel,
    Partials.Message,
    Partials.GuildMember
  ]
});

/*
================================================
CONSTANTS
================================================
*/

const ORIGINAL_SECURITY_DESCRIPTION =
  'تم اكتشاف رسالة في روم الحماية واتخاذ إجراء تلقائي وتم حذف الرسالة المخالفة فقط.';

/*
================================================
BOT ACTION TRACKING
================================================
*/

const botActions = new Map();
const processedAntiRoleAuditEntries = new Set();

function markBotAction(type, userId) {
  const key = `${type}:${userId}`;

  botActions.set(key, Date.now());

  setTimeout(() => {
    botActions.delete(key);
  }, 30000);
}

function isBotAction(type, userId) {
  const key = `${type}:${userId}`;
  const timestamp = botActions.get(key);

  if (!timestamp) {
    return false;
  }

  if (Date.now() - timestamp > 30000) {
    botActions.delete(key);
    return false;
  }

  return true;
}

/*
================================================
UTILS
================================================
*/

const cut = (value, max = 1024) => {
  const text =
    String(value ?? '').trim() ||
    'بدون محتوى';

  return text.length > max
    ? `${text.slice(0, max - 3)}...`
    : text;
};

const durationText = minutes => {
  if (minutes < 60) {
    return `${minutes} دقيقة`;
  }

  if (minutes % 60 === 0) {
    return `${minutes / 60} ساعة`;
  }

  return `${Math.floor(minutes / 60)} ساعة و ${minutes % 60} دقيقة`;
};

function addFooter(embed) {
  const footer = {
    text: 'Elsisy Security System'
  };

  if (CONFIG.footerIcon) {
    footer.iconURL = CONFIG.footerIcon;
  }

  return embed.setFooter(footer);
}

function attachmentIsImage(a) {
  return (
    /^image\//i.test(a.contentType || '') ||
    /\.(png|jpe?g|gif|webp|avif)$/i.test(a.name || '')
  );
}

function attachmentIsVideo(a) {
  return (
    /^video\//i.test(a.contentType || '') ||
    /\.(mp4|webm|mov|mkv|avi|m4v)$/i.test(a.name || '')
  );
}

function attachmentList(message) {
  return [...message.attachments.values()].map(a => ({
    name: a.name || 'Attachment',
    url: a.url,
    contentType: a.contentType || ''
  }));
}

function formatMessageContent(content, attachments = []) {
  const text = String(content ?? '').trim();

  const images = attachments.filter(attachmentIsImage);
  const videos = attachments.filter(attachmentIsVideo);

  const other = attachments.filter(
    a =>
      !attachmentIsImage(a) &&
      !attachmentIsVideo(a)
  );

  const summary = [];

  if (images.length) {
    summary.push(`🖼️ ${images.length} صورة`);
  }

  if (videos.length) {
    summary.push(`🎥 ${videos.length} فيديو`);
  }

  if (other.length) {
    summary.push(`📎 ${other.length} ملف`);
  }

  if (text && summary.length) {
    return `${text}\n\n📦 المرفقات: ${summary.join(' • ')}`;
  }

  if (text) {
    return text;
  }

  if (summary.length) {
    return `📦 تم إرسال: ${summary.join(' • ')}\n\n🔗 الروابط موجودة في الأقسام بالأسفل.`;
  }

  return 'بدون محتوى';
}

/*
================================================
GUILD / CHANNEL
================================================
*/

async function getGuild(id) {
  return client.guilds.fetch(id).catch(() => null);
}

async function getLogChannel() {
  const guild = await getGuild(CONFIG.logGuildId);

  if (!guild) {
    return null;
  }

  return guild.channels
    .fetch(CONFIG.logChannelId)
    .catch(() => null);
}

async function getProtectedGuild() {
  const channel =
    await client.channels
      .fetch(CONFIG.protectedChannelId)
      .catch(() => null);

  return channel?.guild || null;
}

function canUseSecurityCommand(interaction) {
  return (
    interaction.inGuild() &&
    (
      interaction.member?.roles?.cache?.has(
        CONFIG.securityRoleId
      ) ||
      interaction.memberPermissions?.has(
        PermissionsBitField.Flags.Administrator
      )
    )
  );
}

/*
================================================
COMMAND REGISTER
================================================
*/

async function registerCommands() {
  const command =
    new SlashCommandBuilder()
      .setName('security')
      .setDescription(
        'إرسال رسالة تفعيل نظام الحماية في الروم المحدد'
      );

  const rest =
    new REST({
      version: '10'
    }).setToken(CONFIG.token);

  await rest.put(
    Routes.applicationCommands(client.user.id),
    {
      body: [command.toJSON()]
    }
  );

  console.log('✅ /security registered');
}

/*
================================================
SECURITY PANEL
================================================
*/

async function sendSecurityPanel(channel) {
  const embed =
    new EmbedBuilder()
      .setColor(0xE53935)
      .setTitle('🛡️ Elsisy Security System')

      .setDescription(
        '🚫 **يُمنع إرسال أي رسالة داخل هذه القناة.**\n\n' +

        'تم إنشاء هذه القناة كجزء من نظام الحماية التلقائي الخاص بسيرفر **Elsisy** لرصد الحسابات المخترقة أو المستخدمة في نشر الرسائل المزعجة.\n\n' +

        '**يُمنع إرسال:**\n' +
        '💬 رسالة نصية\n' +
        '😀 إيموجي أو ملصق\n' +
        '🖼️ صورة أو GIF\n' +
        '📎 ملف أو مرفق\n' +
        '🔗 رابط\n' +
        '🎤 رسالة صوتية\n' +
        '📢 منشن أو رد على رسالة\n\n' +

        '**عند إرسال أي رسالة سيتم تنفيذ الإجراءات التالية تلقائيًا:**\n\n' +

        '🔇 **تطبيق Timeout مؤقت على الحساب.**\n' +
        '🗑️ **حذف الرسالة المخالفة داخل روم الحماية فقط.**\n' +
        '🛡️ **إنشاء حالة أمنية تلقائية لمراجعتها بواسطة فريق الحماية.**\n\n' +

        '⚠️ **ملاحظة**\n\n' +

        'إذا تم تفعيل نظام الحماية على حسابك، فقد يشير ذلك إلى أن حسابك تعرض للاختراق أو تم استخدامه لإرسال رسائل غير مصرح بها.\n\n' +

        'في حال كنت تعتقد أن الإجراء تم بالخطأ، يرجى التواصل مع <@1229173247157997721> بعد تأمين حسابك.'
      )

      .setTimestamp();

  addFooter(embed);

  if (CONFIG.footerIcon) {
    embed.setThumbnail(CONFIG.footerIcon);
  }

  return channel.send({
    content: '@everyone',
    embeds: [embed],
    allowedMentions: {
      parse: ['everyone']
    }
  });
}

/*
================================================
TIMEOUT
================================================
*/

async function doTimeout(member) {
  if (!member?.moderatable) {
    return {
      ok: false,
      error:
        'اتم اكتشاف رساله داخل روم الحمايه لكني لا اقدر علي هذا الفحل.'
    };
  }

  try {
    await member.timeout(
      CONFIG.timeoutMinutes * 60000,
      CONFIG.reason
    );

    return {
      ok: true
    };

  } catch (error) {
    return {
      ok: false,
      error:
        error.message ||
        'فشل تنفيذ Timeout'
    };
  }
}

/*
================================================
BUTTONS
================================================
*/

function actionButtons(userId) {
  return new ActionRowBuilder()
    .addComponents(

      new ButtonBuilder()
        .setCustomId(`security:revoke:${userId}`)
        .setLabel('Revoke')
        .setEmoji('🔄')
        .setStyle(ButtonStyle.Success),

      new ButtonBuilder()
        .setCustomId(`security:kick:${userId}`)
        .setLabel('Kick')
        .setEmoji('🚫')
        .setStyle(ButtonStyle.Secondary),

      new ButtonBuilder()
        .setCustomId(`security:ban:${userId}`)
        .setLabel('BAN')
        .setEmoji('⛔')
        .setStyle(ButtonStyle.Danger),

      new ButtonBuilder()
        .setCustomId(`security:history:${userId}`)
        .setLabel('History')
        .setEmoji('🧾')
        .setStyle(ButtonStyle.Primary),

      new ButtonBuilder()
        .setCustomId(`security:userinfo:${userId}`)
        .setLabel('User Info')
        .setEmoji('🪪')
        .setStyle(ButtonStyle.Secondary)
    );
}

function timeoutRemovedButtons(userId) {
  return new ActionRowBuilder()
    .addComponents(

      new ButtonBuilder()
        .setCustomId(`security:kick:${userId}`)
        .setLabel('Kick')
        .setEmoji('🚫')
        .setStyle(ButtonStyle.Secondary),

      new ButtonBuilder()
        .setCustomId(`security:ban:${userId}`)
        .setLabel('BAN')
        .setEmoji('⛔')
        .setStyle(ButtonStyle.Danger),

      new ButtonBuilder()
        .setCustomId(`security:history:${userId}`)
        .setLabel('History')
        .setEmoji('🧾')
        .setStyle(ButtonStyle.Primary),

      new ButtonBuilder()
        .setCustomId(`security:userinfo:${userId}`)
        .setLabel('User Info')
        .setEmoji('🪪')
        .setStyle(ButtonStyle.Secondary)
    );
}

function afterKickButtons(userId) {
  return new ActionRowBuilder()
    .addComponents(

      new ButtonBuilder()
        .setCustomId(`security:ban:${userId}`)
        .setLabel('BAN')
        .setEmoji('⛔')
        .setStyle(ButtonStyle.Danger),

      new ButtonBuilder()
        .setCustomId(`security:history:${userId}`)
        .setLabel('History')
        .setEmoji('🧾')
        .setStyle(ButtonStyle.Primary),

      new ButtonBuilder()
        .setCustomId(`security:userinfo:${userId}`)
        .setLabel('User Info')
        .setEmoji('🪪')
        .setStyle(ButtonStyle.Secondary)
    );
}

function afterBanButtons(userId) {
  return new ActionRowBuilder()
    .addComponents(

      new ButtonBuilder()
        .setCustomId(`security:unban:${userId}`)
        .setLabel('Un Ban')
        .setEmoji('🔓')
        .setStyle(ButtonStyle.Success),

      new ButtonBuilder()
        .setCustomId(`security:history:${userId}`)
        .setLabel('History')
        .setEmoji('🧾')
        .setStyle(ButtonStyle.Primary),

      new ButtonBuilder()
        .setCustomId(`security:userinfo:${userId}`)
        .setLabel('User Info')
        .setEmoji('🪪')
        .setStyle(ButtonStyle.Secondary)
    );
}

function afterUnbanButtons(userId) {
  return new ActionRowBuilder()
    .addComponents(

      new ButtonBuilder()
        .setCustomId(`security:history:${userId}`)
        .setLabel('History')
        .setEmoji('🧾')
        .setStyle(ButtonStyle.Primary),

      new ButtonBuilder()
        .setCustomId(`security:userinfo:${userId}`)
        .setLabel('User Info')
        .setEmoji('🪪')
        .setStyle(ButtonStyle.Secondary)
    );
}

function infoButtons(userId) {
  return new ActionRowBuilder()
    .addComponents(

      new ButtonBuilder()
        .setCustomId(`security:history:${userId}`)
        .setLabel('History')
        .setEmoji('🧾')
        .setStyle(ButtonStyle.Primary),

      new ButtonBuilder()
        .setCustomId(`security:userinfo:${userId}`)
        .setLabel('User Info')
        .setEmoji('🪪')
        .setStyle(ButtonStyle.Secondary)
    );
}

/*
================================================
EMBED / MESSAGE HELPERS
================================================
*/

function hasButton(message, customId) {
  return message.components.some(
    row =>
      row.components.some(
        button =>
          button.customId === customId
      )
  );
}

function getUserFromEmbed(embed) {
  const userField =
    embed.fields?.find(
      field =>
        field.name === '👤 العضو'
    );

  if (!userField) {
    return null;
  }

  const match =
    userField.value.match(
      /ID:\s*`(\d+)`/
    );

  return match
    ? match[1]
    : null;
}

function isOriginalSecurityCase(message, userId) {
  if (!message.embeds.length) {
    return false;
  }

  const embed = message.embeds[0];

  const embedUserId =
    getUserFromEmbed(embed);

  if (embedUserId !== userId) {
    return false;
  }

  return (
    embed.description || ''
  ).includes(
    ORIGINAL_SECURITY_DESCRIPTION
  );
}

/*
================================================
GET LATEST CASE ONLY
مهم جدًا:
بيرجع أحدث Embed للعضو فقط
عشان الحالات القديمة متتغيرش
================================================
*/

async function getLatestCaseMessage(
  userId,
  filter = null
) {
  const logChannel =
    await getLogChannel();

  if (!logChannel?.isTextBased()) {
    return null;
  }

  const messages =
    await logChannel.messages
      .fetch({ limit: 100 })
      .catch(() => null);

  if (!messages) {
    return null;
  }

  const cases =
    [...messages.values()]
      .filter(message => {

        if (!message.embeds.length) {
          return false;
        }

        const embedUserId =
          getUserFromEmbed(
            message.embeds[0]
          );

        if (embedUserId !== userId) {
          return false;
        }

        if (
          filter &&
          !filter(message)
        ) {
          return false;
        }

        return true;
      })

      .sort(
        (a, b) =>
          b.createdTimestamp -
          a.createdTimestamp
      );

  return cases[0] || null;
}

/*
================================================
SECURITY LOG
================================================
*/

async function sendSecurityLog(
  data,
  timeoutResult,
  targetMember
) {
  const channel =
    await getLogChannel();

  if (!channel?.isTextBased()) {
    return null;
  }

  const higherRole =
    !timeoutResult.ok;

  const embed =
    new EmbedBuilder()

      .setColor(
        higherRole
          ? 0xFF9800
          : 0xE53935
      )

      .setTitle(
        higherRole
          ? '⚠️ SECURITY ALERT — HIGHER ROLE'
          : '🛡️ SECURITY ALERT'
      )

      .setDescription(
        higherRole
          ? '**تم اكتشاف رساله داخل روم الحمايه لكني لا اقدر علي هذا الفحل**'
          : `**${ORIGINAL_SECURITY_DESCRIPTION}**`
      )

      .addFields(

        {
          name: '👤 العضو',

          value:
            `${data.author}\n` +
            `${data.author.tag || data.author.username}\n` +
            `ID: \`${data.author.id}\``
        },

        {
          name: '📍 الروم',

          value:
            `${data.channel}\n` +
            `\`${data.channel.id}\``
        },

        {
          name: '⏱️ Timeout',

          value:
            timeoutResult.ok
              ? `✅ تم عمل Timeout لمدة **${durationText(CONFIG.timeoutMinutes)}**`
              : `❌ لم يتم عمل Timeout\n${cut(timeoutResult.error)}`
        },

        {
          name: '🗑️ الرسالة المخالفة',

          value:
            data.currentDeleted
              ? '✅ تم حذف الرسالة داخل روم الحماية'
              : '❌ تعذر حذف الرسالة'
        },

        {
          name: '📝 السبب',

          value:
            cut(CONFIG.reason)
        },

        {
          name: '💬 محتوى الرسالة',

          value:
            cut(
              formatMessageContent(
                data.content,
                data.attachments
              )
            )
        }
      )

      .setThumbnail(
        data.author.displayAvatarURL({
          size: 256
        })
      )

      .setTimestamp();

  addFooter(embed);

  const canModerateTarget =
    targetMember &&
    (
      targetMember.moderatable ||
      targetMember.kickable ||
      targetMember.bannable
    );

  const components = [
    canModerateTarget
      ? actionButtons(data.author.id)
      : infoButtons(data.author.id)
  ];

  const images =
    data.attachments.filter(
      attachmentIsImage
    );

  const videos =
    data.attachments.filter(
      attachmentIsVideo
    );

  const other =
    data.attachments.filter(
      a =>
        !attachmentIsImage(a) &&
        !attachmentIsVideo(a)
    );

  if (images.length) {
    embed.addFields({
      name: `🖼️ الصور (${images.length})`,
      value:
        images
          .slice(0, 20)
          .map(
            (a, i) =>
              `• [🖼️ صورة ${i + 1} — فتح / تحميل](${a.url})`
          )
          .join('\n')
    });
  }

  if (videos.length) {
    embed.addFields({
      name: `🎥 الفيديوهات (${videos.length})`,
      value:
        videos
          .slice(0, 20)
          .map(
            (a, i) =>
              `• [🎥 فيديو ${i + 1} — فتح / تحميل](${a.url})`
          )
          .join('\n')
    });
  }

  if (other.length) {
    embed.addFields({
      name: `📎 ملفات أخرى (${other.length})`,
      value:
        other
          .slice(0, 20)
          .map(
            (a, i) =>
              `• [📄 ${a.name || `ملف ${i + 1}`} — تحميل](${a.url})`
          )
          .join('\n')
    });
  }

  if (images.length) {
    embed.setImage(images[0].url);
  }

  return channel.send({
    embeds: [embed],
    components
  }).catch(() => null);
}

/*
================================================
ADMIN LOG
================================================
*/

async function sendActionLogToAdmin(
  interaction,
  action,
  targetMember,
  success,
  errorText = ''
) {
  const admin =
    await client.users
      .fetch(CONFIG.adminLogUserId)
      .catch(() => null);

  if (!admin || admin.bot) {
    return;
  }

  const targetId =
    targetMember?.id ||
    interaction.customId.split(':')[2];

  const target =
    targetMember?.user ||
    `<@${targetId}>`;

  const actionNames = {
    revoke: 'REVOKE',
    kick: 'KICK',
    ban: 'BAN',
    unban: 'UN BAN'
  };

  const embed =
    new EmbedBuilder()

      .setColor(
        success
          ? 0x2E7D32
          : 0xE53935
      )

      .setTitle(
        `🛡️ SECURITY LOG — ${
          actionNames[action] ||
          action.toUpperCase()
        }`
      )

      .addFields(

        {
          name: '👤 العضو',
          value:
            `${target}\n` +
            `ID: \`${targetId}\``
        },

        {
          name: '⚙️ العملية',
          value:
            actionNames[action] ||
            action.toUpperCase()
        },

        {
          name: '🛡️ بواسطة',
          value:
            `${interaction.user}\n` +
            `ID: \`${interaction.user.id}\``
        },

        {
          name: '📌 النتيجة',
          value:
            success
              ? '✅ تمت العملية'
              : `❌ فشلت العملية\n${cut(errorText)}`
        }
      )

      .setTimestamp();

  addFooter(embed);

  await admin.send({
    embeds: [embed]
  }).catch(() => {});
}

/*
================================================
PERFORM ACTION
================================================
*/

async function performAction(
  interaction,
  action,
  targetId
) {
  const sourceGuild =
    await getProtectedGuild();

  if (!sourceGuild) {
    throw new Error(
      'تعذر العثور على سيرفر الحماية.'
    );
  }

  /*
  UNBAN
  */

  if (action === 'unban') {

    const ban =
      await sourceGuild.bans
        .fetch(targetId)
        .catch(() => null);

    if (!ban) {
      throw new Error(
        'هذا العضو ليس محظورًا حاليًا.'
      );
    }

    await sourceGuild.members.unban(
      targetId,
      `Security Un Ban بواسطة ${interaction.user.tag}`
    );

    return {
      member: {
        id: targetId,
        user: ban.user
      },
      success: true
    };
  }

  const member =
    await sourceGuild.members
      .fetch(targetId)
      .catch(() => null);

  if (!member) {
    throw new Error(
      'العضو غير موجود في سيرفر الحماية.'
    );
  }

  /*
  REVOKE
  */

  if (action === 'revoke') {

    if (
      !member.communicationDisabledUntilTimestamp ||
      member.communicationDisabledUntilTimestamp <= Date.now()
    ) {
      return {
        member,
        success: true,
        note:
          'العضو ليس عليه Timeout حاليًا.'
      };
    }

    if (!member.moderatable) {
      throw new Error(
        'البوت لا يستطيع فك Timeout لهذا العضو.'
      );
    }

    await member.timeout(
      null,
      `Security Revoke بواسطة ${interaction.user.tag}`
    );

    return {
      member,
      success: true
    };
  }

  /*
  KICK
  */

  if (action === 'kick') {

    if (!member.kickable) {
      throw new Error(
        'البوت لا يستطيع طرد هذا العضو.'
      );
    }

    markBotAction('kick', targetId);

    await member.kick(
      `Security Kick بواسطة ${interaction.user.tag}`
    );

    return {
      member,
      success: true
    };
  }

  /*
  BAN
  */

  if (action === 'ban') {

    if (!member.bannable) {
      throw new Error(
        'البوت لا يستطيع حظر هذا العضو.'
      );
    }

    markBotAction('ban', targetId);

    await member.ban({
      reason:
        `Security BAN بواسطة ${interaction.user.tag}`,
      deleteMessageSeconds: 0
    });

    return {
      member,
      success: true
    };
  }

  throw new Error('عملية غير معروفة.');
}

/*
================================================
READY
================================================
*/

client.once(
  Events.ClientReady,
  async () => {

    console.log(`✅ ${client.user.tag} شغال`);
    console.log(`🛡️ Protected: ${CONFIG.protectedChannelId}`);
    console.log(`📋 Logs: ${CONFIG.logGuildId}/${CONFIG.logChannelId}`);
    console.log(`🔐 Security role: ${CONFIG.securityRoleId}`);

    try {
      await registerCommands();

    } catch (error) {
      console.error(
        '❌ Failed to register /security:',
        error.message
      );
    }
  }
);

/*
================================================
MAIN INTERACTIONS
================================================
*/

client.on(
  Events.InteractionCreate,
  async interaction => {

    /*
    SECURITY COMMAND
    */

    if (
      interaction.isChatInputCommand() &&
      interaction.commandName === 'security'
    ) {

      if (!canUseSecurityCommand(interaction)) {
        return interaction.reply({
          content:
            '❌ معندكش صلاحية تستخدم الأمر ده.',
          flags: 64
        });
      }

      if (
        interaction.channelId !==
        CONFIG.protectedChannelId
      ) {
        return interaction.reply({
          content:
            '❌ الأمر ده لازم يتستخدم داخل روم الحماية.',
          flags: 64
        });
      }

      await interaction.deferReply({
        flags: 64
      });

      await sendSecurityPanel(
        interaction.channel
      );

      return interaction.editReply(
        '✅ تم إرسال Embed الحماية.'
      );
    }

    if (
      !interaction.isButton() ||
      !interaction.customId.startsWith('security:')
    ) {
      return;
    }

    if (
      interaction.customId.startsWith('security-confirm:') ||
      interaction.customId.startsWith('security-cancel:')
    ) {
      return;
    }

    if (!canUseSecurityCommand(interaction)) {
      return interaction.reply({
        content:
          '❌ معندكش صلاحية تستخدم أزرار الحماية.',
        flags: 64
      });
    }

    const [, action, targetId] =
      interaction.customId.split(':');

    /*
    USER INFO
    */

    if (action === 'userinfo') {

      const guild =
        await getProtectedGuild();

      const member =
        guild
          ? await guild.members
              .fetch(targetId)
              .catch(() => null)
          : null;

      if (!member) {
        return interaction.reply({
          content:
            '❌ العضو غير موجود حاليًا في سيرفر الحماية.',
          flags: 64
        });
      }

      const roles =
        member.roles.cache
          .filter(r => r.id !== guild.id)
          .sort(
            (a, b) =>
              b.position - a.position
          )
          .map(r => r.name)
          .slice(0, 20);

      const timeout =
        member.communicationDisabledUntilTimestamp >
        Date.now()

          ? `<t:${Math.floor(
              member.communicationDisabledUntilTimestamp / 1000
            )}:F>\n(<t:${Math.floor(
              member.communicationDisabledUntilTimestamp / 1000
            )}:R>)`

          : '✅ لا يوجد Timeout حاليًا';

      const embed =
        new EmbedBuilder()

          .setColor(0x5865F2)

          .setTitle('👤 USER INFO')

          .setThumbnail(
            member.user.displayAvatarURL({
              size: 256
            })
          )

          .addFields(

            {
              name: '👤 الاسم',
              value:
                `${member.user}\n` +
                `${member.user.tag || member.user.username}`,
              inline: true
            },

            {
              name: '🆔 User ID',
              value: `\`${member.id}\``,
              inline: true
            },

            {
              name: '🤖 النوع',
              value:
                member.user.bot
                  ? 'Bot'
                  : 'User',
              inline: true
            },

            {
              name: '📅 إنشاء الحساب',
              value:
                `<t:${Math.floor(
                  member.user.createdTimestamp / 1000
                )}:F>\n` +
                `(<t:${Math.floor(
                  member.user.createdTimestamp / 1000
                )}:R>)`
            },

            {
              name: '📥 دخول السيرفر',
              value:
                member.joinedTimestamp
                  ? `<t:${Math.floor(
                      member.joinedTimestamp / 1000
                    )}:F>\n(<t:${Math.floor(
                      member.joinedTimestamp / 1000
                    )}:R>)`
                  : 'غير متاح'
            },

            {
              name: '⏱️ Timeout Status',
              value: timeout
            },

            {
              name:
                `🎭 Roles (${roles.length})`,
              value:
                roles.length
                  ? cut(roles.join('\n'))
                  : 'بدون رولات'
            }
          )

          .setTimestamp();

      addFooter(embed);

      return interaction.reply({
        embeds: [embed],
        flags: 64
      });
    }

    /*
    HISTORY
    */

    if (action === 'history') {

      const logChannel =
        await getLogChannel();

      const messages =
        logChannel
          ? await logChannel.messages
              .fetch({ limit: 100 })
              .catch(() => null)
          : null;

      const history =
        messages
          ? [...messages.values()]
              .filter(
                message =>
                  getUserFromEmbed(
                    message.embeds[0]
                  ) === targetId
              )
              .sort(
                (a, b) =>
                  b.createdTimestamp -
                  a.createdTimestamp
              )
              .slice(0, 10)
          : [];

      const embed =
        new EmbedBuilder()

          .setColor(0x5865F2)

          .setTitle('📜 SECURITY HISTORY')

          .setDescription(
            history.length
              ? history
                  .map(
                    (message, index) =>
                      `**${index + 1}.** ` +
                      `<t:${Math.floor(
                        message.createdTimestamp / 1000
                      )}:F> — ` +
                      `[فتح الحالة](${message.url})`
                  )
                  .join('\n')
              : 'لا يوجد سجل حالات ظاهر لهذا العضو ضمن آخر 100 رسالة لوج.'
          )

          .setTimestamp();

      addFooter(embed);

      return interaction.reply({
        embeds: [embed],
        flags: 64
      });
    }

    /*
    ACTION CONFIRM
    */

    const names = {
      revoke: 'فك الـ Timeout',
      kick: 'Kick',
      ban: 'BAN',
      unban: 'Un Ban'
    };

    if (!names[action] || !targetId) {
      return;
    }

    const confirmRow =
      new ActionRowBuilder()
        .addComponents(

          new ButtonBuilder()
            .setCustomId(
              `security-confirm:${action}:${targetId}:${interaction.message.id}`
            )
            .setLabel('تأكيد')
            .setStyle(ButtonStyle.Danger),

          new ButtonBuilder()
            .setCustomId(
              `security-cancel:${action}:${targetId}:${interaction.message.id}`
            )
            .setLabel('إلغاء')
            .setStyle(ButtonStyle.Secondary)
        );

    const confirmEmbed =
      new EmbedBuilder()

        .setColor(0xFF9800)

        .setTitle('⚠️ تأكيد العملية')

        .setDescription(
          `هل أنت متأكد من تنفيذ **${names[action]}** على <@${targetId}>؟\n\n` +
          `**العملية:** ${action.toUpperCase()}\n` +
          `**العضو:** <@${targetId}>`
        )

        .setTimestamp();

    addFooter(confirmEmbed);

    await interaction.reply({
      embeds: [confirmEmbed],
      components: [confirmRow],
      flags: 64
    });
  }
);

/*
================================================
CONFIRM ACTION
================================================
*/

client.on(
  Events.InteractionCreate,
  async interaction => {

    if (
      !interaction.isButton() ||
      (
        !interaction.customId.startsWith('security-confirm:') &&
        !interaction.customId.startsWith('security-cancel:')
      )
    ) {
      return;
    }

    if (!canUseSecurityCommand(interaction)) {
      return interaction.reply({
        content:
          '❌ معندكش صلاحية تستخدم أزرار الحماية.',
        flags: 64
      });
    }

    const [
      prefix,
      action,
      targetId,
      sourceMessageId
    ] =
      interaction.customId.split(':');

    /*
    CANCEL
    */

    if (prefix === 'security-cancel') {

      const cancelEmbed =
        new EmbedBuilder()
          .setColor(0x757575)
          .setTitle('↩️ تم إلغاء العملية')
          .setDescription('لم يتم تنفيذ أي إجراء.')
          .setTimestamp();

      addFooter(cancelEmbed);

      return interaction.update({
        embeds: [cancelEmbed],
        components: []
      });
    }

    await interaction.deferUpdate();

    let result;

    try {

      result =
        await performAction(
          interaction,
          action,
          targetId
        );

      await sendActionLogToAdmin(
        interaction,
        action,
        result.member,
        result.success,
        result.note || ''
      );

    } catch (error) {

      const guild =
        await getProtectedGuild();

      let member = null;

      if (action !== 'unban') {
        member =
          await guild?.members
            .fetch(targetId)
            .catch(() => null);
      }

      await sendActionLogToAdmin(
        interaction,
        action,
        member,
        false,
        error.message
      );

      result = {
        member,
        success: false,
        error: error.message
      };
    }

    const names = {
      revoke: 'فك الـ Timeout',
      kick: 'Kick',
      ban: 'BAN',
      unban: 'Un Ban'
    };

    const resultEmbed =
      new EmbedBuilder()

        .setColor(
          result.success
            ? 0x2E7D32
            : 0xE53935
        )

        .setTitle(
          result.success
            ? '✅ تم تنفيذ العملية'
            : '❌ فشل تنفيذ العملية'
        )

        .setDescription(
          `**العملية:** ${names[action] || action}\n` +
          `**العضو:** <@${targetId}>\n\n` +
          (
            result.success
              ? 'تم إرسال سجل العملية إلى Admin User في الخاص.'
              : `**الخطأ:** ${cut(result.error)}`
          )
        )

        .setTimestamp();

    addFooter(resultEmbed);

    /*
    تعديل الحالة اللي ضغطت منها الزر فقط
    */

    if (
      sourceMessageId &&
      result.success
    ) {

      const logChannel =
        await getLogChannel();

      const sourceMessage =
        logChannel
          ? await logChannel.messages
              .fetch(sourceMessageId)
              .catch(() => null)
          : null;

      if (
        sourceMessage &&
        sourceMessage.embeds.length
      ) {

        const original =
          EmbedBuilder.from(
            sourceMessage.embeds[0]
          );

        if (action === 'revoke') {

          original
            .setColor(0x2E7D32)
            .setTitle('🔄 TIMEOUT REVOKED')
            .setDescription(
              `**تم فك الـ Timeout باستخدام زر Revoke.**\n\n` +
              `👤 العضو: <@${targetId}>\n` +
              `🛡️ بواسطة: ${interaction.user}`
            )
            .setTimestamp();

          addFooter(original);

          await sourceMessage.edit({
            embeds: [original],
            components: [
              timeoutRemovedButtons(targetId)
            ]
          }).catch(() => {});
        }

        if (action === 'kick') {

          original
            .setColor(0xFF9800)
            .setTitle('🚫 SECURITY ACTION — KICK')
            .setDescription(
              `**تم تنفيذ إجراء Kick على العضو.**\n\n` +
              `👤 العضو: <@${targetId}>\n` +
              `🛡️ بواسطة: ${interaction.user}`
            )
            .setTimestamp();

          addFooter(original);

          await sourceMessage.edit({
            embeds: [original],
            components: [
              afterKickButtons(targetId)
            ]
          }).catch(() => {});
        }

        if (action === 'ban') {

          original
            .setColor(0xE53935)
            .setTitle('⛔ SECURITY ACTION — BAN')
            .setDescription(
              `**تم تنفيذ إجراء BAN على العضو.**\n\n` +
              `👤 العضو: <@${targetId}>\n` +
              `🛡️ بواسطة: ${interaction.user}`
            )
            .setTimestamp();

          addFooter(original);

          await sourceMessage.edit({
            embeds: [original],
            components: [
              afterBanButtons(targetId)
            ]
          }).catch(() => {});
        }

        if (action === 'unban') {

          original
            .setColor(0x2E7D32)
            .setTitle('🔓 SECURITY ACTION — UN BAN')
            .setDescription(
              `**تم فك الحظر عن العضو بنجاح.**\n\n` +
              `👤 العضو: <@${targetId}>\n` +
              `🛡️ بواسطة: ${interaction.user}`
            )
            .setTimestamp();

          addFooter(original);

          await sourceMessage.edit({
            embeds: [original],
            components: [
              afterUnbanButtons(targetId)
            ]
          }).catch(() => {});
        }
      }
    }

    await interaction.editReply({
      embeds: [resultEmbed],
      components: []
    });
  }
);


/* ANTI BOT + ANTI ROLE */
async function dedicatedLog(id) {
  if (!id) return null;
  const g = await getGuild(CONFIG.logGuildId);
  if (!g) return null;
  const c = await g.channels.fetch(id).catch(() => null);
  return c && c.isTextBased() ? c : null;
}
async function securityAuditActor(guild, type, targetId) {
  try {
    await new Promise(r => setTimeout(r, 1200));
    const logs = await guild.fetchAuditLogs({type, limit: 15});
    const e = logs.entries.find(x => x.target && x.target.id === targetId && Date.now() - x.createdTimestamp < 30000);
    return e ? e.executor : null;
  } catch (e) { console.error('[Security Audit]', e); return null; }
}
async function antiAdminDM(action, targetId, actor, success, details) {
  const admin = await client.users.fetch(CONFIG.adminLogUserId).catch(() => null);
  if (!admin || admin.bot) return;
  const e = new EmbedBuilder().setColor(success ? 0x2E7D32 : 0xE53935)
    .setTitle('🛡️ SECURITY LOG — ' + action)
    .addFields(
      {name:'🎯 الهدف',value:'<@' + targetId + '>\nID: ' + targetId},
      {name:'👮 بواسطة',value:actor.toString() + '\nID: ' + actor.id},
      {name:'📌 النتيجة',value:(success ? '✅ تمت العملية\n' : '❌ فشلت العملية\n') + cut(details)}
    ).setTimestamp();
  addFooter(e); await admin.send({embeds:[e]}).catch(()=>{});
}
function antiBotRows(id) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('antibot:kick:' + id).setLabel('Kick').setEmoji('🚫').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('antibot:ban:' + id).setLabel('Ban').setEmoji('⛔').setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId('antibot:info:' + id).setLabel('Bot Info').setEmoji('🤖').setStyle(ButtonStyle.Secondary)
  );
}
function autoRoleRows(uid, roleIds = [], originalRoleIds = roleIds) {
  const buttons = [
    new ButtonBuilder().setCustomId('autorole:info:' + uid).setLabel('User Info').setEmoji('🪪').setStyle(ButtonStyle.Secondary),
    ...roleIds.slice(0, 23).map(rid =>
      new ButtonBuilder()
        .setCustomId('autorole:remove:' + uid + ':' + rid)
        .setLabel('Remove ' + (originalRoleIds.indexOf(rid) + 1))
        .setEmoji('🗑️')
        .setStyle(ButtonStyle.Danger)
    )
  ];

  // Keep Remove All available as long as at least one alerted role remains.
  if (roleIds.length > 0) {
    buttons.push(
      new ButtonBuilder()
        .setCustomId('autorole:removeall:' + uid)
        .setLabel('Remove All')
        .setEmoji('⛔')
        .setStyle(ButtonStyle.Danger)
    );
  }

  const rows = [];
  for (let index = 0; index < buttons.length; index += 5) {
    rows.push(new ActionRowBuilder().addComponents(buttons.slice(index, index + 5)));
  }
  return rows;
}

function getAntiRoleIdsFromEmbed(embed) {
  const field = embed?.fields?.find(item => item.name === '🎭 الرولات الخطيرة المضافة');
  if (!field) return [];
  return [...new Set([...field.value.matchAll(/ID: `([0-9]+)`/g)].map(match => match[1]))];
}
function confirmRows(prefix, action, uid, rid) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(prefix + ':confirm:' + action + ':' + uid + ':' + (rid || 'none')).setLabel('تأكيد').setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId(prefix + ':cancel:' + action + ':' + uid + ':' + (rid || 'none')).setLabel('إلغاء').setStyle(ButtonStyle.Secondary)
  );
}
function securityInfoEmbed(member, guild, title) {
  const roles = member.roles.cache.filter(r=>r.id!==guild.id).sort((a,b)=>b.position-a.position).map(r=>r.name).slice(0,20);
  const ts = member.communicationDisabledUntilTimestamp;
  const timeout = ts && ts>Date.now() ? '<t:'+Math.floor(ts/1000)+':F>\n(<t:'+Math.floor(ts/1000)+':R>)' : '✅ لا يوجد Timeout حاليًا';
  const e = new EmbedBuilder().setColor(0x5865F2).setTitle(title).setThumbnail(member.user.displayAvatarURL({size:256}))
    .addFields(
      {name:'👤 الاسم',value:member.user.toString()+'\n'+(member.user.tag||member.user.username),inline:true},
      {name:'🆔 User ID',value:member.id,inline:true},
      {name:'🤖 النوع',value:member.user.bot?'Bot':'User',inline:true},
      {name:'📅 إنشاء الحساب',value:'<t:'+Math.floor(member.user.createdTimestamp/1000)+':F>\n(<t:'+Math.floor(member.user.createdTimestamp/1000)+':R>)'},
      {name:'📥 دخول السيرفر',value:member.joinedTimestamp?'<t:'+Math.floor(member.joinedTimestamp/1000)+':F>\n(<t:'+Math.floor(member.joinedTimestamp/1000)+':R>)':'غير متاح'},
      {name:'🎭 Roles ('+roles.length+')',value:roles.length?cut(roles.join('\n')):'بدون رولات'}
    ).setTimestamp();
  addFooter(e); return e;
}
async function findDedicatedLogMessage(channel, customId) {
  if (!channel?.isTextBased()) return null;
  const messages = await channel.messages.fetch({limit:100}).catch(() => null);
  if (!messages) return null;
  return [...messages.values()]
    .filter(m => m.embeds.length && hasButton(m, customId))
    .sort((a,b) => b.createdTimestamp-a.createdTimestamp)[0] || null;
}
async function updateDedicatedStatus(message, title, description, color = 0x757575, preserveInfo = true) {
  if (!message?.embeds?.length) return;
  const embed = EmbedBuilder.from(message.embeds[0])
    .setColor(color).setTitle(title).setDescription(description).setTimestamp();
  addFooter(embed);

  // Keep the relevant info button on the log forever, even after status changes.
  const infoButton = preserveInfo ? message.components
    .flatMap(row => row.components)
    .find(button =>
      button.customId?.startsWith('autorole:info:') ||
      button.customId?.startsWith('antibot:info:')
    ) : null;

  const components = infoButton
    ? [new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(infoButton.customId)
          .setLabel(infoButton.label || (infoButton.customId.startsWith('antibot:') ? 'Bot Info' : 'User Info'))
          .setEmoji(infoButton.emoji?.name || (infoButton.customId.startsWith('antibot:') ? '🤖' : '🪪'))
          .setStyle(ButtonStyle.Secondary)
      )]
    : [];

  await message.edit({embeds:[embed],components}).catch(() => {});
}

client.on(Events.GuildMemberAdd, async member => {
  try {
    const pg=await getProtectedGuild();
    if(!pg || member.guild.id!==pg.id || !member.user.bot) return;
    const ch=await dedicatedLog(CONFIG.antiBotLogChannelId);
    if(!ch){console.error('[Anti Bot] Missing ANTI_BOT_LOG_CHANNEL_ID channel');return;}
    const actor=await securityAuditActor(member.guild,AuditLogEvent.BotAdd,member.id);
    const e=new EmbedBuilder().setColor(0xE53935).setTitle('🤖 ANTI BOT — NEW BOT DETECTED')
      .setDescription('تم رصد دخول Bot جديد إلى سيرفر الحماية.')
      .addFields(
        {name:'🤖 البوت',value:member.user.toString()+'\n'+(member.user.tag||member.user.username)+'\nID: '+member.id},
        {name:'👮 تمت إضافته بواسطة',value:actor?actor.toString()+'\nID: '+actor.id:'غير متاح من Audit Logs'},
        {name:'📅 إنشاء الحساب',value:'<t:'+Math.floor(member.user.createdTimestamp/1000)+':F>'}
      ).setThumbnail(member.user.displayAvatarURL({size:256})).setTimestamp();
    addFooter(e); await ch.send({embeds:[e],components:[antiBotRows(member.id)]});
  } catch(e){console.error('[Anti Bot Join]',e);}
});
client.on(Events.GuildMemberUpdate, async (oldMember, newMember) => {
  try {
    const pg = await getProtectedGuild();
    if (!pg || newMember.guild.id !== pg.id) return;

    // Collect all recent $add entries for this member so rapid multi-role assignments
    // are reported together in one Embed. Process each Audit Log entry only once.
    await new Promise(resolve => setTimeout(resolve, 1800));
    const auditLogs = await newMember.guild.fetchAuditLogs({
      type: AuditLogEvent.MemberRoleUpdate,
      limit: 25
    }).catch(() => null);

    const auditCandidates = [...(auditLogs?.entries.values() || [])]
      .filter(entry =>
        entry.target?.id === newMember.id &&
        Date.now() - entry.createdTimestamp < 10000 &&
        !processedAntiRoleAuditEntries.has(entry.id) &&
        Array.isArray(entry.changes?.find(change => change.key === '$add')?.new) &&
        entry.changes.find(change => change.key === '$add').new.length > 0
      )
      .sort((a, b) => a.createdTimestamp - b.createdTimestamp);

    if (!auditCandidates.length) {
      console.log('[Anti Role] No unprocessed $add Audit Log entries for ' + newMember.id);
      return;
    }

    // Mark entries before continuing so multiple GuildMemberUpdate events cannot
    // create duplicate alerts for the same role assignment.
    for (const entry of auditCandidates) {
      processedAntiRoleAuditEntries.add(entry.id);
    }
    if (processedAntiRoleAuditEntries.size > 5000) {
      processedAntiRoleAuditEntries.clear();
    }

    const addedRoleIds = new Set(
      auditCandidates.flatMap(entry =>
        (entry.changes.find(change => change.key === '$add')?.new || [])
          .map(role => role.id)
          .filter(Boolean)
      )
    );

    const dangerous = role =>
      role.permissions.has(PermissionsBitField.Flags.Administrator) ||
      role.permissions.has(PermissionsBitField.Flags.ManageRoles);

    // Report only roles explicitly listed in the collected Audit Log $add entries.
    const addedRoles = [...addedRoleIds]
      .map(id => newMember.guild.roles.cache.get(id))
      .filter(role =>
        role &&
        newMember.roles.cache.has(role.id) &&
        dangerous(role)
      );

    if (!addedRoles.length) return;

    const actor = auditCandidates.find(entry => entry.executor)?.executor || null;
    const logChannel = await dedicatedLog(CONFIG.autoRoleLogChannelId);
    if (!logChannel) {
      console.error('[Anti Role] Missing AUTO_ROLE_LOG_CHANNEL_ID channel');
      return;
    }

    const roleLines = addedRoles.map((role, index) => {
      const permission = role.permissions.has(PermissionsBitField.Flags.Administrator)
        ? 'Administrator'
        : 'Manage Roles';
      // Use the plain role name, not role.toString(), to avoid pinging @role.
      return (index + 1) + '. **' + role.name + '**' +
        '\n🔐 ' + permission + '\nID: \`' + role.id + '\`';
    });

    const embed = new EmbedBuilder()
      .setColor(0xE53935)
      .setTitle('⚠️ ANTI ROLE — DANGEROUS ROLES ASSIGNED')
      .setDescription('تم رصد إضافة الرولات الخطيرة التالية. استخدم زر كل رول لإزالتها منفردة أو Remove All لإزالة كل الرولات المذكورة فقط.')
      .addFields(
        { name: '👤 العضو', value: newMember.user.toString() + '\n' + (newMember.user.tag || newMember.user.username) + '\nID: ' + newMember.id },
        { name: '🎭 الرولات الخطيرة المضافة', value: cut(roleLines.join('\n\n'), 1024) },
        { name: '👮 بواسطة', value: actor ? actor.toString() + '\nID: ' + actor.id : 'غير متاح من Audit Logs' }
      )
      .setThumbnail(newMember.user.displayAvatarURL({ size: 256 }))
      .setTimestamp();
    addFooter(embed);

    // One button per role, plus Remove All and User Info.
    const roleIds = addedRoles.map(role => role.id);
    await logChannel.send({ embeds: [embed], components: autoRoleRows(newMember.id, roleIds) });

  } catch (error) {
    console.error('[Anti Role Update]', error);
  }
});

// Detect manual kicks and bans of bots and update their original Anti Bot log.
client.on(Events.GuildMemberRemove, async member => {
  try {
    const pg = await getProtectedGuild();
    if (!pg || member.guild.id !== pg.id || !member.user.bot || isBotAction('kick', member.id)) return;
    const actor = await securityAuditActor(member.guild, AuditLogEvent.MemberKick, member.id);
    if (!actor) return;
    const ch = await dedicatedLog(CONFIG.antiBotLogChannelId);
    const msg = await findDedicatedLogMessage(ch, 'antibot:kick:' + member.id);
    if (!msg) return;
    await updateDedicatedStatus(msg, '🚫 ANTI BOT — MANUALLY KICKED',
      'تم طرد البوت يدويًا من السيرفر.\n\n🤖 البوت: <@' + member.id + '>\n👮 بواسطة: ' + actor.toString(), 0xFF9800, false);
  } catch (e) { console.error('[Anti Bot Manual Kick]', e); }
});
client.on(Events.GuildBanAdd, async ban => {
  try {
    const pg = await getProtectedGuild();
    if (!pg || ban.guild.id !== pg.id || !ban.user.bot || isBotAction('ban', ban.user.id)) return;
    const actor = await securityAuditActor(ban.guild, AuditLogEvent.MemberBanAdd, ban.user.id);
    if (!actor) return;
    const ch = await dedicatedLog(CONFIG.antiBotLogChannelId);
    const msg = await findDedicatedLogMessage(ch, 'antibot:ban:' + ban.user.id);
    if (!msg) return;
    await updateDedicatedStatus(msg, '⛔ ANTI BOT — MANUALLY BANNED',
      'تم حظر البوت يدويًا من السيرفر.\n\n🤖 البوت: <@' + ban.user.id + '>\n👮 بواسطة: ' + actor.toString(), 0xE53935, false);
  } catch (e) { console.error('[Anti Bot Manual Ban]', e); }
});

client.on(Events.InteractionCreate, async i => {
  if(!i.isButton() || (!i.customId.startsWith('antibot:')&&!i.customId.startsWith('autorole:')))return;
  if(!canUseSecurityCommand(i))return i.reply({content:'❌ معندكش صلاحية تستخدم أزرار الحماية.',flags:64});
  const p=i.customId.split(':'); const prefix=p[0], action=p[1], id=p[2], roleId=p[3];
  const isBot=prefix==='antibot'; const guild=await getProtectedGuild();
  if(!guild)return i.reply({content:'❌ تعذر العثور على سيرفر الحماية.',flags:64});
  if(action==='info'){
    const m=await guild.members.fetch(id).catch(()=>null);
    if(!m)return i.reply({content:'❌ الحساب لم يعد موجودًا في سيرفر الحماية.',flags:64});
    return i.reply({embeds:[securityInfoEmbed(m,guild,isBot?'🤖 BOT INFO':'👤 USER INFO')],flags:64});
  }
  if(['remove','removeall','kick','ban','roles'].includes(action)){
    const m=await guild.members.fetch(id).catch(()=>null);
    if(!m)return i.reply({content:'❌ الحساب لم يعد موجودًا في سيرفر الحماية.',flags:64});
    const listedRoleIds = prefix === 'autorole' ? getAntiRoleIdsFromEmbed(i.message.embeds[0]) : [];
    if(action==='remove'&&(!roleId||!listedRoleIds.includes(roleId)||!m.roles.cache.has(roleId)))return i.reply({content:'❌ الرول المحددة لم تعد ضمن التنبيه أو لم تعد موجودة على العضو.',flags:64});
    if(action==='removeall'&&!listedRoleIds.some(rid=>m.roles.cache.has(rid)))return i.reply({content:'❌ لا توجد رولات من التنبيه ما زالت على العضو.',flags:64});
    const labels={remove:'إزالة الرول المحددة فقط',removeall:'إزالة كل الرولات المذكورة في التنبيه فقط',kick:'طرد البوت',ban:'حظر البوت',roles:'إزالة كل الرولات القابلة للإزالة'};
    const e=EmbedBuilder.from(i.message.embeds[0]).setColor(0xFF9800).setDescription('⚠️ هل أنت متأكد من تنفيذ **'+labels[action]+'** على <@'+id+'>؟');
    return i.update({embeds:[e],components:[confirmRows(prefix,action,id,roleId || 'none')]});
  }
  if(action!=='confirm'&&action!=='cancel')return;
  const operation=id, targetId=roleId, targetRole=p[4]==='none'?null:p[4];
  const member=await guild.members.fetch(targetId).catch(()=>null);
  const original=EmbedBuilder.from(i.message.embeds[0]);
  if(action==='cancel'){
    original.setColor(0x757575).setDescription('↩️ تم إلغاء العملية. لم يتم تنفيذ أي إجراء.');
    const restored = prefix === 'autorole'
      ? autoRoleRows(targetId, getAntiRoleIdsFromEmbed(original))
      : [antiBotRows(targetId)];
    return i.update({embeds:[original],components:restored});
  }
  await i.deferUpdate();
  let ok=false, detail='', targetUser=member?member.user:null;
  try{
    if(!member)throw new Error('الحساب لم يعد موجودًا في السيرفر.');
    if(operation==='remove' || operation==='removeall'){
      const me = await guild.members.fetch(client.user.id);
      if(!me)throw new Error('تعذر تحديد أعلى رول للبوت.');
      const requestedIds = operation === 'remove'
        ? [targetRole]
        : getAntiRoleIdsFromEmbed(original);
      const removable = requestedIds
        .map(rid => guild.roles.cache.get(rid))
        .filter(role => role && member.roles.cache.has(role.id) && !role.managed && role.position < me.roles.highest.position);
      const skipped = requestedIds.filter(rid => {
        const role = guild.roles.cache.get(rid);
        return member.roles.cache.has(rid) && (!role || role.managed || role.position >= me.roles.highest.position);
      });
      if(!removable.length)throw new Error('لا توجد رولات من التنبيه يمكن للبوت إزالتها. قد تكون Managed أو أعلى من رتبة البوت.');
      await member.roles.remove(removable.map(role => role.id),'Anti Role '+operation+' by '+i.user.tag);
      detail = 'تمت إزالة '+removable.length+' رول: '+removable.map(role => role.name).join('، ') +
        (skipped.length ? '\nتعذر إزالة '+skipped.length+' رول بسبب الصلاحيات أو ترتيب الرولات.' : '');
      ok = skipped.length === 0;
      if(skipped.length) detail = 'تمت إزالة بعض الرولات بنجاح، مع تعذر إزالة الباقي.\n'+detail;
    }else if(operation==='kick'){
      if(!member.kickable)throw new Error('البوت لا يستطيع طرد هذا البوت بسبب الصلاحيات أو ترتيب الرولات.');
      markBotAction('kick', targetId);
      await member.kick('Anti Bot action by '+i.user.tag); detail='تم طرد البوت من السيرفر.'; ok=true;
    }else if(operation==='ban'){
      if(!member.bannable)throw new Error('البوت لا يستطيع حظر هذا البوت بسبب الصلاحيات أو ترتيب الرولات.');
      markBotAction('ban', targetId);
      await member.ban({reason:'Anti Bot action by '+i.user.tag}); detail='تم حظر البوت من السيرفر.'; ok=true;
    }else if(operation==='roles'){
      const freshMember = await guild.members.fetch(targetId);
      const me = await guild.members.fetch(client.user.id);
      if(!me)throw new Error('تعذر تحديد أعلى رول للبوت.');
      const removable = freshMember.roles.cache.filter(r => r.id !== guild.id && !r.managed && r.position < me.roles.highest.position);
      const skipped = freshMember.roles.cache.filter(r => r.id !== guild.id && (r.managed || r.position >= me.roles.highest.position));
      if(removable.size) {
        await freshMember.roles.remove(removable.map(r => r.id), 'Anti Bot remove roles by '+i.user.tag);
      }
      const verified = await guild.members.fetch(targetId);
      const remaining = verified.roles.cache.filter(r => r.id !== guild.id);
      const managedRoles = remaining.filter(r => r.managed);
      detail = 'تمت إزالة '+removable.size+' رول قابلة للإزالة. الرولات المتبقية: '+remaining.size+
        '. الرولات Managed/الأعلى من رتبة البوت: '+skipped.size+
        (managedRoles.size ? '. رول البوت المُدارة من Discord لا يمكن تعديل صلاحياتها أو حذفها عبر البوت.' : '')+
        '. الرولات المتبقية فعليًا: '+remaining.map(r => r.name).join('، ');
      ok=true;
    }
  }catch(e){detail=e.message||'حدث خطأ غير معروف.';}
  const name=operation==='remove'?'REMOVE ROLE':operation==='removeall'?'REMOVE ALL ROLES':operation.toUpperCase();
  const status=EmbedBuilder.from(original).setColor(ok?0x2E7D32:0xE53935)
    .setTitle((ok?'✅ ':'❌ ')+name+(ok?' — COMPLETED':' — FAILED'))
    .setDescription((ok?'تم تنفيذ الإجراء بنجاح.':'تعذر تنفيذ الإجراء.')+'\n\n🎯 الهدف: <@'+targetId+'>\n🛡️ بواسطة: '+i.user.toString()+'\n\n'+cut(detail)).setTimestamp();
  addFooter(status);
  let rows=[];
  if(prefix === 'autorole') {
    const latestMember = await guild.members.fetch(targetId).catch(() => member);
    const remainingRoleIds = getAntiRoleIdsFromEmbed(original).filter(rid =>
      latestMember?.roles.cache.has(rid)
    );
    rows = autoRoleRows(targetId, remainingRoleIds, getAntiRoleIdsFromEmbed(original));
  } else if(operation === 'kick' || operation === 'ban') {
    // Once removed from the guild, Bot Info is no longer actionable.
    rows = [];
  } else {
    rows = [new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('antibot:info:'+targetId)
        .setLabel('Bot Info').setEmoji('🤖').setStyle(ButtonStyle.Secondary)
    )];
  }
  await i.message.edit({embeds:[status],components:rows}).catch(()=>{});
  await antiAdminDM(name,targetId,i.user,ok,detail);
  if(!ok)await i.followUp({content:'❌ '+cut(detail),flags:64}).catch(()=>{});
});


/*
================================================
MESSAGE PROTECTION
================================================
*/

client.on(
  Events.MessageCreate,
  async message => {

    if (
      !message.guild ||
      message.author.bot ||
      message.channelId !==
        CONFIG.protectedChannelId
    ) {
      return;
    }

    // Notify the member privately with a red embed and a mention outside it.
    const warningEmbed = new EmbedBuilder()
      .setColor(0xFF0000)
      .setTitle('⚠️ ملاحظة')
      .setDescription(
        '**لقد تم تفعيل نظام الحماية على حسابك فقد يشير ذلك إلى أن حسابك تعرض للاختراق أو تم استخدامه لإرسال رسائل غير مصرح بها.**\n\n' +
        '**في حال كنت تعتقد أن الإجراء تم بالخطأ يرجى التواصل مع <@1229173247157997721> بعد تأمين حسابك.**'
      );

    try {
      await message.author.send({
        content: `<@${message.author.id}>`,
        embeds: [warningEmbed],
        allowedMentions: { users: [message.author.id] }
      });
      console.log(`📩 Security DM sent to ${message.author.id}`);
    } catch (error) {
      console.warn(`⚠️ Could not send security DM to ${message.author.id}: ${error.message}`);
    }

    const data = {
      author: message.author,
      channel: message.channel,
      content: message.content,
      attachments:
        attachmentList(message),
      currentDeleted: false
    };

    const timeoutResult =
      await doTimeout(
        message.member
      );

    try {
      await message.delete();
      data.currentDeleted = true;
    } catch {}

    await sendSecurityLog(
      data,
      timeoutResult,
      message.member
    );
  }
);

/*
================================================
TIMEOUT MANUAL REMOVAL
أحدث حالة فقط
================================================
*/

client.on(
  Events.GuildMemberUpdate,
  async (oldMember, newMember) => {

    try {

      const protectedGuild =
        await getProtectedGuild();

      if (
        !protectedGuild ||
        newMember.guild.id !== protectedGuild.id
      ) {
        return;
      }

      const oldTimeout =
        oldMember.communicationDisabledUntilTimestamp;

      const newTimeout =
        newMember.communicationDisabledUntilTimestamp;

      /*
      كان عليه Timeout
      واتشال يدوي قبل ما ينتهي
      */

      if (
        oldTimeout &&
        oldTimeout > Date.now() &&
        (
          !newTimeout ||
          newTimeout <= Date.now()
        )
      ) {

        /*
        أحدث حالة فقط
        ولازم تكون أصلية
        وفيها Revoke
        */

        const message =
          await getLatestCaseMessage(
            newMember.id,
            msg =>
              isOriginalSecurityCase(
                msg,
                newMember.id
              ) &&
              hasButton(
                msg,
                `security:revoke:${newMember.id}`
              )
          );

        if (!message) {
          return;
        }

        const newEmbed =
          EmbedBuilder.from(
            message.embeds[0]
          );

        newEmbed
          .setColor(0x5865F2)
          .setTitle(
            '🔄 TIMEOUT REMOVED MANUALLY'
          )
          .setDescription(
            `**تم فك الـ Timeout يدويًا بواسطة الإدارة.**\n\n` +
            `👤 العضو: <@${newMember.id}>`
          )
          .setTimestamp();

        addFooter(newEmbed);

        await message.edit({
          embeds: [newEmbed],
          components: [
            timeoutRemovedButtons(newMember.id)
          ]
        }).catch(() => {});

        console.log(
          `🔄 Manual Timeout Remove: ${newMember.id}`
        );
      }

    } catch (error) {
      console.error(
        '[Timeout Monitor]',
        error
      );
    }
  }
);

/*
================================================
TIMEOUT EXPIRATION CHECKER
أحدث حالة فقط
كل 15 ثانية
================================================
*/

setInterval(
  async () => {

    try {

      const protectedGuild =
        await getProtectedGuild();

      if (!protectedGuild) {
        return;
      }

      const logChannel =
        await getLogChannel();

      if (!logChannel?.isTextBased()) {
        return;
      }

      const messages =
        await logChannel.messages
          .fetch({ limit: 100 })
          .catch(() => null);

      if (!messages) {
        return;
      }

      /*
      نجيب كل User IDs
      */

      const userIds =
        new Set();

      for (
        const message
        of messages.values()
      ) {

        if (!message.embeds.length) {
          continue;
        }

        const userId =
          getUserFromEmbed(
            message.embeds[0]
          );

        if (userId) {
          userIds.add(userId);
        }
      }

      /*
      لكل عضو:
      نفحص أحدث حالة فقط
      */

      for (
        const userId
        of userIds
      ) {

        const message =
          await getLatestCaseMessage(
            userId,
            msg =>
              isOriginalSecurityCase(
                msg,
                userId
              ) &&
              hasButton(
                msg,
                `security:revoke:${userId}`
              )
          );

        if (!message) {
          continue;
        }

        const member =
          await protectedGuild.members
            .fetch(userId)
            .catch(() => null);

        if (!member) {
          continue;
        }

        const timeoutUntil =
          member.communicationDisabledUntilTimestamp;

        /*
        Timeout لسه شغال
        */

        if (
          timeoutUntil &&
          timeoutUntil > Date.now()
        ) {
          continue;
        }

        /*
        نتأكد إن دي لسه أحدث حالة
        */

        const freshMessage =
          await getLatestCaseMessage(
            userId,
            msg =>
              msg.id === message.id &&
              isOriginalSecurityCase(
                msg,
                userId
              ) &&
              hasButton(
                msg,
                `security:revoke:${userId}`
              )
          );

        if (!freshMessage) {
          continue;
        }

        const newEmbed =
          EmbedBuilder.from(
            freshMessage.embeds[0]
          );

        /*
        اللون الرصاصي
        */

        newEmbed
          .setColor(0x757575)
          .setTitle(
            '⏱️ TIMEOUT EXPIRED'
          )
          .setDescription(
            `**تم انتهاء مدة الـ Timeout الخاصة بالعضو.**\n\n` +
            `👤 العضو: <@${userId}>\n\n` +
            'لم يتم تنفيذ أي إجراء إضافي.'
          )
          .setTimestamp();

        addFooter(newEmbed);

        await freshMessage.edit({
          embeds: [newEmbed],
          components: [
            timeoutRemovedButtons(userId)
          ]
        }).catch(() => {});

        console.log(
          `⏱️ Timeout expired for ${userId}`
        );
      }

    } catch (error) {
      console.error(
        '[Timeout Expiration Checker]',
        error
      );
    }

  },
  15000
);

/*
================================================
GET KICK EXECUTOR
================================================
*/

async function getKickExecutor(
  guild,
  userId
) {
  try {

    await new Promise(
      resolve =>
        setTimeout(resolve, 1200)
    );

    const logs =
      await guild.fetchAuditLogs({
        type: AuditLogEvent.MemberKick,
        limit: 10
      });

    const entry =
      logs.entries.find(
        log =>
          log.target?.id === userId &&
          Date.now() -
            log.createdTimestamp <
            15000
      );

    return entry?.executor || null;

  } catch (error) {

    console.error(
      '[Kick Audit Log]',
      error.message
    );

    return null;
  }
}

/*
================================================
GET BAN EXECUTOR
================================================
*/

async function getBanExecutor(guild, userId) {
  try {

    // نستنى الـ Audit Log يتسجل
    await new Promise(resolve => setTimeout(resolve, 2500));

    const logs = await guild.fetchAuditLogs({
      type: AuditLogEvent.MemberBanAdd,
      limit: 20
    });

    const entry = logs.entries.find(log =>
      log.target?.id === userId &&
      Date.now() - log.createdTimestamp < 30000
    );

    if (!entry) {
      console.log(`⚠️ لم يتم العثور على Audit Log للـ Ban: ${userId}`);
      return null;
    }

    console.log(
      `⛔ Ban Audit Found: ${userId} بواسطة ${entry.executor?.tag}`
    );

    return entry.executor || null;

  } catch (error) {

    console.error(
      '[Ban Audit Log Error]',
      error
    );

    return null;
  }
}

/*
================================================
MANUAL KICK DETECTOR

أحدث حالة فقط
مش كل الحالات القديمة
================================================
*/

client.on(
  Events.GuildMemberRemove,
  async member => {

    try {

      const protectedGuild =
        await getProtectedGuild();

      if (
        !protectedGuild ||
        member.guild.id !== protectedGuild.id
      ) {
        return;
      }

      const userId = member.id;

      /*
      لو البوت هو اللي عمل Kick
      */

      if (
        isBotAction(
          'kick',
          userId
        )
      ) {
        return;
      }

      const executor =
        await getKickExecutor(
          member.guild,
          userId
        );

      /*
      Leave عادي
      */

      if (!executor) {
        return;
      }

      /*
      نجيب أحدث حالة فقط
      ولازم فيها Kick
      ومش حالة Ban
      */

      const message =
        await getLatestCaseMessage(
          userId,
          msg =>
            hasButton(
              msg,
              `security:kick:${userId}`
            ) &&
            !hasButton(
              msg,
              `security:unban:${userId}`
            )
        );

      if (!message) {
        return;
      }

      const newEmbed =
        EmbedBuilder.from(
          message.embeds[0]
        );

      newEmbed
        .setColor(0xFF9800)
        .setTitle(
          '🚫 SECURITY ACTION — MANUAL KICK'
        )
        .setDescription(
          `**تم طرد العضو يدويًا بواسطة الإدارة.**\n\n` +
          `👤 العضو: <@${userId}>\n` +
          `🛡️ بواسطة: ${executor}`
        )
        .setTimestamp();

      addFooter(newEmbed);

      await message.edit({
        embeds: [newEmbed],
        components: [
          afterKickButtons(userId)
        ]
      }).catch(() => {});

      console.log(
        `🚫 Manual Kick detected: ${userId} بواسطة ${executor.tag}`
      );

    } catch (error) {
      console.error(
        '[Manual Kick Detector]',
        error
      );
    }
  }
);

/*
================================================
MANUAL BAN DETECTOR

أحدث حالة فقط
================================================
*/

/*
================================================
MANUAL BAN DETECTOR
================================================
*/

client.on(Events.GuildBanAdd, async ban => {

  console.log('🔥 BAN EVENT FIRED!');
  console.log('User:', ban.user.id);
  console.log('Guild:', ban.guild.id);

  try {

    const protectedGuild = await getProtectedGuild();

    if (
      !protectedGuild ||
      ban.guild.id !== protectedGuild.id
    ) {
      return;
    }

    const userId = ban.user.id;

    console.log(
      `⛔ GuildBanAdd detected for: ${userId}`
    );

    /*
    لو البوت هو اللي عمل البان
    */
    if (isBotAction('ban', userId)) {

      console.log(
        `🤖 Bot Ban ignored: ${userId}`
      );

      return;
    }

    /*
    نجيب الأدمن من Audit Log
    */
    const executor =
      await getBanExecutor(
        ban.guild,
        userId
      );

    console.log(
      `🔍 Ban executor: ${
        executor?.tag || 'Unknown / Manual'
      }`
    );

    const logChannel =
      await getLogChannel();

    if (!logChannel?.isTextBased()) {
      console.log(
        '❌ Log channel not found'
      );

      return;
    }

    const messages =
      await logChannel.messages.fetch({
        limit: 100
      }).catch(error => {

        console.error(
          '❌ Failed to fetch log messages:',
          error
        );

        return null;
      });

    if (!messages) {
      return;
    }

    /*
    نجيب حالات العضو فقط
    */

    const userCases =
      [...messages.values()]
        .filter(message => {

          if (!message.embeds.length) {
            return false;
          }

          return (
            getUserFromEmbed(
              message.embeds[0]
            ) === userId
          );

        })

        /*
        الأحدث الأول
        */
        .sort(
          (a, b) =>
            b.createdTimestamp -
            a.createdTimestamp
        );

    console.log(
      `📋 Found ${userCases.length} cases for ${userId}`
    );

    /*
    لو مفيش حالات
    */
    if (!userCases.length) {
      return;
    }

    /*
    نعدل أحدث حالة فقط
    */
    const message =
      userCases[0];

    /*
    لو الحالة بالفعل Ban
    متعدلهاش
    */

    if (
      hasButton(
        message,
        `security:unban:${userId}`
      )
    ) {

      console.log(
        '⚠️ Latest case already banned'
      );

      return;
    }

    const newEmbed =
      EmbedBuilder.from(
        message.embeds[0]
      );

    newEmbed

      .setColor(0xE53935)

      .setTitle(
        '⛔ SECURITY ACTION — MANUAL BAN'
      )

      .setDescription(
        `**تم حظر العضو يدويًا بواسطة الإدارة.**\n\n` +

        `👤 العضو: <@${userId}>\n` +

        (
          executor
            ? `🛡️ بواسطة: ${executor}`
            : '🛡️ بواسطة: الإدارة'
        )
      )

      .setTimestamp();

    addFooter(newEmbed);

    await message.edit({

      embeds: [newEmbed],

      components: [
        afterBanButtons(userId)
      ]

    });

    console.log(
      `✅ Manual Ban embed updated for ${userId}`
    );

  } catch (error) {

    console.error(
      '[Manual Ban Detector Error]',
      error
    );

  }

});

/*
================================================
ERRORS
================================================
*/

client.on(
  Events.Error,
  error =>
    console.error(
      '[Discord]',
      error
    )
);

process.on(
  'unhandledRejection',
  error =>
    console.error(
      '[Unhandled]',
      error
    )
);

process.on(
  'uncaughtException',
  error =>
    console.error(
      '[Uncaught Exception]',
      error
    )
);

/*
================================================
LOGIN
================================================
*/

client.login(CONFIG.token);