const {
    Client,
    GatewayIntentBits,
    REST,
    Routes,
    SlashCommandBuilder,
    EmbedBuilder,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    ChannelType,
    PermissionsBitField,
    StringSelectMenuBuilder,
    ActivityType,
    MessageFlags,
    ModalBuilder,
    TextInputBuilder,
    TextInputStyle,
    Events,
    AttachmentBuilder,
    PermissionFlagsBits,
} = require('discord.js');

const express = require('express');
const admin = require('firebase-admin');
const fs = require('fs');
const path = require('path');

// --- Firebase 初期化 (設定・通知保存用) ---
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
});
const db = admin.firestore();

// ─── 権限管理 ──────────────────────────────────────────────────
// 作成者IDは環境変数 ADMIN_USER_ID から取得

/**
 * ユーザーがコマンドを使用できるか確認する
 * 作成者 または Firestoreの許可リストに登録されているユーザーのみtrue
 */
async function isAuthorized(userId) {
    // 作成者は常に許可
    if (userId === process.env.ADMIN_USER_ID) return true;

    // Firestoreの許可リストを確認
    const doc = await db.collection('allowed_users').doc(userId).get();
    return doc.exists;
}

/**
 * 権限なしの場合に返すエラーメッセージ
 */
async function replyUnauthorized(interaction) {
    const msg = '❌ このコマンドを使用する権限がありません。作成者に許可を申請してください。';
    if (interaction.deferred || interaction.replied) {
        await interaction.editReply({ content: msg });
    } else {
        await interaction.reply({ content: msg, flags: MessageFlags.Ephemeral });
    }
}
// ──────────────────────────────────────────────────────────────

// メモリ保持用マップ
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
        if (!logDoc.exists) return;

        const channelId = logDoc.data().channelId;
        const logChannel = await guild.channels.fetch(channelId).catch(() => null);

        if (logChannel) {
            await logChannel.send({ embeds: [embed] });
        }
    } catch (e) {
        console.error("Log Error:", e);
    }
}

// --- 共通関数: コマンド実行ログ送信 ---
async function sendCommandLog(interaction, commandName) {
    const embed = new EmbedBuilder()
        .setTitle('📋 コマンド実行ログ')
        .addFields(
            { name: '使用者', value: `${interaction.user}`, inline: true },
            { name: '使用コマンド', value: `/${commandName}`, inline: true },
            { name: '日時', value: `<t:${Math.floor(Date.now() / 1000)}:F>`, inline: false }
        )
        .setColor(0x95A5A6)
        .setTimestamp();

    await sendLog(interaction.guild, embed);
}

// Botのアクティビティ（ステータス）リスト
const activities = [
    "JYRAC公式Instは'2024nsfproject'で検索！",
    "JYRAC公式Instは'Jyrac_official'で検索！",
    "お問い合わせはDiscordID: pitayakun7 まで",
    "広告募集中"
];

// ─── エクスポート用ユーティリティ ──────────────────────────────

/**
 * Discord APIの100件制限を超えて全メッセージを取得する
 */
async function fetchAllMessages(channel, { limit = null, before, after } = {}) {
    const messages = [];
    let lastId = before || null;
    const unlimited = limit === null;

    while (unlimited || messages.length < limit) {
        const remaining = unlimited ? 100 : Math.min(limit - messages.length, 100);
        const options = { limit: remaining };
        if (lastId) options.before = lastId;
        if (after && messages.length === 0) options.after = after;

        const batch = await channel.messages.fetch(options);
        if (batch.size === 0) break;

        const sorted = [...batch.values()].sort(
            (a, b) => a.createdTimestamp - b.createdTimestamp
        );
        messages.unshift(...sorted);

        lastId = batch.last().id;

        if (batch.size < remaining) break;
    }

    if (after) {
        const afterMsg = messages.find((m) => m.id === after);
        const afterIndex = afterMsg ? messages.indexOf(afterMsg) + 1 : 0;
        const sliced = messages.slice(afterIndex);
        return unlimited ? sliced : sliced.slice(0, limit);
    }

    return unlimited ? messages : messages.slice(0, limit);
}

/**
 * メッセージ一覧をテキスト形式に整形する
 */
function formatMessagesToText(messages, channel, guild) {
    const lines = [];
    const now = new Date().toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' });

    lines.push('='.repeat(60));
    lines.push('Discord チャンネルエクスポート');
    lines.push('='.repeat(60));
    lines.push(`サーバー   : ${guild.name}`);
    lines.push(`チャンネル : #${channel.name}`);
    lines.push(`取得件数   : ${messages.length} 件`);
    lines.push(`エクスポート日時: ${now} (JST)`);
    lines.push('='.repeat(60));
    lines.push('');

    for (const msg of messages) {
        const ts = msg.createdAt.toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' });
        const author = msg.author.username;
        const tag = msg.author.discriminator && msg.author.discriminator !== '0'
            ? `#${msg.author.discriminator}`
            : '';

        lines.push(`[${ts}] ${author}${tag}`);

        if (msg.content) lines.push(msg.content);

        if (msg.attachments.size > 0) {
            msg.attachments.forEach((att) => {
                lines.push(`[添付ファイル] ${att.name}: ${att.url}`);
            });
        }

        if (msg.embeds.length > 0) {
            msg.embeds.forEach((embed) => {
                if (embed.title) lines.push(`[Embed タイトル] ${embed.title}`);
                if (embed.description) lines.push(`[Embed 説明] ${embed.description}`);
                if (embed.url) lines.push(`[Embed URL] ${embed.url}`);
            });
        }

        if (msg.reactions.cache.size > 0) {
            const reactions = msg.reactions.cache
                .map((r) => `${r.emoji.name}×${r.count}`)
                .join('  ');
            lines.push(`[リアクション] ${reactions}`);
        }

        if (msg.reference?.messageId) {
            lines.push(`[返信先 ID] ${msg.reference.messageId}`);
        }

        lines.push('');
    }

    lines.push('='.repeat(60));
    lines.push('エクスポート終了');
    lines.push('='.repeat(60));

    return lines.join('\n');
}

// --- スラッシュコマンドの定義 (全15コマンド) ---
const commands = [
    // 1. 認証パネル作成
    new SlashCommandBuilder()
        .setName('verify')
        .setDescription('認証パネルを作成します')
        .addRoleOption(o => o.setName('role').setDescription('付与するロール').setRequired(true))
        .addStringOption(o => o.setName('title').setDescription('パネルのタイトル'))
        .addStringOption(o => o.setName('description').setDescription('パネルの説明文')),
        // ★ setDefaultMemberPermissions を削除 → 全員に表示、isAuthorized でチェック

    // 2. チケット作成パネル
    new SlashCommandBuilder()
        .setName('ticket')
        .setDescription('チケットパネルを作成します')
        .addRoleOption(o => o.setName('admin-role').setDescription('対応を行う管理ロール').setRequired(true))
        .addStringOption(o => o.setName('title').setDescription('パネルのタイトル'))
        .addStringOption(o => o.setName('description').setDescription('パネルの説明文'))
        .addStringOption(o => o.setName('panel-desc').setDescription('チケット作成時に送信されるメッセージ')),

    // 3. 一括削除
    new SlashCommandBuilder()
        .setName('delete')
        .setDescription('メッセージを一括削除します')
        .addIntegerOption(o => o.setName('amount').setDescription('件数(1-100)').setRequired(true)),

    // 4. ログ設定・解除
    new SlashCommandBuilder()
        .setName('log')
        .setDescription('ログの送信先を設定または解除します')
        .addChannelOption(o => o.setName('channel').setDescription('送信先チャンネル（指定なしで設定解除）').setRequired(false)),

    // 5. ロール付与
    new SlashCommandBuilder()
        .setName('give-role')
        .setDescription('指定したユーザーにロールを付与します')
        .addUserOption(o => o.setName('target').setDescription('対象ユーザー').setRequired(true))
        .addRoleOption(o => o.setName('role').setDescription('付与するロール').setRequired(true)),

    // 6. ロール剥奪
    new SlashCommandBuilder()
        .setName('remove-role')
        .setDescription('指定したユーザーからロールを剥奪します')
        .addUserOption(o => o.setName('target').setDescription('対象ユーザー').setRequired(true))
        .addRoleOption(o => o.setName('role').setDescription('剥奪するロール').setRequired(true)),

    // 7. ロール確認
    new SlashCommandBuilder()
        .setName('role-confirmation')
        .setDescription('指定ユーザーが所持しているロールの一覧を確認します')
        .addUserOption(o => o.setName('target').setDescription('確認対象のユーザー').setRequired(true)),

    // 8. 通知登録・解除
    new SlashCommandBuilder()
        .setName('receive-notifications')
        .setDescription('重要なお知らせの通知登録・解除を行います'),

    // 9. お知らせ送信
    new SlashCommandBuilder()
        .setName('notice')
        .setDescription('登録ユーザーにお知らせをDM送信します(管理者専用)')
        .addStringOption(o => o.setName('password').setDescription('認証パスワード').setRequired(true)),

    // 10. 一斉送信
    new SlashCommandBuilder()
        .setName('broadcast')
        .setDescription('指定ロールの所持者に一斉DMを送信します(管理者専用)')
        .addRoleOption(o => o.setName('target-role').setDescription('送信対象のロール').setRequired(true))
        .addStringOption(o => o.setName('password').setDescription('認証パスワード').setRequired(true)),

    // 11. 作成依頼
    new SlashCommandBuilder()
        .setName('request')
        .setDescription('新規コマンドの作成依頼を送ります'),

    // 12. ヘルプ
    new SlashCommandBuilder()
        .setName('help')
        .setDescription('コマンドの一覧と詳細を表示します'),

    // 13. チャンネルエクスポート
    new SlashCommandBuilder()
        .setName('export')
        .setDescription('チャンネルのメッセージをテキストファイルにエクスポートします')
        .addChannelOption(o =>
            o.setName('channel')
                .setDescription('エクスポートするチャンネル（省略時: 現在のチャンネル）')
                .setRequired(false)
        )
        .addIntegerOption(o =>
            o.setName('limit')
                .setDescription('取得するメッセージ数（省略時: チャンネル全件）')
                .setMinValue(1)
                .setRequired(false)
        )
        .addStringOption(o =>
            o.setName('before')
                .setDescription('このメッセージID以前のメッセージを取得')
                .setRequired(false)
        )
        .addStringOption(o =>
            o.setName('after')
                .setDescription('このメッセージID以降のメッセージを取得')
                .setRequired(false)
        ),

    // ★ 14. ユーザー許可 (作成者専用)
    new SlashCommandBuilder()
        .setName('allow-user')
        .setDescription('【作成者専用】指定ユーザーにすべてのコマンドの使用を許可します')
        .addUserOption(o =>
            o.setName('target')
                .setDescription('許可するユーザー')
                .setRequired(true)
        ),

    // ★ 15. ユーザー許可解除 (作成者専用)
    new SlashCommandBuilder()
        .setName('deny-user')
        .setDescription('【作成者専用】指定ユーザーのコマンド使用許可を剥奪します')
        .addUserOption(o =>
            o.setName('target')
                .setDescription('許可を解除するユーザー')
                .setRequired(true)
        ),

].map(c => c.toJSON());

// --- Bot 起動イベント ---
client.once(Events.ClientReady, async () => {
    const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
    
    try {
        await rest.put(Routes.applicationCommands(client.user.id), { body: commands });
        console.log('--- All 15 Commands Registered ---');
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

        // ─────────────────────────────────────────────────────────
        // ★ 全コマンド共通: 権限チェック
        //   /receive-notifications と /help と /request は誰でも使用可能
        //   それ以外は作成者または許可ユーザーのみ
        // ─────────────────────────────────────────────────────────
        const publicCommands = ['receive-notifications', 'help', 'request'];
        if (!publicCommands.includes(commandName)) {
            const authorized = await isAuthorized(interaction.user.id);
            if (!authorized) {
                return replyUnauthorized(interaction);
            }
        }

        // ★ /allow-user コマンド (作成者のみ)
        if (commandName === 'allow-user') {
            // allow-user / deny-user はさらに作成者のみに限定
            if (interaction.user.id !== process.env.ADMIN_USER_ID) {
                return interaction.reply({ content: '❌ このコマンドは作成者のみ使用できます。', flags: MessageFlags.Ephemeral });
            }

            const target = options.getUser('target');

            if (target.id === process.env.ADMIN_USER_ID) {
                return interaction.reply({ content: '❌ 作成者自身を登録する必要はありません。', flags: MessageFlags.Ephemeral });
            }

            await db.collection('allowed_users').doc(target.id).set({
                username: target.username,
                addedAt: new Date(),
                addedBy: interaction.user.id
            });

            const embed = new EmbedBuilder()
                .setTitle('✅ ユーザー許可')
                .setDescription(`${target} にすべてのコマンドの使用を許可しました。`)
                .addFields(
                    { name: 'ユーザー名', value: target.username, inline: true },
                    { name: 'ユーザーID', value: target.id, inline: true }
                )
                .setColor(0x2ECC71)
                .setTimestamp();

            await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });

            const logEmbed = new EmbedBuilder()
                .setTitle('🔓 ユーザー許可ログ')
                .addFields(
                    { name: '操作者', value: `${interaction.user}`, inline: true },
                    { name: '対象ユーザー', value: `${target}`, inline: true },
                    { name: '日時', value: `<t:${Math.floor(Date.now() / 1000)}:F>`, inline: false }
                )
                .setColor(0x2ECC71)
                .setTimestamp();
            sendLog(interaction.guild, logEmbed);
            return;
        }

        // ★ /deny-user コマンド (作成者のみ)
        if (commandName === 'deny-user') {
            if (interaction.user.id !== process.env.ADMIN_USER_ID) {
                return interaction.reply({ content: '❌ このコマンドは作成者のみ使用できます。', flags: MessageFlags.Ephemeral });
            }

            const target = options.getUser('target');

            if (target.id === process.env.ADMIN_USER_ID) {
                return interaction.reply({ content: '❌ 作成者自身の権限は変更できません。', flags: MessageFlags.Ephemeral });
            }

            const doc = await db.collection('allowed_users').doc(target.id).get();
            if (!doc.exists) {
                return interaction.reply({ content: `❌ ${target.username} は許可リストに登録されていません。`, flags: MessageFlags.Ephemeral });
            }

            await db.collection('allowed_users').doc(target.id).delete();

            const embed = new EmbedBuilder()
                .setTitle('🚫 ユーザー許可解除')
                .setDescription(`${target} のコマンド使用許可を解除しました。`)
                .addFields(
                    { name: 'ユーザー名', value: target.username, inline: true },
                    { name: 'ユーザーID', value: target.id, inline: true }
                )
                .setColor(0xE74C3C)
                .setTimestamp();

            await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });

            const logEmbed = new EmbedBuilder()
                .setTitle('🔒 ユーザー許可解除ログ')
                .addFields(
                    { name: '操作者', value: `${interaction.user}`, inline: true },
                    { name: '対象ユーザー', value: `${target}`, inline: true },
                    { name: '日時', value: `<t:${Math.floor(Date.now() / 1000)}:F>`, inline: false }
                )
                .setColor(0xE74C3C)
                .setTimestamp();
            sendLog(interaction.guild, logEmbed);
            return;
        }

        // /log コマンド
        if (commandName === 'log') {
            await interaction.deferReply({ flags: MessageFlags.Ephemeral });
            const channel = options.getChannel('channel');

            try {
                const logDoc = await db.collection('log_settings').doc(interaction.guild.id).get();

                if (channel) {
                    await db.collection('log_settings').doc(interaction.guild.id).set({
                        channelId: channel.id,
                        guildName: interaction.guild.name
                    });
                    
                    const isUpdate = logDoc.exists && logDoc.data().channelId !== channel.id;
                    const replyMsg = isUpdate 
                        ? `🔄 以前の設定を解除し、ログ送信先を ${channel} に更新しました。` 
                        : `✅ ログ送信先を ${channel} に設定しました。`;

                    await interaction.editReply(replyMsg);
                    sendCommandLog(interaction, commandName);
                    return;
                } else {
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
            const title = options.getString('title') ?? '認証パネル';
            const desc = options.getString('description') ?? '以下のボタンを押して認証を完了してください。';

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

            await interaction.reply({ embeds: [embed], components: [row] });
            sendCommandLog(interaction, commandName);
            return;
        }

        // /delete コマンド
        if (commandName === 'delete') {
            const amount = options.getInteger('amount');
            const row = new ActionRowBuilder().addComponents(
                new ButtonBuilder().setCustomId(`bulk_yes_${amount}`).setLabel('削除').setStyle(ButtonStyle.Danger),
                new ButtonBuilder().setCustomId('bulk_no').setLabel('中止').setStyle(ButtonStyle.Secondary)
            );
            await interaction.reply({
                content: `${amount}件のメッセージを削除しますか？`,
                components: [row],
                flags: MessageFlags.Ephemeral
            });
            sendCommandLog(interaction, commandName);
            return;
        }

        // /ticket コマンド
        if (commandName === 'ticket') {
            const adminRole = options.getRole('admin-role');
            const key = `t_${Date.now()}`;
            ticketMessages.set(key, options.getString('panel-desc') ?? null);

            const embed = new EmbedBuilder()
                .setTitle(options.getString('title') ?? 'サポートチケット')
                .setDescription(options.getString('description') ?? 'チケットを作成するには下のボタンを押してください。')
                .setColor(0x9B59B6);

            const row = new ActionRowBuilder().addComponents(
                new ButtonBuilder()
                    .setCustomId(`tkt_${adminRole.id}_${key}`)
                    .setLabel('🎫 チケットを作成')
                    .setStyle(ButtonStyle.Primary)
            );

            await interaction.reply({ embeds: [embed], components: [row] });
            sendCommandLog(interaction, commandName);
            return;
        }

        // /give-role / /remove-role コマンド
        if (['give-role', 'remove-role'].includes(commandName)) {
            const member = options.getMember('target');
            const role = options.getRole('role');
            
            try {
                if (commandName === 'give-role') {
                    await member.roles.add(role);
                    await interaction.reply({ content: `✅ ${member} にロール **${role.name}** を付与しました。`, flags: MessageFlags.Ephemeral });
                    sendCommandLog(interaction, commandName);
                } else {
                    await member.roles.remove(role);
                    await interaction.reply({ content: `✅ ${member} からロール **${role.name}** を剥奪しました。`, flags: MessageFlags.Ephemeral });
                    sendCommandLog(interaction, commandName);
                }
            } catch (e) {
                await interaction.reply({ content: '❌ 権限不足などの理由により操作に失敗しました。', flags: MessageFlags.Ephemeral });
            }
        }

        // /role-confirmation コマンド
        if (commandName === 'role-confirmation') {
            const member = options.getMember('target');
            if (!member) return await interaction.reply({ content: '❌ ユーザーが見つかりませんでした。', flags: MessageFlags.Ephemeral });

            const roles = member.roles.cache
                .filter(r => r.name !== '@everyone')
                .map(r => r.toString())
                .join(', ') || 'なし';

            const embed = new EmbedBuilder()
                .setTitle(`👤 ${member.user.username} のロール確認`)
                .setDescription(`所持しているロール一覧:\n${roles}`)
                .setColor(0x00AE86);

            await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
            sendCommandLog(interaction, commandName);
            return;
        }

        // /receive-notifications コマンド
        if (commandName === 'receive-notifications') {
            await interaction.deferReply({ flags: MessageFlags.Ephemeral });
            const doc = await db.collection('subscribers').doc(interaction.user.id).get();

            if (doc.exists) {
                const row = new ActionRowBuilder().addComponents(
                    new ButtonBuilder().setCustomId('n_rem').setLabel('解除する').setStyle(ButtonStyle.Danger),
                    new ButtonBuilder().setCustomId('bulk_no').setLabel('キャンセル').setStyle(ButtonStyle.Secondary)
                );
                return await interaction.editReply({ content: '既に通知登録されています。解除しますか？', components: [row] });
            }

            await db.collection('subscribers').doc(interaction.user.id).set({ date: new Date() });
            await interaction.editReply('✅ 重要なお知らせの通知登録が完了しました！');
            sendCommandLog(interaction, commandName);
            return;
        }

        // /notice / /broadcast コマンド (モーダル呼出)
        if (commandName === 'notice' || commandName === 'broadcast') {
            if (options.getString('password') !== process.env.BROADCAST_PASSWORD) {
                return await interaction.reply({ content: '❌ パスワードが一致しません。', flags: MessageFlags.Ephemeral });
            }

            if (commandName === 'broadcast') {
                broadcastRoleMap.set(interaction.user.id, options.getRole('target-role').id);

                const modal = new ModalBuilder()
                    .setCustomId('broadcast_modal')
                    .setTitle('ロール宛て一斉DM');

                modal.addComponents(
                    new ActionRowBuilder().addComponents(
                        new TextInputBuilder()
                            .setCustomId('dm_speaker')
                            .setLabel('発言者')
                            .setStyle(TextInputStyle.Short)
                            .setRequired(true)
                    ),
                    new ActionRowBuilder().addComponents(
                        new TextInputBuilder()
                            .setCustomId('dm_text')
                            .setLabel('送信するメッセージ内容')
                            .setStyle(TextInputStyle.Paragraph)
                            .setRequired(true)
                    ),
                    new ActionRowBuilder().addComponents(
                        new TextInputBuilder()
                            .setCustomId('dm_url')
                            .setLabel('URL（任意）')
                            .setStyle(TextInputStyle.Short)
                            .setRequired(false)
                    )
                );

                await interaction.showModal(modal);
                sendCommandLog(interaction, commandName);
                return;
            }

            const modal = new ModalBuilder()
                .setCustomId('notice_modal')
                .setTitle('お知らせ一斉DM');

            modal.addComponents(
                new ActionRowBuilder().addComponents(
                    new TextInputBuilder()
                        .setCustomId('dm_text')
                        .setLabel('送信するメッセージ内容')
                        .setStyle(TextInputStyle.Paragraph)
                        .setRequired(true)
                )
            );

            await interaction.showModal(modal);
            sendCommandLog(interaction, commandName);
            return;
        }

        // /request コマンド
        if (commandName === 'request') {
            const modal = new ModalBuilder()
                .setCustomId('req_modal')
                .setTitle('新規コマンド作成依頼');

            modal.addComponents(
                new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('r_name').setLabel('あなたのお名前').setStyle(TextInputStyle.Short).setRequired(true)),
                new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('r_cmd').setLabel('希望するコマンド名 (例: /test)').setStyle(TextInputStyle.Short).setRequired(true)),
                new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('r_desc').setLabel('詳しい機能・説明').setStyle(TextInputStyle.Paragraph).setRequired(true))
            );

            await interaction.showModal(modal);
            sendCommandLog(interaction, commandName);
            return;
        }

        // /help コマンド
        if (commandName === 'help') {
            const select = new StringSelectMenuBuilder()
                .setCustomId('help_select')
                .setPlaceholder('詳細を見たいコマンドを選択')
                .addOptions([
                    { label: '/verify (認証)', value: 'h_verify' },
                    { label: '/ticket (サポート)', value: 'h_ticket' },
                    { label: '/log (管理ログ)', value: 'h_log' },
                    { label: '/role-confirmation (確認)', value: 'h_role' },
                    { label: '/export (チャンネルエクスポート)', value: 'h_export' },
                    { label: '/allow-user (ユーザー許可)', value: 'h_allow' },
                    { label: '/deny-user (ユーザー許可解除)', value: 'h_deny' },
                ]);

            await interaction.reply({
                content: '📜 **コマンドヘルプ**\n詳細を確認したい機能を選択してください。',
                components: [new ActionRowBuilder().addComponents(select)],
                flags: MessageFlags.Ephemeral
            });
            sendCommandLog(interaction, commandName);
            return;
        }

        // /export コマンド
        if (commandName === 'export') {
            await interaction.deferReply({ flags: MessageFlags.Ephemeral });

            const targetChannel = options.getChannel('channel') || interaction.channel;
            const limit = options.getInteger('limit') ?? null;
            const before = options.getString('before') || undefined;
            const after = options.getString('after') || undefined;

            if (!targetChannel.isTextBased()) {
                return interaction.editReply('❌ テキストチャンネルのみエクスポート可能です。');
            }

            const perms = targetChannel.permissionsFor(interaction.guild.members.me);
            if (!perms.has(PermissionFlagsBits.ReadMessageHistory)) {
                return interaction.editReply('❌ Botにメッセージ履歴の読み取り権限がありません。');
            }

            try {
                const limitLabel = limit !== null ? `最大 ${limit} 件` : '全件';
                await interaction.editReply(`⏳ **#${targetChannel.name}** のメッセージを取得中... (${limitLabel})`);

                const messages = await fetchAllMessages(targetChannel, { limit, before, after });

                if (messages.length === 0) {
                    return interaction.editReply('⚠️ 取得できるメッセージがありませんでした。');
                }

                const text = formatMessagesToText(messages, targetChannel, interaction.guild);

                const tmpDir = '/tmp/discord-export';
                if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });

                const filename = `export_${targetChannel.name}_${Date.now()}.txt`;
                const filepath = path.join(tmpDir, filename);
                fs.writeFileSync(filepath, text, 'utf-8');

                const attachment = new AttachmentBuilder(filepath, { name: filename });

                await interaction.editReply({
                    content: `✅ **#${targetChannel.name}** から **${messages.length} 件**のメッセージをエクスポートしました。`,
                    files: [attachment],
                });

                fs.unlinkSync(filepath);

                const logEmbed = new EmbedBuilder()
                    .setTitle('📤 エクスポートログ')
                    .addFields(
                        { name: '使用者', value: `${interaction.user}`, inline: true },
                        { name: '使用コマンド', value: '/export', inline: true },
                        { name: '日時', value: `<t:${Math.floor(Date.now() / 1000)}:F>`, inline: false },
                        { name: 'チャンネル', value: `${targetChannel}`, inline: true },
                        { name: '取得件数', value: `${messages.length} 件`, inline: true }
                    )
                    .setColor(0x1ABC9C)
                    .setTimestamp();
                sendLog(interaction.guild, logEmbed);

            } catch (err) {
                console.error('エクスポートエラー:', err);
                await interaction.editReply(`❌ エラーが発生しました: \`${err.message}\``);
            }
            return;
        }
    }

    // 2. モーダル送信の処理
    if (interaction.isModalSubmit()) {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });

        // 作成依頼の処理
        if (interaction.customId === 'req_modal') {
            const embed = new EmbedBuilder()
                .setTitle('📩 新規コマンド作成依頼')
                .addFields(
                    { name: '依頼者', value: interaction.fields.getTextInputValue('r_name') },
                    { name: '希望コマンド', value: interaction.fields.getTextInputValue('r_cmd') },
                    { name: '機能詳細', value: interaction.fields.getTextInputValue('r_desc') }
                )
                .setColor(0xFFA500);

            try {
                const adminUser = await client.users.fetch(process.env.ADMIN_USER_ID);
                await adminUser.send({ embeds: [embed] });
                return await interaction.editReply('✅ 開発者宛てに依頼を送信しました！');
            } catch (e) {
                return await interaction.editReply('❌ 送信に失敗しました。環境変数を確認してください。');
            }
        }

        // お知らせDM送信 (/notice)
        if (interaction.customId === 'notice_modal') {
            const textContent = interaction.fields.getTextInputValue('dm_text');
            const subs = await db.collection('subscribers').get();
            let count = 0;

            for (const doc of subs.docs) {
                try {
                    const u = await client.users.fetch(doc.id);
                    await u.send(`📢 **重要なお知らせ**\n\n${textContent}`);
                    count++;
                } catch (e) {}
            }
            return await interaction.editReply(`✅ 登録ユーザー ${count} 名にお知らせを送信しました。`);
        }

        // ロール宛て一斉DM送信 (/broadcast)
        if (interaction.customId === 'broadcast_modal') {
            const roleId = broadcastRoleMap.get(interaction.user.id);
            if (!roleId) return await interaction.editReply('❌ セッションが切れました。もう一度コマンドからやり直してください。');

            broadcastRoleMap.delete(interaction.user.id);

            const speaker = interaction.fields.getTextInputValue('dm_speaker');
            const textContent = interaction.fields.getTextInputValue('dm_text');
            const url = interaction.fields.getTextInputValue('dm_url').trim();

            const dmEmbed = new EmbedBuilder()
                .setTitle('📢 お知らせ')
                .addFields(
                    { name: '発言者', value: speaker },
                    { name: '内容', value: textContent }
                )
                .setColor(0xE67E22)
                .setTimestamp();

            if (url) {
                dmEmbed.addFields({ name: 'URL', value: url });
            }

            const members = (await interaction.guild.members.fetch()).filter(m => m.roles.cache.has(roleId) && !m.user.bot);
            let count = 0;

            for (const [id, m] of members) {
                try {
                    await m.send({ embeds: [dmEmbed] });
                    count++;
                    await new Promise(r => setTimeout(r, 800));
                } catch (e) {}
            }
            return await interaction.editReply(`✅ 指定ロールのメンバー ${count} 名にDMを送信しました。`);
        }
    }

    // 3. ボタン操作の処理
    if (interaction.isButton()) {
        const { customId } = interaction;

        // 認証ボタン
        if (customId.startsWith('v_role_')) {
            const roleId = customId.split('_')[2];
            await interaction.reply({ content: '認証を処理しています...', flags: MessageFlags.Ephemeral });

            try {
                await interaction.member.roles.add(roleId);
                await interaction.editReply({ content: '✅ 認証が完了しました！ロールを付与しました。' });

                const logEmbed = new EmbedBuilder()
                    .setTitle('🔐 認証ログ')
                    .addFields(
                        { name: '使用者', value: `${interaction.user}`, inline: true },
                        { name: '使用コマンド', value: '認証ボタン', inline: true },
                        { name: '日時', value: `<t:${Math.floor(Date.now() / 1000)}:F>`, inline: false },
                        { name: '取得ロール', value: `<@&${roleId}>`, inline: false }
                    )
                    .setColor(0x2ECC71)
                    .setTimestamp();
                sendLog(interaction.guild, logEmbed);
            } catch (e) {
                await interaction.editReply({ content: '❌ ロールの付与に失敗しました。Botのロール順位を確認してください。' });
            }
            return;
        }

        // 一括削除ボタン
        if (customId.startsWith('bulk_yes_')) {
            const amount = parseInt(customId.split('_')[2]);
            const chName = interaction.channel.name;

            await interaction.update({ content: 'メッセージを削除しています...', components: [] });

            try {
                await interaction.channel.bulkDelete(amount, true);
                const logEmbed = new EmbedBuilder()
                    .setTitle('🗑️ メッセージ削除ログ')
                    .addFields(
                        { name: '使用者', value: `${interaction.user}`, inline: true },
                        { name: '使用コマンド', value: '/delete', inline: true },
                        { name: '日時', value: `<t:${Math.floor(Date.now() / 1000)}:F>`, inline: false },
                        { name: 'チャンネル', value: `**#${chName}**`, inline: true },
                        { name: '削除件数', value: `${amount}件`, inline: true }
                    )
                    .setColor(0xE74C3C)
                    .setTimestamp();
                sendLog(interaction.guild, logEmbed);
            } catch (e) {
                console.error(e);
            }
            return;
        }

        // チケット作成ボタン
        if (customId.startsWith('tkt_')) {
            const parts = customId.split('_');
            const adminRoleId = parts[1];
            const key = parts.slice(2).join('_');
            await interaction.reply({ content: 'チケットチャンネルを作成しています...', flags: MessageFlags.Ephemeral });

            try {
                const channel = await interaction.guild.channels.create({
                    name: `🎫｜${interaction.user.username}`,
                    type: ChannelType.GuildText,
                    permissionOverwrites: [
                        { id: interaction.guild.id, deny: [PermissionsBitField.Flags.ViewChannel] },
                        { id: interaction.user.id, allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages] },
                        { id: adminRoleId, allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages] }
                    ]
                });

                const customDesc = ticketMessages.get(key);
                const panelDesc = customDesc !== null && customDesc !== undefined
                    ? customDesc
                    : '発行ありがとうございます。担当者が来るのを今しばらくお待ちください。';

                const ticketEmbed = new EmbedBuilder()
                    .setTitle('📋 パネルでチケット発行')
                    .addFields(
                        { name: '発行者', value: `${interaction.user}` },
                        { name: 'メッセージ', value: panelDesc }
                    )
                    .setColor(0x9B59B6)
                    .setTimestamp();

                await channel.send({
                    content: `<@&${adminRoleId}>`,
                    embeds: [ticketEmbed],
                    components: [
                        new ActionRowBuilder().addComponents(
                            new ButtonBuilder().setCustomId('t_close').setLabel('チケットを閉じる').setStyle(ButtonStyle.Danger)
                        )
                    ]
                });

                await interaction.editReply({ content: `✅ チケットを作成しました: ${channel}` });

                const logEmbed = new EmbedBuilder()
                    .setTitle('🎫 チケット作成ログ')
                    .addFields(
                        { name: '使用者', value: `${interaction.user}`, inline: true },
                        { name: '使用コマンド', value: 'チケット作成ボタン', inline: true },
                        { name: '日時', value: `<t:${Math.floor(Date.now() / 1000)}:F>`, inline: false },
                        { name: 'チャンネル', value: `${channel}`, inline: false }
                    )
                    .setColor(0x3498DB)
                    .setTimestamp();
                sendLog(interaction.guild, logEmbed);
            } catch (e) {
                await interaction.editReply({ content: '❌ チャンネルの作成に失敗しました。' });
            }
            return;
        }

        // チケットを閉じるボタン
        if (customId === 't_close') {
            await interaction.reply({ content: 'チケットを2秒後に削除します...', flags: MessageFlags.Ephemeral });
            
            const logEmbed = new EmbedBuilder()
                .setTitle('🔒 チケット終了ログ')
                .addFields(
                    { name: '使用者', value: `${interaction.user}`, inline: true },
                    { name: '使用コマンド', value: 'チケットを閉じるボタン', inline: true },
                    { name: '日時', value: `<t:${Math.floor(Date.now() / 1000)}:F>`, inline: false },
                    { name: 'チャンネル', value: `**#${interaction.channel.name}**`, inline: false }
                )
                .setColor(0x607D8B)
                .setTimestamp();
            sendLog(interaction.guild, logEmbed);

            setTimeout(() => {
                interaction.channel.delete().catch(() => {});
            }, 2000);
            return;
        }

        // 通知登録解除ボタン
        if (customId === 'n_rem') {
            await db.collection('subscribers').doc(interaction.user.id).delete();
            return await interaction.update({ content: '🗑️ 通知登録を解除しました。', components: [] });
        }

        // キャンセル・中止ボタン全般
        if (customId === 'bulk_no') {
            return await interaction.update({ content: '操作をキャンセルしました。', components: [] });
        }
    }

    // 4. セレクトメニュー操作の処理
    if (interaction.isStringSelectMenu()) {
        if (interaction.customId === 'help_select') {
            const value = interaction.values[0];
            let helpText = '';

            if (value === 'h_verify') helpText = '**/verify**\n許可ユーザーが使用できます。ボタン付きの認証パネルを設置し、ユーザーが手軽にロールを獲得できるようにします。';
            if (value === 'h_ticket') helpText = '**/ticket**\n許可ユーザーが使用できます。ユーザー個別の問い合わせ用プライベートチャンネルを開設するパネルを設置します。';
            if (value === 'h_log') helpText = '**/log**\n許可ユーザーが使用できます。認証や一括削除のアクションが行われた際に送信されるログチャンネルの指定・解除を行います。';
            if (value === 'h_role') helpText = '**/role-confirmation**\n許可ユーザーが使用できます。対象のユーザーが現在持っている全ロールの一覧を表示します。';
            if (value === 'h_export') helpText = '**/export**\n許可ユーザーが使用できます。指定したチャンネルのメッセージを.txtファイルにエクスポートします。\nオプション: `channel` `limit(1〜)` `before` `after`';
            if (value === 'h_allow') helpText = '**/allow-user**\n【作成者専用】指定ユーザーにすべてのコマンドの使用を許可します。';
            if (value === 'h_deny') helpText = '**/deny-user**\n【作成者専用】指定ユーザーのコマンド使用許可を剥奪します。';

            return await interaction.update({ content: `📜 **ヘルプ詳細**\n\n${helpText}`, components: [interaction.message.components[0]] });
        }
    }
});

// --- Bot ログイン ---
client.login(process.env.DISCORD_TOKEN);
