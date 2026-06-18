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
// wsパッケージは不要になりました（HTTPポーリング方式に変更）

// --- Firebase 初期化 (設定・通知保存用) ---
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
});
const db = admin.firestore();

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

// ─── 地震通知モジュール ────────────────────────────────────────

const INTENSITY_LABEL = {
    '10': '1', '20': '2', '30': '3', '40': '4',
    '45': '5弱', '50': '5強', '55': '6弱', '60': '6強', '70': '7',
};

const INTENSITY_COLOR = {
    '1': 0x99CCFF, '2': 0x00AAFF, '3': 0x00DD00, '4': 0xFFFF00,
    '5弱': 0xFFAA00, '5強': 0xFF6600, '6弱': 0xFF2200, '6強': 0xCC0000, '7': 0x990000,
};

function getTsunamiLabel(code) {
    const labels = {
        'Unknown': '不明', 'None': 'なし', 'Checking': '調査中',
        'NonEffective': '若干の海面変動あり（被害なし）',
        'Watch': '津波注意報', 'Warning': '⚠️ 津波警報', 'MajorWarning': '🚨 大津波警報',
    };
    return labels[code] ?? code;
}

function buildEEWEmbed(data) {
    const intensity = INTENSITY_LABEL[data.maxIntensity] ?? '不明';
    const color = INTENSITY_COLOR[intensity] ?? 0xFF0000;
    return new EmbedBuilder()
        .setTitle('🚨 緊急地震速報')
        .setColor(color)
        .setDescription('**強い揺れに備えてください！**')
        .addFields(
            { name: '震源地', value: data.hypocenter?.name ?? '不明', inline: true },
            { name: '最大予測震度', value: `震度 ${intensity}`, inline: true },
            { name: 'マグニチュード', value: `M${data.magnitude ?? '不明'}`, inline: true },
            { name: '深さ', value: data.hypocenter?.depth != null ? `${data.hypocenter.depth} km` : '不明', inline: true },
            { name: '第N報', value: `第${data.serialNo ?? '?'}報${data.isFinal ? '（最終報）' : ''}`, inline: true },
        )
        .setTimestamp(data.originTime ? new Date(data.originTime) : new Date())
        .setFooter({ text: 'P2P地震情報 | 緊急地震速報' });
}

function buildQuakeEmbed(data) {
    const intensity = data.maxScale != null ? (INTENSITY_LABEL[String(data.maxScale)] ?? '不明') : '不明';
    const color = INTENSITY_COLOR[intensity] ?? 0x5555FF;
    const embed = new EmbedBuilder()
        .setTitle('🌏 地震情報')
        .setColor(color)
        .addFields(
            { name: '震源地', value: data.earthquake?.hypocenter?.name ?? '不明', inline: true },
            { name: '最大震度', value: `震度 ${intensity}`, inline: true },
            { name: 'マグニチュード', value: data.earthquake?.hypocenter?.magnitude != null ? `M${data.earthquake.hypocenter.magnitude}` : '不明', inline: true },
            { name: '深さ', value: data.earthquake?.hypocenter?.depth != null ? `${data.earthquake.hypocenter.depth} km` : '不明', inline: true },
            { name: '発生時刻', value: data.earthquake?.time ? `<t:${Math.floor(new Date(data.earthquake.time).getTime() / 1000)}:F>` : '不明', inline: false },
        )
        .setTimestamp()
        .setFooter({ text: 'P2P地震情報' });

    if (data.tsunami && data.tsunami !== 'None') {
        embed.addFields({ name: '🌊 津波', value: getTsunamiLabel(data.tsunami), inline: false });
    }
    return embed;
}

/**
 * 地震通知を開始する（HTTPポーリング方式）
 * RenderはWebSocket外向き接続が制限されるため、
 * p2pquake REST API を30秒ごとにポーリングして新着を検出します。
 * 通知先チャンネルIDは Firestore の earthquake_settings/{guildId} に保存
 */
function startEarthquakeMonitor() {
    const API_URL = 'https://api.p2pquake.net/v2/history?codes=551&codes=556&limit=5';
    const POLL_INTERVAL = 30_000; // 30秒ごと

    // 起動時刻（これ以前のデータは無視）
    const startedAt = Date.now();
    const seenIds = new Set();

    async function getNotifyChannels() {
        const snap = await db.collection('earthquake_settings').get();
        return snap.docs.map(d => d.data().channelId).filter(Boolean);
    }

    async function broadcast(embed) {
        const channelIds = await getNotifyChannels().catch(() => []);
        for (const channelId of channelIds) {
            const ch = await client.channels.fetch(channelId).catch(() => null);
            if (ch) await ch.send({ embeds: [embed] }).catch(console.error);
        }
    }

    async function poll() {
        try {
            const res = await fetch(API_URL);
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const items = await res.json();

            for (const data of items.reverse()) { // 古い順に処理
                if (seenIds.has(data.id)) continue;
                seenIds.add(data.id);

                // 起動前のデータはスキップ（初回ポーリング時の大量通知を防ぐ）
                const dataTime = new Date(data.time?.replace(/\//g, '-')).getTime();
                if (dataTime < startedAt - 60_000) continue; // 起動1分前より古いものは無視

                if (data.code === 551) {
                    // 地震情報
                    await broadcast(buildQuakeEmbed(data));
                } else if (data.code === 556) {
                    // 緊急地震速報（警報）
                    if (data.cancelled) continue;
                    await broadcast(buildEEWEmbed(data));
                }
            }
        } catch (err) {
            console.error('[地震監視] ポーリングエラー:', err.message);
        }
    }

    console.log('[地震監視] HTTPポーリング開始 (30秒間隔)');
    poll(); // 初回即実行
    setInterval(poll, POLL_INTERVAL);
}

// ─── スラッシュコマンド定義 ────────────────────────────────────

const commands = [
    // 1. 認証パネル作成
    new SlashCommandBuilder()
        .setName('verify')
        .setDescription('認証パネルを作成します')
        .addRoleOption(o => o.setName('role').setDescription('付与するロール').setRequired(true))
        .addStringOption(o => o.setName('title').setDescription('パネルのタイトル'))
        .addStringOption(o => o.setName('description').setDescription('パネルの説明文'))
        .setDefaultMemberPermissions(PermissionsBitField.Flags.ManageRoles),

    // 2. チケット作成パネル
    new SlashCommandBuilder()
        .setName('ticket')
        .setDescription('チケットパネルを作成します')
        .addRoleOption(o => o.setName('admin-role').setDescription('対応を行う管理ロール').setRequired(true))
        .addStringOption(o => o.setName('title').setDescription('パネルのタイトル'))
        .addStringOption(o => o.setName('description').setDescription('パネルの説明文'))
        .addStringOption(o => o.setName('panel-desc').setDescription('チケット作成時に送信されるメッセージ'))
        .setDefaultMemberPermissions(PermissionsBitField.Flags.ManageChannels),

    // 3. 一括削除
    new SlashCommandBuilder()
        .setName('delete')
        .setDescription('メッセージを一括削除します')
        .addIntegerOption(o => o.setName('amount').setDescription('件数(1-100)').setRequired(true))
        .setDefaultMemberPermissions(PermissionsBitField.Flags.ManageMessages),

    // 4. ログ設定・解除
    new SlashCommandBuilder()
        .setName('log')
        .setDescription('ログの送信先を設定または解除します')
        .addChannelOption(o => o.setName('channel').setDescription('送信先チャンネル（指定なしで設定解除）').setRequired(false))
        .setDefaultMemberPermissions(PermissionsBitField.Flags.Administrator),

    // 5. ロール付与
    new SlashCommandBuilder()
        .setName('give-role')
        .setDescription('指定したユーザーにロールを付与します')
        .addUserOption(o => o.setName('target').setDescription('対象ユーザー').setRequired(true))
        .addRoleOption(o => o.setName('role').setDescription('付与するロール').setRequired(true))
        .setDefaultMemberPermissions(PermissionsBitField.Flags.ManageRoles),

    // 6. ロール剥奪
    new SlashCommandBuilder()
        .setName('remove-role')
        .setDescription('指定したユーザーからロールを剥奪します')
        .addUserOption(o => o.setName('target').setDescription('対象ユーザー').setRequired(true))
        .addRoleOption(o => o.setName('role').setDescription('剥奪するロール').setRequired(true))
        .setDefaultMemberPermissions(PermissionsBitField.Flags.ManageRoles),

    // 7. ロール確認
    new SlashCommandBuilder()
        .setName('role-confirmation')
        .setDescription('指定ユーザーが所持しているロールの一覧を確認します')
        .addUserOption(o => o.setName('target').setDescription('確認対象のユーザー').setRequired(true))
        .setDefaultMemberPermissions(PermissionsBitField.Flags.ModerateMembers),

    // 8. 通知登録・解除
    new SlashCommandBuilder()
        .setName('receive-notifications')
        .setDescription('重要なお知らせの通知登録・解除を行います'),

    // 9. お知らせ送信
    new SlashCommandBuilder()
        .setName('notice')
        .setDescription('登録ユーザーにお知らせをDM送信します(管理者専用)')
        .addStringOption(o => o.setName('password').setDescription('認証パスワード').setRequired(true))
        .setDefaultMemberPermissions(PermissionsBitField.Flags.ManageRoles),

    // 10. 一斉送信
    new SlashCommandBuilder()
        .setName('broadcast')
        .setDescription('指定ロールの所持者に一斉DMを送信します(管理者専用)')
        .addRoleOption(o => o.setName('target-role').setDescription('送信対象のロール').setRequired(true))
        .addStringOption(o => o.setName('password').setDescription('認証パスワード').setRequired(true))
        .setDefaultMemberPermissions(PermissionsBitField.Flags.ManageRoles),

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
        )
        .setDefaultMemberPermissions(PermissionsBitField.Flags.ManageMessages),

    // 14. 地震通知設定 ★追加
    new SlashCommandBuilder()
        .setName('earthquake-setup')
        .setDescription('地震・緊急地震速報の通知チャンネルを設定または解除します')
        .addChannelOption(o =>
            o.setName('channel')
                .setDescription('通知先チャンネル（省略すると設定を解除）')
                .setRequired(false)
        )
        .setDefaultMemberPermissions(PermissionsBitField.Flags.ManageChannels),

].map(c => c.toJSON());

// --- Bot 起動イベント ---
client.once(Events.ClientReady, async () => {
    const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);

    try {
        await rest.put(Routes.applicationCommands(client.user.id), { body: commands });
        console.log('--- All 14 Commands Registered ---');
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

    // 地震通知モニター開始 ★追加
    startEarthquakeMonitor();

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
                    { label: '/earthquake-setup (地震通知設定)', value: 'h_earthquake' }, // ★追加
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

        // /earthquake-setup コマンド ★追加
        if (commandName === 'earthquake-setup') {
            await interaction.deferReply({ flags: MessageFlags.Ephemeral });
            const channel = options.getChannel('channel');
            const docRef = db.collection('earthquake_settings').doc(interaction.guild.id);

            if (channel) {
                await docRef.set({ channelId: channel.id, guildName: interaction.guild.name });
                await interaction.editReply(`✅ 地震・緊急地震速報の通知先を ${channel} に設定しました。`);

                sendLog(interaction.guild, new EmbedBuilder()
                    .setTitle('🌏 地震通知設定ログ')
                    .addFields(
                        { name: '設定者', value: `${interaction.user}`, inline: true },
                        { name: '通知先', value: `${channel}`, inline: true },
                        { name: '日時', value: `<t:${Math.floor(Date.now() / 1000)}:F>`, inline: false }
                    )
                    .setColor(0xFF6600)
                    .setTimestamp()
                );
            } else {
                const doc = await docRef.get();
                if (!doc.exists) return await interaction.editReply('❌ 現在、地震通知は設定されていません。');
                await docRef.delete();
                await interaction.editReply('🗑️ 地震通知の設定を解除しました。');
            }

            sendCommandLog(interaction, commandName);
            return;
        }
    }

    // 2. モーダル送信の処理
    if (interaction.isModalSubmit()) {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });

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

            if (url) dmEmbed.addFields({ name: 'URL', value: url });

            const members = (await interaction.guild.members.fetch()).filter(m => m.roles.cache.has(roleId) && !m.user.bot);
            let count = 0;

            for (const [, m] of members) {
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
                const panelDesc = customDesc != null ? customDesc : '発行ありがとうございます。担当者が来るのを今しばらくお待ちください。';

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

        if (customId === 'n_rem') {
            await db.collection('subscribers').doc(interaction.user.id).delete();
            return await interaction.update({ content: '🗑️ 通知登録を解除しました。', components: [] });
        }

        if (customId === 'bulk_no') {
            return await interaction.update({ content: '操作をキャンセルしました。', components: [] });
        }
    }

    // 4. セレクトメニュー操作の処理
    if (interaction.isStringSelectMenu()) {
        if (interaction.customId === 'help_select') {
            const value = interaction.values[0];
            let helpText = '';

            if (value === 'h_verify') helpText = '**/verify**\nロール管理権限が必要です。ボタン付きの認証パネルを設置し、ユーザーが手軽にロールを獲得できるようにします。';
            if (value === 'h_ticket') helpText = '**/ticket**\nチャンネル管理権限が必要です。ユーザー個別の問い合わせ用プライベートチャンネルを開設するパネルを設置します。';
            if (value === 'h_log') helpText = '**/log**\n管理者権限が必要です。認証や一括削除のアクションが行われた際に送信されるログチャンネルの指定・解除を行います。';
            if (value === 'h_role') helpText = '**/role-confirmation**\nモデレーター権限が必要です。対象のユーザーが現在持っている全ロールの一覧を表示します。';
            if (value === 'h_export') helpText = '**/export**\nメッセージ管理権限が必要です。指定したチャンネルのメッセージを.txtファイルにエクスポートします。\nオプション: `channel` `limit(1〜10000)` `before` `after`';
            // ★追加
            if (value === 'h_earthquake') helpText = '**/earthquake-setup**\nチャンネル管理権限が必要です。地震情報・緊急地震速報をリアルタイムで通知するチャンネルを設定します。\n`channel` を省略すると設定を解除します。\nデータ元: P2P地震情報API';

            return await interaction.update({ content: `📜 **ヘルプ詳細**\n\n${helpText}`, components: [interaction.message.components[0]] });
        }
    }
});

// --- Bot ログイン ---
client.login(process.env.DISCORD_TOKEN);
