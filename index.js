const {
    Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder, EmbedBuilder,
    ActionRowBuilder, ButtonBuilder, ButtonStyle, ChannelType, PermissionsBitField,
    StringSelectMenuBuilder, ActivityType, MessageFlags, ModalBuilder, TextInputBuilder, TextInputStyle
} = require('discord.js');
const express = require('express');
const admin = require('firebase-admin');

const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
const db = admin.firestore();

const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent, GatewayIntentBits.DirectMessages]
});

const ticketMessages = new Map();
const activities = [
    "JYRAC公式Instはこちら！▶https://www.instagram.com/jyrac_official/",
    "NSF公式Instはこちら！▶https://www.instagram.com/2024nsfproject/",
    "ボットに関するお問い合わせはDiscordID’pitayakun7’まで",
    "①広告募集中", "②広告募集中"
];

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
    .setDefaultMemberPermissions(PermissionsBitField.Flags.ManageRoles)
].map(c => c.toJSON());

client.once('clientReady', async () => { // clientReady ではなく ready が一般的
    const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
    try {
        await rest.put(Routes.applicationCommands(client.user.id), { body: commands });
        console.log('Commands registered.');
    } catch (error) {
        console.error(error);
    }
    setInterval(() => {
        client.user.setActivity(activities[Math.floor(Math.random() * activities.length)], { type: ActivityType.Custom });
    }, 15000);
});

const app = express();
app.get('/', (req, res) => res.send('Bot is Active!'));
app.listen(3000);

client.on('interactionCreate', async interaction => {
    if (interaction.replied || interaction.deferred) return;
    const safeReply = async (data) => { if (!interaction.replied && !interaction.deferred) return await interaction.reply(data); };

    // --- スラッシュコマンドの処理 ---
    if (interaction.isChatInputCommand()) {
        const { commandName, options } = interaction;

        if (commandName === 'receive-notifications') {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        
        // 登録状況を確認
        const userDoc = await db.collection('subscribers').doc(interaction.user.id).get();
        
        if (userDoc.exists) {
            // 既に登録されている場合
            const row = new ActionRowBuilder().addComponents(
                new ButtonBuilder().setCustomId('notify_remove').setLabel('解除する').setStyle(ButtonStyle.Danger),
                new ButtonBuilder().setCustomId('notify_cancel').setLabel('キャンセル').setStyle(ButtonStyle.Secondary)
            );
            return await interaction.editReply({ content: '既に通知登録されています。解除しますか？', components: [row] });
        } else {
            // 未登録の場合
            await db.collection('subscribers').doc(interaction.user.id).set({ registeredAt: new Date() });
            return await interaction.editReply('通知の登録が完了しました！');
        }
   　 }
        if (commandName === 'notice') {
            if (options.getString('password') !== process.env.ADMIN_PASSWORD) return await interaction.reply({ content: 'パスワードが違います。', flags: MessageFlags.Ephemeral });
            const modal = new ModalBuilder().setCustomId('notice_modal').setTitle('お知らせ内容入力');
            modal.addComponents(
                new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('sender').setLabel('発信者名').setStyle(TextInputStyle.Short).setRequired(true)),
                new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('title').setLabel('タイトル').setStyle(TextInputStyle.Short).setRequired(true)),
                new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('content').setLabel('内容').setStyle(TextInputStyle.Paragraph).setRequired(true)),
                new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('url').setLabel('URL（任意）').setStyle(TextInputStyle.Short).setRequired(false))
            );
            return await interaction.showModal(modal);
        }
        if (commandName === 'help') {
            const embed = new EmbedBuilder().setTitle('📜 コマンド一覧').setDescription('詳細を確認したいコマンドを選択してください。').setColor(0x00AE86);
            const select = new StringSelectMenuBuilder().setCustomId('help_select').setPlaceholder('コマンドを選択...').addOptions([
                { label: '/verify', value: 'help_verify' },
                { label: '/ticket', value: 'help_ticket' },
                { label: '/role-confirmation', value: 'help_role' },
                { label: '/delete', value: 'help_delete' },
                { label: '/give-role', value: 'help_giverole' },
                { label: '/remove-role', value: 'help_removerole' },
                { label: '/notice', value: 'help_notice' },
                { label: '/receive-notifications', value: 'help_notify' }
            ]);
            return await safeReply({ embeds: [embed], components: [new ActionRowBuilder().addComponents(select)], flags: MessageFlags.Ephemeral });
        }
        if (commandName === 'delete') {
            const amount = options.getInteger('amount');
            const embed = new EmbedBuilder().setTitle('⚠️ 削除確認').setDescription(`本当に **${amount}件** 削除しますか？`).setColor(0xFF0000);
            const row = new ActionRowBuilder().addComponents(
                new ButtonBuilder().setCustomId(`bulk_delete_yes_${amount}`).setLabel('削除実行').setStyle(ButtonStyle.Danger),
                new ButtonBuilder().setCustomId('bulk_delete_no').setLabel('キャンセル').setStyle(ButtonStyle.Secondary)
            );
            return await safeReply({ embeds: [embed], components: [row], flags: MessageFlags.Ephemeral });
        }
        if (commandName === 'verify') {
            const role = options.getRole('role');
            const embed = new EmbedBuilder().setTitle(options.getString('title') ?? '認証パネル').setDescription(options.getString('description') ?? 'ボタンを押してロールを取得してください。').setColor(0x3498DB);
            const row = new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(`v_role_${role.id}`).setLabel('✅ 認証').setStyle(ButtonStyle.Success));
            return await safeReply({ embeds: [embed], components: [row] });
        }
        if (commandName === 'ticket') {
            const adminRole = options.getRole('admin-role');
            const key = `msg_${Date.now()}`;
            ticketMessages.set(key, options.getString('panel-desc') ?? 'チケットを発行しました。');
            const embed = new EmbedBuilder().setTitle(options.getString('title') ?? '問い合わせ').setDescription(options.getString('description') ?? 'チケットを発行します。').setColor(0x9B59B6);
            const row = new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(`tkt_${adminRole.id}_${key}`).setLabel('🎫 チケット発行').setStyle(ButtonStyle.Primary));
            return await safeReply({ embeds: [embed], components: [row] });
        }
        if (commandName === 'role-confirmation') {
            const member = await interaction.guild.members.fetch(options.getUser('target').id).catch(() => null);
            if (!member) return await safeReply({ content: 'ユーザーが見つかりませんでした。', flags: MessageFlags.Ephemeral });
            const roles = member.roles.cache.filter(r => r.name !== '@everyone').map(r => r.name).join('\n') || 'なし';
            return await safeReply({ content: `ロール一覧:\n\`\`\`\n${roles}\n\`\`\``, flags: MessageFlags.Ephemeral });
        }
        if (['give-role', 'remove-role'].includes(commandName)) {
            const member = options.getMember('target');
            const role = options.getRole('role');
            commandName === 'give-role' ? await member.roles.add(role) : await member.roles.remove(role);
            return await safeReply({ content: '完了しました！', flags: MessageFlags.Ephemeral });
        }
    }

    // --- モーダル送信の処理 ---
    if (interaction.isModalSubmit() && interaction.customId === 'notice_modal') {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const embed = new EmbedBuilder().setTitle(`📢 ${interaction.fields.getTextInputValue('title')}`).setDescription(`${interaction.fields.getTextInputValue('content')}\n\n${interaction.fields.getTextInputValue('url') ? `🔗 [詳細はこちら](${interaction.fields.getTextInputValue('url')})` : ''}`).setFooter({ text: `発信者: ${interaction.fields.getTextInputValue('sender')}` }).setColor(0x00FF00);
        const subs = await db.collection('subscribers').get();
        let count = 0;
        for (const doc of subs.docs) { try { const user = await client.users.fetch(doc.id); await user.send({ embeds: [embed] }); count++; } catch (e) { } }
        return await interaction.editReply(`${count} 名に送信しました。`);
    }

    // --- ボタン・セレクトメニューの処理 ---
    if (interaction.isButton() || interaction.isStringSelectMenu()) {
        const { customId } = interaction;

        if (customId === 'help_select') {
            const helpData = {
                help_verify: { title: '/verify', desc: '【内容】認証パネルを作成します。\n【詳細】ボタンを押したユーザーに指定したロールを付与します。' },
                help_ticket: { title: '/ticket', desc: '【内容】チケットパネルを作成します。\n【詳細】問い合わせチャンネルを生成し、管理者へ通知します。' },
                help_role: { title: '/role-confirmation', desc: '【内容】ロール確認\n【詳細】指定した対象の現在のロール一覧を表示します。' },
                help_delete: { title: '/delete', desc: '【内容】メッセージ一括削除\n【詳細】指定した件数(1-100)のメッセージを削除します。' },
                help_giverole: { title: '/give-role', desc: '【内容】ロール付与\n【詳細】指定したユーザーに特定のロールを付与します。' },
                help_removerole: { title: '/remove-role', desc: '【内容】ロール剥奪\n【詳細】指定したユーザーから特定のロールを剥奪します。' },
                help_notice: { title: '/notice', desc: '【内容】お知らせ送信\n【詳細】パスワード認証後、通知登録者全員に一斉DMを送信します。' },
                help_notify: { title: '/receive-notifications', desc: '【内容】通知登録\n【詳細】お知らせを受け取るためのリストに自身を登録します。' }
            };
            const selected = interaction.values[0];
            const data = helpData[selected];
            return await interaction.update({
                embeds: [new EmbedBuilder().setTitle(`📖 ${data.title}`).setDescription(data.desc).setColor(0x00AE86)],
                components: [interaction.message.components[0]]
            });
        }

        if (customId.startsWith('bulk_delete_yes_')) {
            const amount = parseInt(customId.split('_')[3]);
            await interaction.channel.bulkDelete(amount, true);
            return await interaction.update({ content: '削除しました。', embeds: [], components: [] });
        }
        if (customId === 'bulk_delete_no') return await interaction.update({ content: 'キャンセルしました。', embeds: [], components: [] });
        
        if (customId.startsWith('v_role_')) {
            await interaction.member.roles.add(customId.split('_')[2]);
            return await safeReply({ content: 'ロールを付与しました！', flags: MessageFlags.Ephemeral });
        }

        if (interaction.isButton()) {
    const { customId } = interaction;

    // 通知解除の処理
    if (customId === 'notify_remove') {
        await db.collection('subscribers').doc(interaction.user.id).delete();
        return await interaction.update({ content: '通知の登録を解除しました。', components: [] });
    }
    if (customId === 'notify_cancel') {
        return await interaction.update({ content: 'キャンセルしました。', components: [] });
    }

        if (customId.startsWith('tkt_')) {
            const [_, adminId, key] = customId.split('_');
            const customMessage = ticketMessages.get(key) || 'お問い合わせありがとうございます。';
            const ch = await interaction.guild.channels.create({
                name: `🎫-${interaction.user.username}`,
                type: ChannelType.GuildText
            });
            await ch.send({
                content: `${interaction.user} ${customMessage} <@&${adminId}>`,
                components: [new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('t_close_c').setLabel('閉じる').setStyle(ButtonStyle.Danger))]
            });
            return await safeReply({ content: `チケットを作成しました: ${ch}`, flags: MessageFlags.Ephemeral });
        }

        if (customId === 't_close_c') {
            const row = new ActionRowBuilder().addComponents(
                new ButtonBuilder().setCustomId('t_yes').setLabel('削除').setStyle(ButtonStyle.Danger),
                new ButtonBuilder().setCustomId('t_no').setLabel('キャンセル').setStyle(ButtonStyle.Secondary)
            );
            return await interaction.reply({ content: '本当にチケットを削除しますか？', components: [row], flags: MessageFlags.Ephemeral });
        }
        
        if (customId === 't_yes') {
            await interaction.channel.delete();
        }

        if (customId === 't_no') {
            return await interaction.update({ content: '削除をキャンセルしました。', components: [] });
        }
    }
});

client.login(process.env.DISCORD_TOKEN);
