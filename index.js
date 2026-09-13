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
  Events
} = require('discord.js');

const CONFIG = {
  token: process.env.TOKEN?.trim(),
  protectedChannelId: process.env.PROTECTED_CHANNEL_ID?.trim(),
  logGuildId: process.env.LOG_GUILD_ID?.trim(),
  logChannelId: process.env.LOG_CHANNEL_ID?.trim(),
  securityRoleId: process.env.SECURITY_ROLE_ID?.trim(),
  adminLogUserId: process.env.ADMIN_LOG_USER_ID?.trim(),
  timeoutMinutes: Math.max(1, Number(process.env.TIMEOUT_MINUTES || 60)),
  maxDeleteMessages: Math.max(1, Math.min(100, Number(process.env.MAX_DELETE_MESSAGES || 50))),
  reason: process.env.TIMEOUT_REASON || 'إرسال رسالة داخل روم الحماية',
  footerIcon: process.env.FOOTER_ICON_URL?.trim() || ''
};

if (!CONFIG.token || !CONFIG.protectedChannelId || !CONFIG.logGuildId || !CONFIG.logChannelId || !CONFIG.securityRoleId || !CONFIG.adminLogUserId) {
  console.error('❌ تأكد من TOKEN و PROTECTED_CHANNEL_ID و LOG_GUILD_ID و LOG_CHANNEL_ID و SECURITY_ROLE_ID و ADMIN_LOG_USER_ID في .env');
  process.exit(1);
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ],
  partials: [Partials.Channel, Partials.Message]
});

const cut = (value, max = 1024) => {
  const text = String(value ?? '').trim() || 'بدون محتوى نصي';
  return text.length > max ? `${text.slice(0, max - 3)}...` : text;
};

const durationText = minutes => {
  if (minutes < 60) return `${minutes} دقيقة`;
  if (minutes % 60 === 0) return `${minutes / 60} ساعة`;
  return `${Math.floor(minutes / 60)} ساعة و ${minutes % 60} دقيقة`;
};

function addFooter(embed) {
  const footer = { text: 'Elsisy Security System' };
  if (CONFIG.footerIcon) footer.iconURL = CONFIG.footerIcon;
  return embed.setFooter(footer);
}

function attachmentIsImage(a) {
  return /^image\\//i.test(a.contentType || '') || /\\.(png|jpe?g|gif|webp|avif)$/i.test(a.name || '');
}

function attachmentList(message) {
  return [...message.attachments.values()].map(a => ({
    name: a.name || 'Attachment',
    url: a.url,
    contentType: a.contentType || ''
  }));
}

async function getGuild(id) {
  return client.guilds.fetch(id).catch(() => null);
}

async function getLogChannel() {
  const guild = await getGuild(CONFIG.logGuildId);
  if (!guild) return null;
  return guild.channels.fetch(CONFIG.logChannelId).catch(() => null);
}

function canUseSecurityCommand(interaction) {
  if (!interaction.inGuild()) return false;
  return interaction.member?.roles?.cache?.has(CONFIG.securityRoleId) ||
    interaction.memberPermissions?.has(PermissionsBitField.Flags.Administrator);
}

async function registerCommands() {
  const command = new SlashCommandBuilder()
    .setName('security')
    .setDescription('إرسال رسالة تفعيل نظام الحماية في الروم المحدد');

  const rest = new REST({ version: '10' }).setToken(CONFIG.token);
  await rest.put(
    Routes.applicationCommands(client.user.id),
    { body: [command.toJSON()] }
  );
  console.log('✅ /security registered');
}

async function sendSecurityPanel(channel) {
  const embed = new EmbedBuilder()
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
      'في حال كنت تعتقد أن الإجراء تم بالخطأ، يرجى التواصل مع الإدارة بعد تأمين حسابك.'
    )
    .setTimestamp();

  addFooter(embed);
  if (CONFIG.footerIcon) embed.setThumbnail(CONFIG.footerIcon);

  return channel.send({ content: '@everyone', embeds: [embed], allowedMentions: { parse: ['everyone'] } });
}

async function doTimeout(member) {
  if (!member?.moderatable) {
    return {
      ok: false,
      error: 'البوت لا يستطيع عمل Timeout لهذا العضو لأن رتبته أعلى/مساوية للبوت أو لأنه Server Owner.'
    };
  }

  try {
    await member.timeout(CONFIG.timeoutMinutes * 60 * 1000, CONFIG.reason);
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error?.message || 'فشل تنفيذ Timeout' };
  }
}

function actionButtons(userId) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`security:revoke:${userId}`).setLabel('Revoke').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`security:kick:${userId}`).setLabel('Kick').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`security:ban:${userId}`).setLabel('BAN').setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId(`security:history:${userId}`).setLabel('History').setStyle(ButtonStyle.Primary)
  );
}

async function sendSecurityLog(data, timeoutResult, targetMember) {
  const channel = await getLogChannel();
  if (!channel?.isTextBased()) return;

  const higherRole = !timeoutResult.ok;
  const embed = new EmbedBuilder()
    .setColor(higherRole ? 0xFF9800 : 0xE53935)
    .setTitle(higherRole ? '⚠️ SECURITY ALERT — HIGHER ROLE' : '🛡️ SECURITY ALERT')
    .setDescription(
      higherRole
        ? '**تم اكتشاف رسالة، لكن البوت لم يستطع عمل Timeout لأن العضو أعلى/مساوي للبوت. تم حذف الرسالة ومحاولة تنظيف رسائله.**'
        : '**تم اكتشاف رسالة في روم الحماية واتخاذ إجراء تلقائي وتم حذف الرسالة المخالفة فقط.**'
    )
    .addFields(
      {
        name: '👤 العضو',
        value: `${data.author}\n${data.author.tag || data.author.username}\nID: \`${data.author.id}\``
      },
      {
        name: '📍 الروم',
        value: `${data.channel}\n\`${data.channel.id}\``
      },
      {
        name: '⏱️ Timeout',
        value: timeoutResult.ok
          ? `✅ تم عمل Timeout لمدة **${durationText(CONFIG.timeoutMinutes)}**`
          : `❌ لم يتم عمل Timeout\n${cut(timeoutResult.error)}`
      },
      {
        name: '🗑️ الرسالة المخالفة',
        value: data.currentDeleted ? '✅ تم حذف الرسالة داخل روم الحماية' : '❌ تعذر حذف الرسالة'
      },
      {
        name: '📝 السبب',
        value: cut(CONFIG.reason)
      },
      {
        name: '💬 الرسالة',
        value: cut(data.content)
      }
    )
    .setThumbnail(data.author.displayAvatarURL({ size: 256 }))
    .setTimestamp();

  addFooter(embed);

  // لو رتبة العضو أعلى/مساوية للبوت، متحطش أزرار الإجراءات في اللوج.
  // History يفضل ظاهر لأنه لا ينفذ عقوبة.
  const canModerateTarget = targetMember && (targetMember.moderatable || targetMember.kickable || targetMember.bannable);
  const components = canModerateTarget
    ? [actionButtons(data.author.id)]
    : [new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`security:history:${data.author.id}`).setLabel('History').setStyle(ButtonStyle.Primary)
      )];

  await channel.send({ embeds: [embed], components }).catch(() => {});

  const images = data.attachments.filter(attachmentIsImage);
  for (let i = 0; i < images.length; i += 10) {
    const embeds = images.slice(i, i + 10).map((a, index) => {
      const e = new EmbedBuilder()
        .setColor(0xE53935)
        .setTitle(`🖼️ صورة ${i + index + 1}`)
        .setURL(a.url)
        .setImage(a.url);
      addFooter(e);
      return e;
    });
    await channel.send({ embeds }).catch(() => {});
  }

  const other = data.attachments.filter(a => !attachmentIsImage(a));
  if (other.length) {
    const e = new EmbedBuilder()
      .setColor(0xE53935)
      .setTitle('📎 المرفقات')
      .setDescription(other.slice(0, 20).map(a => `• [${a.name}](${a.url})`).join('\n'));
    addFooter(e);
    await channel.send({ embeds: [e] }).catch(() => {});
  }

}

async function sendActionLogToAdmin(interaction, action, targetMember, success, errorText = '') {
  const admin = await client.users.fetch(CONFIG.adminLogUserId).catch(() => null);
  if (!admin || admin.bot) return;

  const actionName = action.toUpperCase();
  const target = targetMember?.user || `<@${interaction.customId.split(':')[2]}>`;
  const embed = new EmbedBuilder()
    .setColor(success ? 0x2E7D32 : 0xE53935)
    .setTitle(`🛡️ SECURITY LOG — ${actionName}`)
    .addFields(
      { name: '👤 العضو', value: `${target}\nID: \`${targetMember?.id || interaction.customId.split(':')[2]}\`` },
      { name: '⚙️ العملية', value: actionName },
      { name: '🛡️ بواسطة', value: `${interaction.user}\nID: \`${interaction.user.id}\`` },
      { name: '📌 النتيجة', value: success ? '✅ تمت العملية' : `❌ فشلت العملية\n${cut(errorText)}` }
    )
    .setTimestamp();
  addFooter(embed);

  await admin.send({ embeds: [embed] }).catch(() => {});
}

async function performAction(interaction, action, targetId) {
  // الأزرار يتم الضغط عليها من سيرفر اللوجات، لذلك نجيب سيرفر الحماية الحقيقي
  // من روم الحماية وليس من interaction.guild.
  const protectedChannel = await client.channels.fetch(CONFIG.protectedChannelId).catch(() => null);
  const sourceGuild = protectedChannel?.guild || null;
  if (!sourceGuild) throw new Error('تعذر العثور على سيرفر الحماية. تأكد من PROTECTED_CHANNEL_ID.');

  const member = await sourceGuild.members.fetch(targetId).catch(() => null);
  if (!member) throw new Error('العضو غير موجود في سيرفر الحماية.');

  if (action === 'revoke') {
    if (!member.communicationDisabledUntilTimestamp || member.communicationDisabledUntilTimestamp <= Date.now()) {
      return { member, success: true, note: 'العضو ليس عليه Timeout حاليًا.' };
    }
    if (!member.moderatable) throw new Error('البوت لا يستطيع فك Timeout لهذا العضو بسبب الرتبة أو كونه Server Owner.');
    await member.timeout(null, `Security Revoke بواسطة ${interaction.user.tag}`);
    return { member, success: true };
  }

  if (action === 'kick') {
    if (!member.kickable) throw new Error('البوت لا يستطيع طرد هذا العضو بسبب الرتبة أو كونه Server Owner.');
    await member.kick(`Security Kick بواسطة ${interaction.user.tag}`);
    return { member, success: true };
  }

  if (action === 'ban') {
    if (!member.bannable) throw new Error('البوت لا يستطيع حظر هذا العضو بسبب الرتبة أو كونه Server Owner.');
    await member.ban({ reason: `Security BAN بواسطة ${interaction.user.tag}`, deleteMessageSeconds: 0 });
    return { member, success: true };
  }

  throw new Error('عملية غير معروفة.');
}

client.once(Events.ClientReady, async () => {
  console.log(`✅ ${client.user.tag} شغال`);
  console.log(`🛡️ Protected: ${CONFIG.protectedChannelId}`);
  console.log(`📋 Logs: ${CONFIG.logGuildId}/${CONFIG.logChannelId}`);
  console.log(`🔐 Security role: ${CONFIG.securityRoleId}`);
  console.log(`📩 Admin DM log user: ${CONFIG.adminLogUserId}`);

  try {
    await registerCommands();
  } catch (error) {
    console.error('❌ Failed to register /security:', error.message);
  }
});

client.on(Events.InteractionCreate, async interaction => {
  if (interaction.isChatInputCommand() && interaction.commandName === 'security') {
    if (!canUseSecurityCommand(interaction)) {
      return interaction.reply({ content: '❌ معندكش صلاحية تستخدم الأمر ده.', ephemeral: true });
    }

    if (interaction.channelId !== CONFIG.protectedChannelId) {
      return interaction.reply({ content: '❌ الأمر ده لازم يتستخدم داخل روم الحماية.', ephemeral: true });
    }

    await interaction.deferReply({ ephemeral: true });
    await sendSecurityPanel(interaction.channel);
    return interaction.editReply('✅ تم إرسال Embed الحماية.');
  }

  if (!interaction.isButton()) return;
  if (!interaction.customId.startsWith('security:')) return;

  if (!canUseSecurityCommand(interaction)) {
    return interaction.reply({ content: '❌ معندكش صلاحية تستخدم أزرار الحماية.', ephemeral: true });
  }

  const [, action, targetId] = interaction.customId.split(':');

  if (action === 'history') {
    const logChannel = await getLogChannel();
    const messages = logChannel ? await logChannel.messages.fetch({ limit: 100 }).catch(() => null) : null;
    const history = messages ? [...messages.values()].filter(m => m.embeds.some(e => e.fields?.some(f => f.name === '👤 العضو' && f.value.includes(`ID: \`${targetId}\``)))).slice(0, 10) : [];
    const embed = new EmbedBuilder().setColor(0x5865F2).setTitle('📜 SECURITY HISTORY').setDescription(
      history.length ? history.map((m, i) => `**${i + 1}.** <t:${Math.floor(m.createdTimestamp / 1000)}:F> — [فتح الحالة](${m.url})`).join('\n') : 'لا يوجد سجل حالات ظاهر لهذا العضو ضمن آخر 100 رسالة لوج.'
    ).setTimestamp();
    addFooter(embed);
    return interaction.reply({ embeds: [embed], ephemeral: true });
  }

  const names = { revoke: 'فك الـ Timeout', kick: 'Kick', ban: 'BAN' };
  if (!names[action] || !targetId) return;

  const confirmRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`security-confirm:${action}:${targetId}:${interaction.message.id}`).setLabel('تأكيد').setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId(`security-cancel:${action}:${targetId}:${interaction.message.id}`).setLabel('إلغاء').setStyle(ButtonStyle.Secondary)
  );

  const confirmEmbed = new EmbedBuilder()
    .setColor(0xFF9800)
    .setTitle('⚠️ تأكيد العملية')
    .setDescription(`هل أنت متأكد من تنفيذ **${names[action]}** على <@${targetId}>؟\n\n**العملية:** ${action.toUpperCase()}\n**العضو:** <@${targetId}>`)
    .setTimestamp();
  addFooter(confirmEmbed);

  await interaction.reply({ embeds: [confirmEmbed], components: [confirmRow], ephemeral: true });
});

client.on(Events.InteractionCreate, async interaction => {
  if (!interaction.isButton()) return;
  if (!interaction.customId.startsWith('security-confirm:') && !interaction.customId.startsWith('security-cancel:')) return;

  if (!canUseSecurityCommand(interaction)) {
    return interaction.reply({ content: '❌ معندكش صلاحية تستخدم أزرار الحماية.', ephemeral: true });
  }

  const [prefix, action, targetId, sourceMessageId] = interaction.customId.split(':');

  if (prefix === 'security-cancel') {
    return interaction.update({
      embeds: [new EmbedBuilder().setColor(0x757575).setTitle('↩️ تم إلغاء العملية').setDescription('لم يتم تنفيذ أي إجراء.').setTimestamp()],
      components: []
    });
  }

  await interaction.deferUpdate();

  let result;
  try {
    result = await performAction(interaction, action, targetId);
    await sendActionLogToAdmin(interaction, action, result.member, result.success, result.note || '');
  } catch (error) {
    const protectedChannel = await client.channels.fetch(CONFIG.protectedChannelId).catch(() => null);
    const protectedGuild = protectedChannel?.guild || null;
    const member = await protectedGuild?.members.fetch(targetId).catch(() => null);
    await sendActionLogToAdmin(interaction, action, member, false, error.message);
    result = { member, success: false, error: error.message };
  }

  const names = { revoke: 'فك الـ Timeout', kick: 'Kick', ban: 'BAN' };
  const resultEmbed = new EmbedBuilder()
    .setColor(result.success ? 0x2E7D32 : 0xE53935)
    .setTitle(result.success ? '✅ تم تنفيذ العملية' : '❌ فشل تنفيذ العملية')
    .setDescription(
      `**العملية:** ${names[action] || action}\n` +
      `**العضو:** <@${targetId}>\n\n` +
      (result.success ? 'تم إرسال سجل العملية إلى Admin User في الخاص.' : `**الخطأ:** ${cut(result.error)}`)
    )
    .setTimestamp();
  addFooter(resultEmbed);

  if (sourceMessageId) {
    const logChannel = await getLogChannel();
    const sourceMessage = logChannel ? await logChannel.messages.fetch(sourceMessageId).catch(() => null) : null;
    if (sourceMessage) {
      const original = EmbedBuilder.from(sourceMessage.embeds[0]);
      original.setColor(result.success ? 0x2E7D32 : 0xE53935)
        .setTitle(result.success ? '✅ SECURITY ACTION COMPLETED' : '❌ SECURITY ACTION FAILED')
        .setDescription(`**الإجراء:** ${names[action] || action}\n**العضو:** <@${targetId}>\n**بواسطة:** ${interaction.user}\n**النتيجة:** ${result.success ? 'تم التنفيذ بنجاح' : `فشل التنفيذ: ${cut(result.error)}`}`)
        .setTimestamp();
      addFooter(original);
      await sourceMessage.edit({ embeds: [original], components: [] }).catch(() => {});
    }
  }

  await interaction.editReply({ embeds: [resultEmbed], components: [] });
});

client.on(Events.MessageCreate, async message => {
  if (!message.guild || message.author.bot) return;
  if (message.channelId !== CONFIG.protectedChannelId) return;

  const data = {
    author: message.author,
    channel: message.channel,
    content: message.content,
    attachments: attachmentList(message),
    currentDeleted: false
  };

  const timeoutResult = await doTimeout(message.member);

  // Delete only the triggering message in the protected channel.
  try {
    await message.delete();
    data.currentDeleted = true;
  } catch {}

  await sendSecurityLog(data, timeoutResult, message.member);
});

client.on(Events.Error, error => console.error('[Discord]', error));
process.on('unhandledRejection', error => console.error('[Unhandled]', error));

client.login(CONFIG.token);
