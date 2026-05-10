const {
    Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder, EmbedBuilder,
    ActionRowBuilder, ButtonBuilder, ButtonStyle, ChannelType, PermissionsBitField,
    StringSelectMenuBuilder, ActivityType, MessageFlags, ModalBuilder, TextInputBuilder, TextInputStyle,
    Events
} = require('discord.js');
const express = require('express');
const admin = require('firebase-admin');

// --- Firebase ---
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

// --- ログ送信関数 ---
async function sendLog(guild, embed) {
    if (!guild) return;
    try {
        const logDoc = await db.collection('log_settings').doc(guild.id).get();
        if (!logDoc.exists) return;
        const channelId = logDoc.data().channelId;
        const logChannel = await guild.channels.fetch(channelId).catch(() => null);
        if (logChannel) await logChannel.send({ embeds: [embed] });
    } catch (e) { console.error("Log Error:", e); }
}

const activities = ["JYRAC公式Inst", "NSFプロジェクト", "お問い合わせはpitayakun7まで", "広告募集中"];

// --- 全コマンド定義 ---
const commands = [
    new SlashCommandBuilder().setName('verify').setDescription('認証パネルを作成')
    .addRoleOption(o => o.setName('role').setDescription('付与するロール').setRequired(true))
    .addStringOption(o => o.setName('title').setDescription('タイトル'))
    .addStringOption(o => o.setName('description').setDescription('説明'))
    .setDefaultMemberPermissions(PermissionsBitField.Flags.ManageRoles),
    
    new SlashCommandBuilder().setName('ticket').setDescription('チケットパネル作成')
    .addRoleOption(o => o.setName('admin-role').setDescription('管理ロール')
　  .setRequired(true)).addStringOption(o => o.setName('title')
    .setDescription('タイトル')).addStringOption(o => o.setName('description')
　  .setDescription('説明')).addStringOption(o => o.setName('panel-desc')
    .setDescription('チケット内メッセージ')).setDefaultMemberPermissions(PermissionsBitField.Flags.ManageChannels),
    
    new SlashCommandBuilder().setName('delete').setDescription('一括削除')
    .addIntegerOption(o => o.setName('amount').setDescription('件数(1-100)')
        .setRequired(true)).setDefaultMemberPermissions(PermissionsBitField.Flags.ManageMessages),
    
    new SlashCommandBuilder().setName('log').setDescription('ログ設定・解除')
    .addChannelOption(o => o.setName('channel').setDescription('送信先(未選択で解除)')
        .setRequired(false)).setDefaultMemberPermissions(PermissionsBitField.Flags.Administrator),
    
    new SlashCommandBuilder().setName('help').setDescription('ヘルプを表示'),
    
    new SlashCommandBuilder().setName('give-role').setDescription('ロール付与')
    .addUserOption(o => o.setName('target').setDescription('対象').setRequired(true))
    .addRoleOption(o => o.setName('role').setDescription('ロール').setRequired(true))
    .setDefaultMemberPermissions(PermissionsBitField.Flags.ManageRoles),
    
    new SlashCommandBuilder().setName('remove-role').setDescription('ロール剥奪')
    .addUserOption(o => o.setName('target').setDescription('対象').setRequired(true))
    .addRoleOption(o => o.setName('role').setDescription('ロール').setRequired(true))
    .setDefaultMemberPermissions(PermissionsBitField.Flags.ManageRoles),
    
    new SlashCommandBuilder().setName('role-confirmation').setDescription('ロール確認')
    .addUserOption(o => o.setName('target').setDescription('対象').setRequired(true))
    .setDefaultMemberPermissions(PermissionsBitField.Flags.ModerateMembers),
    
    new SlashCommandBuilder().setName('receive-notifications').setDescription('通知登録/解除'),
    
    new SlashCommandBuilder().setName('notice').setDescription('お知らせ送信')
    .addStringOption(o => o.setName('password').setDescription('パスワード')
        .setRequired(true)).setDefaultMemberPermissions(PermissionsBitField.Flags.ManageRoles),
    
    new SlashCommandBuilder().setName('broadcast').setDescription('一斉DM送信')
    .addRoleOption(o => o.setName('target-role').setDescription('対象ロール')
        .setRequired(true)).addStringOption(o => o.setName('password')
        .setDescription('パスワード').setRequired(true))
    .setDefaultMemberPermissions(PermissionsBitField.Flags.ManageRoles),
    
    new SlashCommandBuilder().setName('request').setDescription('作成依頼を送る')
    
].map(c => c.toJSON());

client.once(Events.ClientReady, async () => {
    const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
    await rest.put(Routes.applicationCommands(client.user.id), { body: commands });
    console.log('Bot Ready & Commands Synced');
    setInterval(() => {
        client.user.setActivity(activities[Math.floor(Math.random() * activities.length)], { type: ActivityType.Custom });
    }, 15000);
});

// --- Express ---
const app = express();
app.get('/', (req, res) => res.send('Online'));
app.listen(3000);

client.on(Events.InteractionCreate, async interaction => {
    // 1. スラッシュコマンド
    if (interaction.isChatInputCommand()) {
        const { commandName, options } = interaction;

        if (commandName === 'log') {
            await interaction.deferReply({ flags: MessageFlags.Ephemeral });
            const channel = options.getChannel('channel');
            const logDoc = await db.collection('log_settings').doc(interaction.guild.id).get();
            
            if (channel) {
                await db.collection('log_settings').doc(interaction.guild.id).set({ channelId: channel.id, guildName: interaction.guild.name });
                const isUpdate = logDoc.exists && logDoc.data().channelId !== channel.id;
                return await interaction.editReply(isUpdate ? `🔄 設定を ${channel} に更新しました。` : `✅ ログ先を ${channel} に設定しました。`);
            } else {
                if (!logDoc.exists) return await interaction.editReply('❌ 設定がありません。');
                await db.collection('log_settings').doc(interaction.guild.id).delete();
                return await interaction.editReply('🗑️ 設定を解除しました。');
            }
        }

        if (commandName === 'verify') {
            const role = options.getRole('role');
            const embed = new EmbedBuilder().setTitle(options.getString('title') || '認証').setDescription(options.getString('description') || 'ボタンを押してください').setColor(0x3498DB);
            const row = new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(`v_role_${role.id}`).setLabel('✅ 認証').setStyle(ButtonStyle.Success));
            return await interaction.reply({ embeds: [embed], components: [row] });
        }

        if (commandName === 'delete') {
            const amount = options.getInteger('amount');
            const row = new ActionRowBuilder().addComponents(
                new ButtonBuilder().setCustomId(`bulk_delete_yes_${amount}`).setLabel('削除').setStyle(ButtonStyle.Danger),
                new ButtonBuilder().setCustomId('bulk_delete_no').setLabel('中止').setStyle(ButtonStyle.Secondary)
            );
            return await interaction.reply({ content: `${amount}件削除しますか？`, components: [row], flags: MessageFlags.Ephemeral });
        }

        if (commandName === 'ticket') {
            const adminRole = options.getRole('admin-role');
            const key = `t_${Date.now()}`;
            ticketMessages.set(key, options.getString('panel-desc') || 'お問い合わせ');
            const row = new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(`tkt_${adminRole.id}_${key}`).setLabel('🎫 作成').setStyle(ButtonStyle.Primary));
            return await interaction.reply({ embeds: [new EmbedBuilder().setTitle(options.getString('title') || 'チケット').setDescription(options.getString('description') || '作成ボタン').setColor(0x9B59B6)], components: [row] });
        }

        if (commandName === 'help') {
            const select = new StringSelectMenuBuilder().setCustomId('help_select').setPlaceholder('選択してください').addOptions([{ label: '/verify', value: 'h_v' }, { label: '/ticket', value: 'h_t' }, { label: '/log', value: 'h_l' }]);
            return await interaction.reply({ content: 'ヘルプ', components: [new ActionRowBuilder().addComponents(select)], flags: MessageFlags.Ephemeral });
        }

        if (commandName === 'request') {
            const modal = new ModalBuilder().setCustomId('req_m').setTitle('依頼');
            modal.addComponents(
                new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('r_n').setLabel('名前').setStyle(TextInputStyle.Short)),
                new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('r_c').setLabel('コマンド').setStyle(TextInputStyle.Short)),
                new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('r_d').setLabel('詳細').setStyle(TextInputStyle.Paragraph))
            );
            return await interaction.showModal(modal);
        }

        // 付与・剥奪・確認
        if (['give-role', 'remove-role'].includes(commandName)) {
            const member = options.getMember('target');
            const role = options.getRole('role');
            if (commandName === 'give-role') await member.roles.add(role); else await member.roles.remove(role);
            return await interaction.reply({ content: '完了', flags: MessageFlags.Ephemeral });
        }

        if (commandName === 'role-confirmation') {
            const member = options.getMember('target');
            const roles = member.roles.cache.filter(r => r.name !== '@everyone').map(r => r.name).join(', ') || 'なし';
            return await interaction.reply({ content: `ロール: ${roles}`, flags: MessageFlags.Ephemeral });
        }
        
        // お知らせ関連
        if (commandName === 'notice' || commandName === 'broadcast') {
            if (options.getString('password') !== process.env.ADMIN_PASSWORD) return await interaction.reply({ content: '拒否', flags: MessageFlags.Ephemeral });
            if (commandName === 'broadcast') broadcastRoleMap.set(interaction.user.id, options.getRole('target-role').id);
            const modal = new ModalBuilder()
                .setCustomId(commandName === 'notice' ? 'n_m' : 'b_m').setTitle('入力');
            modal.addComponents(new ActionRowBuilder()
                                .addComponents(new TextInputBuilder()
                                .setCustomId('txt_1').setLabel('タイトル/メッセージ').setStyle(TextInputStyle.Paragraph)));
            return await interaction.showModal(modal);
        }

        if (commandName === 'receive-notifications') {
            await interaction.deferReply({ flags: MessageFlags.Ephemeral });
            const doc = await db.collection('subscribers').doc(interaction.user.id).get();
            if (doc.exists) {
                const row = new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('n_rem').setLabel('解除').setStyle(ButtonStyle.Danger));
                return await interaction.editReply({ content: '登録済。解除？', components: [row] });
            }
            await db.collection('subscribers').doc(interaction.user.id).set({ date: new Date() });
            return await interaction.editReply('登録完了');
        }
    }

    // 2. モーダル
    if (interaction.isModalSubmit()) {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        if (interaction.customId === 'req_m') {
            const embed = new EmbedBuilder().setTitle('依頼')
                .addFields({ name: '者', value: interaction.fields.getTextInputValue('r_n') },
                           { name: '名', value: interaction.fields.getTextInputValue('r_c') },
                           { name: '説', value: interaction.fields.getTextInputValue('r_d') });
            const admin = await client.users.fetch(process.env.ADMIN_USER_ID);
            await admin.send({ embeds: [embed] });
            return await interaction.editReply('送信完了');
        }
        // お知らせ・DM一斉送信（簡略化して実装）
        if (interaction.customId === 'n_m' || interaction.customId === 'b_m') {
            const text = interaction.fields.getTextInputValue('txt_1');
            // ... 送信ロジック ...
            return await interaction.editReply('処理開始');
        }
    }

    // 3. ボタン・メニュー
    if (interaction.isButton()) {
        const { customId } = interaction;

        if (customId.startsWith('v_role_')) {
            const rid = customId.split('_')[2];
            await interaction.member.roles.add(rid);
            await sendLog(interaction.guild, new EmbedBuilder().setTitle('認証ログ').setDescription(`${interaction.user} が <@&${rid}> を取得`).setColor(0x2ECC71));
            return await interaction.reply({ content: '完了', flags: MessageFlags.Ephemeral });
        }

        if (customId.startsWith('bulk_delete_yes_')) {
            const amt = parseInt(customId.split('_')[3]);
            await interaction.update({ content: '実行中...', components: [] });
            await interaction.channel.bulkDelete(amt, true);
            await sendLog(interaction.guild, new EmbedBuilder().setTitle('削除ログ').setDescription(`${interaction.user} が ${amt}件削除`).setColor(0xE74C3C));
            return;
        }

        if (customId.startsWith('tkt_')) {
            const [_, aid, key] = customId.split('_');
            const ch = await interaction.guild.channels.create({ name: `ticket-${interaction.user.username}`, type: ChannelType.GuildText });
            await ch.send({ content: `${interaction.user} ${ticketMessages.get(key)} <@&${aid}>`, components: [new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('t_close').setLabel('閉じる').setStyle(ButtonStyle.Danger))] });
            return await interaction.reply({ content: `作成: ${ch}`, flags: MessageFlags.Ephemeral });
        }

        if (customId === 't_close') {
            await interaction.reply({ content: '削除します', flags: MessageFlags.Ephemeral });
            setTimeout(() => interaction.channel.delete(), 2000);
        }

        if (customId === 'n_rem') {
            await db.collection('subscribers').doc(interaction.user.id).delete();
            return await interaction.update({ content: '解除済', components: [] });
        }
        
        if (customId === 'bulk_delete_no') return await interaction.update({ content: '中止', components: [] });
    }

    if (interaction.isStringSelectMenu()) {
        if (interaction.customId === 'help_select') {
            return await interaction.update({ content: `選択中: ${interaction.values[0]}`, components: [interaction.message.components[0]] });
        }
    }
});

client.login(process.env.DISCORD_TOKEN);
