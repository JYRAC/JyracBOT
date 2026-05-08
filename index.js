const {
    Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder, EmbedBuilder,
    ActionRowBuilder, ButtonBuilder, ButtonStyle, ChannelType, PermissionsBitField,
    StringSelectMenuBuilder, ActivityType, MessageFlags, ModalBuilder, TextInputBuilder, TextInputStyle
} = require('discord.js');
const express = require('express');
const admin = require('firebase-admin');

// --- Firebase 初期化 ---
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
const db = admin.firestore();

const broadcastRoleMap = new Map();
const ticketMessages = new Map();

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds, 
        GatewayIntentBits.GuildMembers, 
        GatewayIntentBits.GuildMessages, 
        GatewayIntentBits.MessageContent, 
        GatewayIntentBits.DirectMessages
    ]
});

// --- 共通関数: ログ送信 ---
async function sendLog(guild, embed) {
    if (!guild) return;
    try {
        const logDoc = await db.collection('log_settings').doc(guild.id).get();
        if (!logDoc.exists) return;

        const channelId = logDoc.data().channelId;
        const logChannel = await guild.channels.fetch(channelId).catch(() => null);
        
        if (logChannel && logChannel.guild.id === guild.id) {
            await logChannel.send({ embeds: [embed] });
        }
    } catch (e) {
        console.error(`[Log Error] Guild: ${guild.id}`, e);
    }
}

const activities = [
    "JYRAC公式Instはこちら！▶https://www.instagram.com/jyrac_official/",
    "NSF公式Instはこちら！▶https://www.instagram.com/2024nsfproject/",
    "ボットに関するお問い合わせはDiscordID’pitayakun7’まで",
    "広告募集中"
];

// --- コマンド定義 ---
const commands = [
    new SlashCommandBuilder().setName('verify').setDescription('認証パネルを作成')
        .addRoleOption(o => o.setName('role').setDescription('付与するロール').setRequired(true))
        .addStringOption(o => o.setName('title').setDescription('パネルタイトル'))
        .addStringOption(o => o.setName('description').setDescription('説明文'))
        .setDefaultMemberPermissions(PermissionsBitField.Flags.ManageRoles),
    new SlashCommandBuilder().setName('ticket').setDescription('チケットパネルを作成')
        .addRoleOption(o => o.setName('admin-role').setDescription('対応管理ロール').setRequired(true))
        .addStringOption(o => o.setName('title').setDescription('タイトル'))
        .addStringOption(o => o.setName('description').setDescription('説明文'))
        .addStringOption(o => o.setName('panel-desc').setDescription('チケット作成時メッセージ'))
        .setDefaultMemberPermissions(PermissionsBitField.Flags.ManageChannels),
    new SlashCommandBuilder().setName('role-confirmation').setDescription('指定ユーザーのロールを確認')
        .addUserOption(o => o.setName('target').setDescription('確認対象').setRequired(true))
        .setDefaultMemberPermissions(PermissionsBitField.Flags.ModerateMembers),
    new SlashCommandBuilder().setName('delete').setDescription('メッセージを一括削除')
        .addIntegerOption(o => o.setName('amount').setDescription('件数(1-100)').setRequired(true))
        .setDefaultMemberPermissions(PermissionsBitField.Flags.ManageMessages),
    new SlashCommandBuilder().setName('help').setDescription('コマンド一覧と詳細を表示'),
    new SlashCommandBuilder().setName('give-role').setDescription('ロールを付与')
        .addUserOption(o => o.setName('target').setDescription('対象').setRequired(true))
        .addRoleOption(o => o.setName('role').setDescription('ロール').setRequired(true))
        .setDefaultMemberPermissions(PermissionsBitField.Flags.ManageRoles),
    new SlashCommandBuilder().setName('remove-role').setDescription('ロールを剥奪')
        .addUserOption(o => o.setName('target').setDescription('対象').setRequired(true))
        .addRoleOption(o => o.setName('role').setDescription('ロール').setRequired(true))
        .setDefaultMemberPermissions(PermissionsBitField.Flags.ManageRoles),
    new SlashCommandBuilder().setName('receive-notifications').setDescription('重要なお知らせの通知登録を行う'),
    new SlashCommandBuilder().setName('notice').setDescription('お知らせを送信(管理者専用)')
        .addStringOption(o => o.setName('password').setDescription('認証パスワード').setRequired(true))
        .setDefaultMemberPermissions(PermissionsBitField.Flags.ManageRoles),
    new SlashCommandBuilder().setName('broadcast').setDescription('一斉送信(管理者専用)')
        .addRoleOption(o => o.setName('target-role').setDescription('送信対象ロール').setRequired(true))
        .addStringOption(o => o.setName('password').setDescription('認証パスワード').setRequired(true))
        .setDefaultMemberPermissions(PermissionsBitField.Flags.ManageRoles),
    new SlashCommandBuilder().setName('request').setDescription('新規コマンドの作成依頼を送る'),
    new SlashCommandBuilder().setName('log').setDescription('ログの送信先チャンネルを設定する')
        .addChannelOption(o => o.setName('channel').setDescription('ログチャンネル').setRequired(true))
        .setDefaultMemberPermissions(PermissionsBitField.Flags.Administrator)
].map(c => c.toJSON());

// --- Bot Ready ---
client.once('ready', async () => {
    const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
    try {
        await rest.put(Routes.applicationCommands(client.user.id), { body: commands });
        console.log('Commands registered.');
    } catch (error) { console.error(error); }
    setInterval(() => {
        client.user.setActivity(activities[Math.floor(Math.random() * activities.length)], { type: ActivityType.Custom });
    }, 15000);
});

// --- Express (Keep Alive) ---
const app = express();
app.get('/', (req, res) => res.send('Bot is Active!'));
app.listen(3000);

// --- インタラクション処理 ---
client.on('interactionCreate', async interaction => {
    const safeReply = async (data) => { if (!interaction.replied && !interaction.deferred) return await interaction.reply(data); };

    // スラッシュコマンド
    if (interaction.isChatInputCommand()) {
        const { commandName, options } = interaction;

        if (commandName === 'log') {
            const channel = options.getChannel('channel');
            await db.collection('log_settings').doc(interaction.guild.id).set({ channelId: channel.id });
            return await interaction.reply({ content: `✅ ログ送信先を ${channel} に設定しました。`, flags: MessageFlags.Ephemeral });
        }

        if (commandName === 'request') {
            const modal = new ModalBuilder().setCustomId('request_modal').setTitle('新規コマンド作成依頼');
            modal.addComponents(
                new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('req_name').setLabel('記入者名').setStyle(TextInputStyle.Short).setRequired(true)),
                new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('req_cmd').setLabel('新規コマンド名').setStyle(TextInputStyle.Short).setRequired(true)),
                new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('req_desc').setLabel('コマンドの説明').setStyle(TextInputStyle.Paragraph).setRequired(true))
            );
            return await interaction.showModal(modal);
        }

        if (commandName === 'help') {
            const embed = new EmbedBuilder().setTitle('📜 コマンド一覧').setDescription('詳細を確認したいコマンドを選択してください。').setColor(0x00AE86);
            const select = new StringSelectMenuBuilder().setCustomId('help_select').setPlaceholder('選択してください').addOptions([
                { label: '/verify', value: 'help_verify' }, { label: '/ticket', value: 'help_ticket' },
                { label: '/role-confirmation', value: 'help_role' }, { label: '/delete', value: 'help_delete' },
                { label: '/give-role', value: 'help_giverole' }, { label: '/remove-role', value: 'help_removerole' },
                { label: '/notice', value: 'help_notice' }, { label: '/receive-notifications', value: 'help_notify' },
                { label: '/request', value: 'help_request' }, { label: '/log', value: 'help_log' }
            ]);
            return await safeReply({ embeds: [embed], components: [new ActionRowBuilder().addComponents(select)], flags: MessageFlags.Ephemeral });
        }

        if (commandName === 'notice') {
            if (options.getString('password') !== process.env.ADMIN_PASSWORD) return await interaction.reply({ content: 'パスワード不一致', flags: MessageFlags.Ephemeral });
            const modal = new ModalBuilder().setCustomId('notice_modal').setTitle('お知らせ入力');
            modal.addComponents(
                new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('sender').setLabel('発信者').setStyle(TextInputStyle.Short).setRequired(true)),
                new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('title').setLabel('タイトル').setStyle(TextInputStyle.Short).setRequired(true)),
                new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('content').setLabel('内容').setStyle(TextInputStyle.Paragraph).setRequired(true)),
                new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('url').setLabel('URL(任意)').setStyle(TextInputStyle.Short).setRequired(false))
            );
            return await interaction.showModal(modal);
        }

        if (commandName === 'broadcast') {
            if (options.getString('password') !== process.env.ADMIN_PASSWORD) return await interaction.reply({ content: 'パスワード不一致', flags: MessageFlags.Ephemeral });
            const role = options.getRole('target-role');
            broadcastRoleMap.set(interaction.user.id, role.id);
            const modal = new ModalBuilder().setCustomId('broadcast_modal').setTitle('一斉送信');
            modal.addComponents(
                new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('msg').setLabel('メッセージ').setStyle(TextInputStyle.Paragraph).setRequired(true)),
                new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('file_url').setLabel('URL(任意)').setStyle(TextInputStyle.Short).setRequired(false))
            );
            return await interaction.showModal(modal);
        }

        if (commandName === 'delete') {
            const amount = options.getInteger('amount');
            const row = new ActionRowBuilder().addComponents(
                new ButtonBuilder().setCustomId(`bulk_delete_yes_${amount}`).setLabel('削除').setStyle(ButtonStyle.Danger),
                new ButtonBuilder().setCustomId('bulk_delete_no').setLabel('中止').setStyle(ButtonStyle.Secondary)
            );
            return await safeReply({ content: `${amount}件削除しますか？`, components: [row], flags: MessageFlags.Ephemeral });
        }

        if (commandName === 'verify') {
            const role = options.getRole('role');
            const row = new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(`v_role_${role.id}`).setLabel('✅ 認証').setStyle(ButtonStyle.Success));
            return await safeReply({ embeds: [new EmbedBuilder().setTitle(options.getString('title') ?? '認証').setDescription(options.getString('description') ?? 'ボタンを押してロール付与').setColor(0x3498DB)], components: [row] });
        }

        if (commandName === 'ticket') {
            const adminRole = options.getRole('admin-role');
            const key = `msg_${Date.now()}`;
            ticketMessages.set(key, options.getString('panel-desc') ?? 'お問い合わせ用チケット');
            const row = new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(`tkt_${adminRole.id}_${key}`).setLabel('🎫 チケット作成').setStyle(ButtonStyle.Primary));
            return await safeReply({ embeds: [new EmbedBuilder().setTitle(options.getString('title') ?? 'サポート').setDescription(options.getString('description') ?? 'チケットを作成します').setColor(0x9B59B6)], components: [row] });
        }

        if (commandName === 'receive-notifications') {
            await interaction.deferReply({ flags: MessageFlags.Ephemeral });
            const userDoc = await db.collection('subscribers').doc(interaction.user.id).get();
            if (userDoc.exists) {
                const row = new ActionRowBuilder().addComponents(
                    new ButtonBuilder().setCustomId('notify_remove').setLabel('解除').setStyle(ButtonStyle.Danger),
                    new ButtonBuilder().setCustomId('notify_cancel').setLabel('戻る').setStyle(ButtonStyle.Secondary)
                );
                return await interaction.editReply({ content: '登録済みです。解除しますか？', components: [row] });
            } else {
                await db.collection('subscribers').doc(interaction.user.id).set({ registeredAt: new Date() });
                return await interaction.editReply('通知登録完了！');
            }
        }

        if (['give-role', 'remove-role'].includes(commandName)) {
            const member = options.getMember('target');
            const role = options.getRole('role');
            commandName === 'give-role' ? await member.roles.add(role) : await member.roles.remove(role);
            return await safeReply({ content: '実行完了', flags: MessageFlags.Ephemeral });
        }

        if (commandName === 'role-confirmation') {
            const member = await interaction.guild.members.fetch(options.getUser('target').id).catch(() => null);
            if (!member) return await safeReply({ content: '見つかりません', flags: MessageFlags.Ephemeral });
            const roles = member.roles.cache.filter(r => r.name !== '@everyone').map(r => r.name).join('\n') || 'なし';
            return await safeReply({ content: `ロール:\n\`\`\`\n${roles}\n\`\`\``, flags: MessageFlags.Ephemeral });
        }
    }

    // モーダル送信
    if (interaction.isModalSubmit()) {
        if (interaction.customId === 'request_modal') {
            await interaction.deferReply({ flags: MessageFlags.Ephemeral });
            const name = interaction.fields.getTextInputValue('req_name');
            const cmd = interaction.fields.getTextInputValue('req_cmd');
            const desc = interaction.fields.getTextInputValue('req_desc');
            const embed = new EmbedBuilder().setTitle('📩 作成依頼').addFields({ name: '依頼者', value: name }, { name: 'コマンド', value: cmd }, { name: '詳細', value: desc }).setColor(0xFFA500);
            try {
                const adminUser = await client.users.fetch(process.env.ADMIN_USER_ID);
                await adminUser.send({ embeds: [embed] });
                await interaction.editReply('送信しました。');
            } catch (e) { await interaction.editReply('送信失敗。'); }
        }

        if (interaction.customId === 'notice_modal') {
            await interaction.deferReply({ flags: MessageFlags.Ephemeral });
            const embed = new EmbedBuilder().setTitle(`📢 ${interaction.fields.getTextInputValue('title')}`).setDescription(`${interaction.fields.getTextInputValue('content')}\n\n${interaction.fields.getTextInputValue('url') ? `🔗 [詳細](${interaction.fields.getTextInputValue('url')})` : ''}`).setFooter({ text: `発信者: ${interaction.fields.getTextInputValue('sender')}` }).setColor(0x00FF00);
            const subs = await db.collection('subscribers').get();
            let count = 0;
            for (const doc of subs.docs) { try { const user = await client.users.fetch(doc.id); await user.send({ embeds: [embed] }); count++; } catch (e) { } }
            await interaction.editReply(`${count}名に送信`);
        }

        if (interaction.customId === 'broadcast_modal') {
            await interaction.deferReply({ flags: MessageFlags.Ephemeral });
            const roleId = broadcastRoleMap.get(interaction.user.id);
            broadcastRoleMap.delete(interaction.user.id);
            const msg = interaction.fields.getTextInputValue('msg');
            const url = interaction.fields.getTextInputValue('file_url');
            const finalContent = url ? `${msg}\n\n🔗 ${url}` : msg;
            const role = await interaction.guild.roles.fetch(roleId);
            const allMembers = await interaction.guild.members.fetch();
            const targetMembers = allMembers.filter(m => m.roles.cache.has(roleId));
            let sc = 0;
            for (const [id, member] of targetMembers) {
                if (member.user.bot) continue;
                try { await member.send({ content: finalContent }); sc++; await new Promise(r => setTimeout(r, 800)); } catch (e) {}
            }
            await interaction.editReply(`${sc}名に送信完了`);
        }
    }

    // ボタン・メニュー
    if (interaction.isButton() || interaction.isStringSelectMenu()) {
        const { customId } = interaction;

        if (customId === 'help_select') {
            const helpData = {
                help_verify: { t: '/verify', d: '認証パネル作成' }, help_ticket: { t: '/ticket', d: 'チケットパネル作成' },
                help_role: { t: '/role-confirmation', d: 'ロール確認' }, help_delete: { t: '/delete', d: '一括削除' },
                help_giverole: { t: '/give-role', d: 'ロール付与' }, help_removerole: { t: '/remove-role', d: 'ロール剥奪' },
                help_notice: { t: '/notice', d: 'お知らせ送信' }, help_notify: { t: '/receive-notifications', d: '通知登録' },
                help_request: { t: '/request', d: 'コマンド依頼' }, help_log: { t: '/log', d: 'ログ設定' }
            };
            const data = helpData[interaction.values[0]];
            return await interaction.update({ embeds: [new EmbedBuilder().setTitle(data.t).setDescription(data.d).setColor(0x00AE86)], components: [interaction.message.components[0]] });
        }

        if (customId.startsWith('bulk_delete_yes_')) {
            const amount = parseInt(customId.split('_')[3]);
            await interaction.channel.bulkDelete(amount, true);
            const logEmbed = new EmbedBuilder().setTitle('🗑️ 削除ログ').setDescription(`${interaction.user} が ${interaction.channel} で ${amount}件のメッセージを削除しました`).setColor(0xE74C3C).setTimestamp();
            await sendLog(interaction.guild, logEmbed);
            return await interaction.update({ content: '削除完了', embeds: [], components: [] });
        }

        if (customId.startsWith('v_role_')) {
            const rid = customId.split('_')[2];
            await interaction.member.roles.add(rid);
            const logEmbed = new EmbedBuilder().setTitle('✅ 認証ログ').setDescription(`${interaction.user} が認証し <@&${rid}> を取得しました`).setColor(0x2ECC71).setTimestamp();
            await sendLog(interaction.guild, logEmbed);
            return await safeReply({ content: 'ロール付与完了', flags: MessageFlags.Ephemeral });
        }

        if (customId.startsWith('tkt_')) {
            const [_, aid, key] = customId.split('_');
            const ch = await interaction.guild.channels.create({ name: `🎫-${interaction.user.username}`, type: ChannelType.GuildText });
            await ch.send({ content: `${interaction.user} ${ticketMessages.get(key) || '受付中'} <@&${aid}>`, components: [new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('t_close_c').setLabel('閉じる').setStyle(ButtonStyle.Danger))] });
            const logEmbed = new EmbedBuilder().setTitle('🎫 チケット作成').setDescription(`${interaction.user} がチケット ${ch} を作成しました`).setColor(0x3498DB).setTimestamp();
            await sendLog(interaction.guild, logEmbed);
            return await safeReply({ content: `作成完了: ${ch}`, flags: MessageFlags.Ephemeral });
        }

        if (customId === 't_close_c') {
            const row = new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('t_yes').setLabel('削除').setStyle(ButtonStyle.Danger), new ButtonBuilder().setCustomId('t_no').setLabel('中止').setStyle(ButtonStyle.Secondary));
            return await interaction.reply({ content: 'チケットを削除しますか？', components: [row], flags: MessageFlags.Ephemeral });
        }

        if (customId === 't_yes') {
            const logEmbed = new EmbedBuilder().setTitle('🗑️ チケット閉鎖').setDescription(`${interaction.user} がチケット \`${interaction.channel.name}\` を削除しました`).setColor(0xE74C3C).setTimestamp();
            await sendLog(interaction.guild, logEmbed);
            await interaction.channel.delete();
        }

        if (customId === 'bulk_delete_no' || customId === 'notify_cancel' || customId === 't_no') {
            return await interaction.update({ content: 'キャンセルしました', embeds: [], components: [] });
        }

        if (customId === 'notify_remove') {
            await db.collection('subscribers').doc(interaction.user.id).delete();
            return await interaction.update({ content: '通知解除完了', components: [] });
        }
    }
});

client.login(process.env.DISCORD_TOKEN);
