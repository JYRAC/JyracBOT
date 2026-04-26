const {
    Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder, EmbedBuilder,
    ActionRowBuilder, ButtonBuilder, ButtonStyle, ChannelType, PermissionsBitField,
    StringSelectMenuBuilder, ActivityType, MessageFlags, ModalBuilder, TextInputBuilder, TextInputStyle
} = require('discord.js');
const express = require('express');
const admin = require('firebase-admin');

// --- 初期設定 ---
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
const db = admin.firestore();

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMembers,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.DirectMessages,
        GatewayIntentBits.VoiceStates // VCログに必須
    ]
});

const ticketMessages = new Map();
const activities = [
    "JYRAC公式Instはこちら！▶https://www.instagram.com/jyrac_official/",
    "NSF公式Instはこちら！▶https://www.instagram.com/2024nsfproject/",
    "ボットに関するお問い合わせはDisID’pitayakun7’まで"
];

// --- コマンド登録用データ ---
const commands = [
    new SlashCommandBuilder().setName('verify').setDescription('認証パネルを作成').addRoleOption(o => o.setName('role').setDescription('付与するロール').setRequired(true)).addStringOption(o => o.setName('title').setDescription('パネルタイトル')).addStringOption(o => o.setName('description').setDescription('説明文')).setDefaultMemberPermissions(PermissionsBitField.Flags.ManageRoles),
    new SlashCommandBuilder().setName('ticket').setDescription('チケットパネルを作成').addRoleOption(o => o.setName('admin-role').setDescription('対応管理ロール').setRequired(true)).addStringOption(o => o.setName('title').setDescription('タイトル')).addStringOption(o => o.setName('description').setDescription('説明文')).addStringOption(o => o.setName('panel-desc').setDescription('チケット作成時メッセージ')).setDefaultMemberPermissions(PermissionsBitField.Flags.ManageChannels),
    new SlashCommandBuilder().setName('role-confirmation').setDescription('指定ユーザーのロールを確認').addUserOption(o => o.setName('target').setDescription('確認対象').setRequired(true)).setDefaultMemberPermissions(PermissionsBitField.Flags.ModerateMembers),
    new SlashCommandBuilder().setName('delete').setDescription('メッセージを一括削除').addIntegerOption(o => o.setName('amount').setDescription('件数(1-100)').setRequired(true)).setDefaultMemberPermissions(PermissionsBitField.Flags.ManageMessages),
    new SlashCommandBuilder().setName('help').setDescription('コマンド一覧と詳細を表示'),
    new SlashCommandBuilder().setName('give-role').setDescription('複数のユーザーにロールを付与').addRoleOption(o => o.setName('role').setDescription('付与するロール').setRequired(true)).addUserOption(o => o.setName('target1').setDescription('対象1').setRequired(true)).addUserOption(o => o.setName('target2').setDescription('対象2')).addUserOption(o => o.setName('target3').setDescription('対象3')).addUserOption(o => o.setName('target4').setDescription('対象4')).addUserOption(o => o.setName('target5').setDescription('対象5')).setDefaultMemberPermissions(PermissionsBitField.Flags.ManageRoles),
    new SlashCommandBuilder().setName('remove-role').setDescription('複数のユーザーからロールを剥奪').addRoleOption(o => o.setName('role').setDescription('剥奪するロール').setRequired(true)).addUserOption(o => o.setName('target1').setDescription('対象1').setRequired(true)).addUserOption(o => o.setName('target2').setDescription('対象2')).addUserOption(o => o.setName('target3').setDescription('対象3')).addUserOption(o => o.setName('target4').setDescription('対象4')).addUserOption(o => o.setName('target5').setDescription('対象5')).setDefaultMemberPermissions(PermissionsBitField.Flags.ManageRoles),
    new SlashCommandBuilder().setName('receive-notifications').setDescription('重要なお知らせの通知登録を行う'),
    new SlashCommandBuilder().setName('notice').setDescription('お知らせを送信(管理者専用)').addStringOption(o => o.setName('password').setDescription('認証パスワード').setRequired(true)).setDefaultMemberPermissions(PermissionsBitField.Flags.ManageRoles),
    new SlashCommandBuilder().setName('set-vc-log').setDescription('VCログ対象と送信先を設定').addChannelOption(o => o.setName('vc').setDescription('監視するVC').addChannelTypes(ChannelType.GuildVoice).setRequired(true)).addChannelOption(o => o.setName('log').setDescription('ログ送信先').addChannelTypes(ChannelType.GuildText).setRequired(true)).setDefaultMemberPermissions(PermissionsBitField.Flags.ManageChannels),
    new SlashCommandBuilder().setName('unset-vc-log').setDescription('VCログ設定を解除').addChannelOption(o => o.setName('vc').setDescription('解除するVC').addChannelTypes(ChannelType.GuildVoice).setRequired(true)).setDefaultMemberPermissions(PermissionsBitField.Flags.ManageChannels),
    new SlashCommandBuilder().setName('set-text-log').setDescription('テキストログ対象を設定').addChannelOption(o => o.setName('channel').setDescription('監視対象').addChannelTypes(ChannelType.GuildText).setRequired(true)).setDefaultMemberPermissions(PermissionsBitField.Flags.ManageChannels),
    new SlashCommandBuilder().setName('unset-text-log').setDescription('テキストログ設定を解除').addChannelOption(o => o.setName('channel').setDescription('解除対象').addChannelTypes(ChannelType.GuildText).setRequired(true)).setDefaultMemberPermissions(PermissionsBitField.Flags.ManageChannels)
].map(c => c.toJSON());

// --- 起動処理 ---
client.once('ready', async () => {
    const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
    await rest.put(Routes.applicationCommands(client.user.id), { body: commands });
    setInterval(() => {
        client.user.setActivity(activities[Math.floor(Math.random() * activities.length)], { type: ActivityType.Custom });
    }, 15000);
    console.log(`${client.user.tag} が起動しました。`);
});

const app = express();
app.get('/', (req, res) => res.send('Bot Active!'));
app.listen(3000);

// --- ログ機能 ---
client.on('messageCreate', async (message) => {
    if (message.author.bot) return;
    const doc = await db.collection('text_log_settings').doc(message.channel.id).get();
    if (doc.exists) {
        await db.collection('text_logs').add({
            channelId: message.channel.id,
            content: message.content,
            author: message.author.tag,
            timestamp: new Date()
        });
    }
});

client.on('voiceStateUpdate', async (oldState, newState) => {
    const vcId = newState.channelId || oldState.channelId;
    if (!vcId) return;
    const config = await db.collection('vc_log_settings').doc(vcId).get();
    if (!config.exists) return;

    const logChannelId = config.data().logChannelId;
    const logChannel = await newState.guild.channels.fetch(logChannelId).catch(() => null);
    if (!logChannel) return;

    const user = newState.member.displayName;
    const action = !oldState.channelId ? '入室' : !newState.channelId ? '退室' : null;
    
    if (action) {
        const embed = new EmbedBuilder()
            .setTitle('🎙️ ボイスログ')
            .setDescription(`**${user}** が **${action}** しました。`)
            .addFields({ name: 'チャンネル', value: newState.guild.channels.cache.get(vcId).name })
            .setColor(action === '入室' ? 0x00FF00 : 0xFF0000)
            .setTimestamp();
        await logChannel.send({ embeds: [embed] });
    }
});

// --- インタラクション (コマンド・ボタン・モーダル) ---
client.on('interactionCreate', async interaction => {
    const safeReply = async (data) => { if (!interaction.replied && !interaction.deferred) return await interaction.reply(data); };

    // 1. スラッシュコマンド
    if (interaction.isChatInputCommand()) {
        const { commandName, options } = interaction;

        if (commandName === 'set-vc-log') {
            await db.collection('vc_log_settings').doc(options.getChannel('vc').id).set({ logChannelId: options.getChannel('log').id });
            return await interaction.reply({ content: 'VCログの設定が完了しました。', flags: MessageFlags.Ephemeral });
        }
        if (commandName === 'unset-vc-log') {
            await db.collection('vc_log_settings').doc(options.getChannel('vc').id).delete();
            return await interaction.reply({ content: 'VCログの監視を解除しました。', flags: MessageFlags.Ephemeral });
        }
        if (commandName === 'set-text-log') {
            await db.collection('text_log_settings').doc(options.getChannel('channel').id).set({ active: true });
            return await interaction.reply({ content: 'テキストログの監視を開始しました。', flags: MessageFlags.Ephemeral });
        }
        if (commandName === 'unset-text-log') {
            await db.collection('text_log_settings').doc(options.getChannel('channel').id).delete();
            return await interaction.reply({ content: 'テキストログの監視を解除しました。', flags: MessageFlags.Ephemeral });
        }
        if (commandName === 'receive-notifications') {
            await db.collection('subscribers').doc(interaction.user.id).set({ registeredAt: new Date() });
            return await interaction.reply({ content: '通知を登録しました。', flags: MessageFlags.Ephemeral });
        }
        if (commandName === 'notice') {
            if (options.getString('password') !== process.env.ADMIN_PASSWORD) return await interaction.reply({ content: 'パスワードエラー', flags: MessageFlags.Ephemeral });
            const modal = new ModalBuilder().setCustomId('notice_modal').setTitle('お知らせ入力');
            modal.addComponents(
                new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('title').setLabel('タイトル').setStyle(TextInputStyle.Short).setRequired(true)),
                new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('content').setLabel('内容').setStyle(TextInputStyle.Paragraph).setRequired(true)),
                new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('sender').setLabel('発信者').setStyle(TextInputStyle.Short).setRequired(true))
            );
            return await interaction.showModal(modal);
        }
        if (commandName === 'help') {
            const embed = new EmbedBuilder().setTitle('📜 コマンド一覧').setDescription('詳細を確認したいコマンドを選択してください。').setColor(0x00AE86);
            const select = new StringSelectMenuBuilder().setCustomId('help_select').setPlaceholder('コマンドを選択...').addOptions([
                { label: '/verify', value: 'help_verify' }, { label: '/ticket', value: 'help_ticket' }, { label: '/delete', value: 'help_delete' }
            ]);
            return await safeReply({ embeds: [embed], components: [new ActionRowBuilder().addComponents(select)], flags: MessageFlags.Ephemeral });
        }
        if (commandName === 'delete') {
            const amount = options.getInteger('amount');
            const row = new ActionRowBuilder().addComponents(
                new ButtonBuilder().setCustomId(`bulk_delete_yes_${amount}`).setLabel('削除').setStyle(ButtonStyle.Danger),
                new ButtonBuilder().setCustomId('bulk_delete_no').setLabel('キャンセル').setStyle(ButtonStyle.Secondary)
            );
            return await safeReply({ content: `${amount}件のメッセージを削除しますか？`, components: [row], flags: MessageFlags.Ephemeral });
        }
        if (commandName === 'verify') {
            const role = options.getRole('role');
            const embed = new EmbedBuilder().setTitle(options.getString('title') ?? '認証').setDescription(options.getString('description') ?? 'ボタンを押して認証してください。').setColor(0x3498DB);
            const row = new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(`v_role_${role.id}`).setLabel('✅ 認証').setStyle(ButtonStyle.Success));
            return await interaction.reply({ embeds: [embed], components: [row] });
        }
        if (commandName === 'ticket') {
            const adminRole = options.getRole('admin-role');
            const key = `msg_${Date.now()}`;
            ticketMessages.set(key, options.getString('panel-desc') ?? 'チケットを発行しました。');
            const embed = new EmbedBuilder().setTitle(options.getString('title') ?? 'チケット').setDescription(options.getString('description') ?? 'ボタンを押してください。').setColor(0x9B59B6);
            const row = new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(`tkt_${adminRole.id}_${key}`).setLabel('🎫 チケット発行').setStyle(ButtonStyle.Primary));
            return await interaction.reply({ embeds: [embed], components: [row] });
        }
    } 

    // 2. モーダル送信
    else if (interaction.isModalSubmit()) {
        if (interaction.customId === 'notice_modal') {
            await interaction.deferReply({ flags: MessageFlags.Ephemeral });
            const embed = new EmbedBuilder()
                .setTitle(`📢 ${interaction.fields.getTextInputValue('title')}`)
                .setDescription(interaction.fields.getTextInputValue('content'))
                .setFooter({ text: `発信者: ${interaction.fields.getTextInputValue('sender')}` })
                .setColor(0x00FF00);
            const subs = await db.collection('subscribers').get();
            let count = 0;
            for (const doc of subs.docs) {
                try {
                    const user = await client.users.fetch(doc.id);
                    await user.send({ embeds: [embed] });
                    count++;
                } catch (e) { /* DM閉鎖ユーザーはスキップ */ }
            }
            return await interaction.editReply(`${count}名に通知を送りました。`);
        }
    }

    // 3. ボタン・セレクトメニュー
    else if (interaction.isButton() || interaction.isStringSelectMenu()) {
        const { customId } = interaction;
        if (customId.startsWith('bulk_delete_yes_')) {
            const amount = parseInt(customId.split('_')[3]);
            await interaction.channel.bulkDelete(amount, true);
            return await interaction.update({ content: '削除完了', components: [], embeds: [] });
        }
        if (customId === 'bulk_delete_no') return await interaction.update({ content: 'キャンセル', components: [], embeds: [] });
        if (customId.startsWith('v_role_')) {
            await interaction.member.roles.add(customId.split('_')[2]);
            return await interaction.reply({ content: 'ロールを付与しました。', flags: MessageFlags.Ephemeral });
        }
        if (customId.startsWith('tkt_')) {
            const [_, adminId, key] = customId.split('_');
            const msg = ticketMessages.get(key) || '担当をお待ちください。';
            const ch = await interaction.guild.channels.create({ name: `ticket-${interaction.user.username}`, type: ChannelType.GuildText });
            await ch.send({ content: `${interaction.user} ${msg} <@&${adminId}>`, components: [new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('t_close').setLabel('閉じる').setStyle(ButtonStyle.Danger))] });
            return await interaction.reply({ content: `チケット作成: ${ch}`, flags: MessageFlags.Ephemeral });
        }
        if (customId === 't_close') await interaction.channel.delete();
        if (customId === 'help_select') {
            await interaction.update({ content: `選択されたヘルプ: ${interaction.values[0]}`, components: [] });
        }
    }
});

client.login(process.env.DISCORD_TOKEN);
