const {Client,GatewayIntentBits,REST,Routes,SlashCommandBuilder,EmbedBuilder,ActionRowBuilder,
    　 ButtonBuilder,ButtonStyle,ChannelType,PermissionsBitField,StringSelectMenuBuilder,ActivityType,MessageFlags,ModalBuilder,TextInputBuilder,TextInputStyle,Events
       
} = require('discord.js');

const express = require('express');
const admin = require('firebase-admin');

// --- Firebase 初期化 (ログ設定保存用) ---
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
});
const db = admin.firestore();

// 一時的なデータ保持用
const broadcastRoleMap = new Map();
const ticketMessages = new Map();

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMembers,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent
    ]
});

// --- 共通関数: ログ送信 (Firebaseの設定に基づいて送信) ---
async function sendLog(guild, embed) {
    if (!guild) return;

    try {
        const logDoc = await db.collection('log_settings').doc(guild.id).get();
        if (!logDoc.exists) return; // 設定がなければ何もしない

        const channelId = logDoc.data().channelId;
        const logChannel = await guild.channels.fetch(channelId).catch(() => null);

        if (logChannel) {
            await logChannel.send({ embeds: [embed] });
        }
    } catch (e) {
        console.error("Log Error:", e);
    }
}

// Botのアクティビティ（ステータス）リスト
const activities = [
    "JYRAC公式Instはこちら！",
    "NSFプロジェクト進行中",
    "お問い合わせはDiscordID: pitayakun7 まで",
    "広告募集中①",
    "広告募集中②",
];

// --- スラッシュコマンドの定義 ---
const commands = [
    // 認証パネル作成
    new SlashCommandBuilder()
        .setName('verify')
        .setDescription('認証パネルを作成します')
        .addRoleOption(o => o.setName('role').setDescription('付与するロール').setRequired(true))
        .addStringOption(o => o.setName('title').setDescription('パネルのタイトル'))
        .addStringOption(o => o.setName('description').setDescription('パネルの説明文'))
        .setDefaultMemberPermissions(PermissionsBitField.Flags.ManageRoles),

    // チケット作成パネル
    new SlashCommandBuilder()
        .setName('ticket')
        .setDescription('チケットパネルを作成します')
        .addRoleOption(o => o.setName('admin-role').setDescription('対応を行う管理ロール').setRequired(true))
        .addStringOption(o => o.setName('title').setDescription('パネルのタイトル'))
        .addStringOption(o => o.setName('description').setDescription('パネルの説明文'))
        .addStringOption(o => o.setName('panel-desc').setDescription('チケット作成時に送信されるメッセージ'))
        .setDefaultMemberPermissions(PermissionsBitField.Flags.ManageChannels),

    // 一括削除
    new SlashCommandBuilder()
        .setName('delete')
        .setDescription('メッセージを一括削除します')
        .addIntegerOption(o => o.setName('amount').setDescription('件数(1-100)').setRequired(true))
        .setDefaultMemberPermissions(PermissionsBitField.Flags.ManageMessages),

    // ログ設定・解除
    new SlashCommandBuilder()
        .setName('log')
        .setDescription('ログの送信先を設定または解除します')
        .addChannelOption(o => o.setName('channel').setDescription('送信先チャンネル（指定なしで設定解除）').setRequired(false))
        .setDefaultMemberPermissions(PermissionsBitField.Flags.Administrator),

    // ロール付与
    new SlashCommandBuilder()
        .setName('give-role')
        .setDescription('指定したユーザーにロールを付与します')
        .addUserOption(o => o.setName('target').setDescription('対象ユーザー').setRequired(true))
        .addRoleOption(o => o.setName('role').setDescription('付与するロール').setRequired(true))
        .setDefaultMemberPermissions(PermissionsBitField.Flags.ManageRoles),

    // ロール剥奪
    new SlashCommandBuilder()
        .setName('remove-role')
        .setDescription('指定したユーザーからロールを剥奪します')
        .addUserOption(o => o.setName('target').setDescription('対象ユーザー').setRequired(true))
        .addRoleOption(o => o.setName('role').setDescription('剥奪するロール').setRequired(true))
        .setDefaultMemberPermissions(PermissionsBitField.Flags.ManageRoles),

    // ヘルプ
    new SlashCommandBuilder()
        .setName('help')
        .setDescription('コマンドの一覧と詳細を表示します')
].map(c => c.toJSON());

// --- Bot 起動イベント ---
client.once(Events.ClientReady, async () => {
    const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
    
    try {
        await rest.put(Routes.applicationCommands(client.user.id), { body: commands });
        console.log('--- Commands Registered ---');
    } catch (error) {
        console.error(error);
    }

    // 15秒ごとにアクティビティを更新
    setInterval(() => {
        client.user.setActivity(
            activities[Math.floor(Math.random() * activities.length)],
            { type: ActivityType.Custom }
        );
    }, 15000);
    
    console.log(`Logged in as ${client.user.tag}`);
});

// --- Keep Alive (Render用) ---
const app = express();
app.get('/', (req, res) => res.send('Bot is online!'));
app.listen(3000);

// --- インタラクション受信 ---
client.on(Events.InteractionCreate, async interaction => {

    // 1. スラッシュコマンドの処理
    if (interaction.isChatInputCommand()) {
        const { commandName, options } = interaction;

        // /log コマンド
        if (commandName === 'log') {
            await interaction.deferReply({ flags: MessageFlags.Ephemeral });
            const channel = options.getChannel('channel');

            try {
                const logDoc = await db.collection('log_settings').doc(interaction.guild.id).get();

                if (channel) {
                    // 設定・上書き
                    await db.collection('log_settings').doc(interaction.guild.id).set({
                        channelId: channel.id,
                        guildName: interaction.guild.name
                    });
                    
                    const isUpdate = logDoc.exists && logDoc.data().channelId !== channel.id;
                    const replyMsg = isUpdate 
                        ? `🔄 以前の設定を解除し、ログ送信先を ${channel} に更新しました。` 
                        : `✅ ログ送信先を ${channel} に設定しました。`;
                    
                    return await interaction.editReply(replyMsg);
                } else {
                    // 解除
                    if (!logDoc.exists) return await interaction.editReply('❌ 現在、ログ設定は登録されていません。');
                    
                    await db.collection('log_settings').doc(interaction.guild.id).delete();
                    return await interaction.editReply('🗑️ ログの設定を解除しました。');
                }
            } catch (e) {
                return await interaction.editReply('エラーが発生しました。');
            }
        }

        // /verify コマンド
        if (commandName === 'verify') {
            const role = options.getRole('role');
            const title = options.getString('title') || '認証パネル';
            const desc = options.getString('description') || '以下のボタンを押して認証を完了してください。';

            const embed = new EmbedBuilder()
                .setTitle(title)
                .setDescription(desc)
                .setColor(0x3498DB);

            const row = new ActionRowBuilder().addComponents(
                new ButtonBuilder()
                    .setCustomId(`v_role_${role.id}`)
                    .setLabel('✅ 認証')
                    .setStyle(ButtonStyle.Success)
            );

            return await interaction.reply({ embeds: [embed], components: [row] });
        }

        // /delete コマンド (確認用ボタン送信)
        if (commandName === 'delete') {
            const amount = options.getInteger('amount');
            const row = new ActionRowBuilder().addComponents(
                new ButtonBuilder().setCustomId(`bulk_yes_${amount}`).setLabel('削除').setStyle(ButtonStyle.Danger),
                new ButtonBuilder().setCustomId('bulk_no').setLabel('中止').setStyle(ButtonStyle.Secondary)
            );
            return await interaction.reply({
                content: `${amount}件のメッセージを削除しますか？`,
                components: [row],
                flags: MessageFlags.Ephemeral
            });
        }

        // /ticket コマンド
        if (commandName === 'ticket') {
            const adminRole = options.getRole('admin-role');
            const key = `t_${Date.now()}`;
            ticketMessages.set(key, options.getString('panel-desc') || 'お問い合わせありがとうございます。');

            const embed = new EmbedBuilder()
                .setTitle(options.getString('title') || 'サポートチケット')
                .setDescription(options.getString('description') || 'チケットを作成するには下のボタンを押してください。')
                .setColor(0x9B59B6);

            const row = new ActionRowBuilder().addComponents(
                new ButtonBuilder()
                    .setCustomId(`tkt_${adminRole.id}_${key}`)
                    .setLabel('🎫 チケットを作成')
                    .setStyle(ButtonStyle.Primary)
            );

            return await interaction.reply({ embeds: [embed], components: [row] });
        }

        // ロール操作 (give/remove)
        if (['give-role', 'remove-role'].includes(commandName)) {
            const member = options.getMember('target');
            const role = options.getRole('role');
            
            try {
                if (commandName === 'give-role') {
                    await member.roles.add(role);
                    await interaction.reply({ content: `✅ ${member} にロール ${role.name} を付与しました。`, flags: MessageFlags.Ephemeral });
                } else {
                    await member.roles.remove(role);
                    await interaction.reply({ content: `✅ ${member} からロール ${role.name} を剥奪しました。`, flags: MessageFlags.Ephemeral });
                }
            } catch (e) {
                await interaction.reply({ content: '❌ 権限不足などの理由により操作に失敗しました。', flags: MessageFlags.Ephemeral });
            }
        }
    }

    // 2. ボタン操作の処理
    if (interaction.isButton()) {
        const { customId } = interaction;

        // --- 認証ボタンの処理 ---
        if (customId.startsWith('v_role_')) {
            const roleId = customId.split('_')[2];

            // 先に応答を返す（10062エラー回避）
            await interaction.reply({ content: '認証を処理しています...', flags: MessageFlags.Ephemeral });

            try {
                await interaction.member.roles.add(roleId);
                await interaction.editReply({ content: '✅ 認証が完了しました！ロールを付与しました。' });

                // ログ送信
                const logEmbed = new EmbedBuilder()
                    .setTitle('認証ログ')
                    .setDescription(`${interaction.user} が認証を行い、ロール <@&${roleId}> を取得しました。`)
                    .setColor(0x2ECC71)
                    .setTimestamp();
                sendLog(interaction.guild, logEmbed);

            } catch (e) {
                await interaction.editReply({ content: '❌ ロールの付与に失敗しました。Botの権限を確認してください。' });
            }
            return;
        }

        // --- 一括削除ボタン（実行）の処理 ---
        if (customId.startsWith('bulk_yes_')) {
            const amount = parseInt(customId.split('_')[2]);
            const chName = interaction.channel.name;

            // まずUIを更新
            await interaction.update({ content: 'メッセージを削除しています...', components: [] });

            try {
                await interaction.channel.bulkDelete(amount, true);

                // ログ送信
                const logEmbed = new EmbedBuilder()
                    .setTitle('メッセージ削除ログ')
                    .setDescription(`チャンネル: **#${chName}**\n実行者: ${interaction.user}\n削除件数: ${amount}件`)
                    .setColor(0xE74C3C)
                    .setTimestamp();
                sendLog(interaction.guild, logEmbed);

            } catch (e) {
                console.error("Delete Error:", e);
            }
            return;
        }

        // --- チケット作成ボタンの処理 ---
        if (customId.startsWith('tkt_')) {
            const [_, adminRoleId, key] = customId.split('_');
            
            await interaction.reply({ content: 'チケットチャンネルを作成しています...', flags: MessageFlags.Ephemeral });

            try {
                const channel = await interaction.guild.channels.create({
                    name: `ticket-${interaction.user.username}`,
                    type: ChannelType.GuildText,
                    permissionOverwrites: [
                        { id: interaction.guild.id, deny: [PermissionsBitField.Flags.ViewChannel] },
                        { id: interaction.user.id, allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages] },
                        { id: adminRoleId, allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages] }
                    ]
                });

                const welcomeMsg = ticketMessages.get(key) || 'お問い合わせありがとうございます。';
                
                await channel.send({
                    content: `${interaction.user} <@&${adminRoleId}>\n${welcomeMsg}`,
                    components: [
                        new ActionRowBuilder().addComponents(
                            new ButtonBuilder().setCustomId('t_close').setLabel('チケットを閉じる').setStyle(ButtonStyle.Danger)
                        )
                    ]
                });

                await interaction.editReply({ content: `✅ チケットを作成しました: ${channel}` });

                // ログ送信
                const logEmbed = new EmbedBuilder()
                    .setTitle('チケット作成ログ')
                    .setDescription(`作成者: ${interaction.user}\nチャンネル: ${channel}`)
                    .setColor(0x3498DB)
                    .setTimestamp();
                sendLog(interaction.guild, logEmbed);

            } catch (e) {
                await interaction.editReply({ content: '❌ チャンネルの作成に失敗しました。' });
            }
            return;
        }

        // --- チケットを閉じる処理 ---
        if (customId === 't_close') {
            await interaction.reply({ content: 'チケットを2秒後に削除します...', flags: MessageFlags.Ephemeral });
            
            // ログ送信
            const logEmbed = new EmbedBuilder()
                .setTitle('チケット終了ログ')
                .setDescription(`チャンネル: **#${interaction.channel.name}**\n実行者: ${interaction.user}`)
                .setColor(0x607D8B)
                .setTimestamp();
            sendLog(interaction.guild, logEmbed);

            setTimeout(() => {
                interaction.channel.delete().catch(() => {});
            }, 2000);
            return;
        }

        // --- 中止ボタン ---
        if (customId === 'bulk_no') {
            return await interaction.update({ content: '操作をキャンセルしました。', components: [] });
        }
    }
});

// --- Bot ログイン ---
client.login(process.env.DISCORD_TOKEN);
