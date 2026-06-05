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
    Events
} = require('discord.js');

const {
    joinVoiceChannel,
    EndBehaviorType,
    getVoiceConnection,
    VoiceConnectionStatus,
} = require('@discordjs/voice');

const { google } = require('googleapis');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const express = require('express');
const admin = require('firebase-admin');
const fs = require('fs');
const path = require('path');
const prism = require('prism-media');

// ============================================================
// Firebase 初期化
// ============================================================
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
});
const db = admin.firestore();

// ============================================================
// Gemini クライアント初期化
// ============================================================
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const gemini = genAI.getGenerativeModel({ model: 'gemini-2.0-flash' });

// ============================================================
// メモリ保持用マップ
// ============================================================
const broadcastRoleMap = new Map(); // broadcast用
const ticketMessages   = new Map(); // ticket用
const oauthSessions    = new Map(); // state → { userId }  (OAuth用)
const userTokens       = new Map(); // userId → OAuth2Client (認証済みユーザー)
const recordings       = new Map(); // guildId → 録音セッション

// ============================================================
// Discord クライアント
// ============================================================
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMembers,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildVoiceStates, // ← 議事録録音に必要
    ]
});

// ============================================================
// 共通関数: ログ送信
// ============================================================
async function sendLog(guild, embed) {
    if (!guild) return;
    try {
        const logDoc = await db.collection('log_settings').doc(guild.id).get();
        if (!logDoc.exists) return;
        const channelId = logDoc.data().channelId;
        const logChannel = await guild.channels.fetch(channelId).catch(() => null);
        if (logChannel) await logChannel.send({ embeds: [embed] });
    } catch (e) {
        console.error("Log Error:", e);
    }
}

// ============================================================
// 共通関数: コマンド実行ログ送信
// ============================================================
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

// ============================================================
// Google OAuth2 クライアント生成
// ============================================================
function makeOAuthClient() {
    return new google.auth.OAuth2(
        process.env.GOOGLE_CLIENT_ID,
        process.env.GOOGLE_CLIENT_SECRET,
        process.env.GOOGLE_REDIRECT_URI   // 例: https://your-app.onrender.com/oauth/callback
    );
}

// ============================================================
// Botのアクティビティリスト
// ============================================================
const activities = [
    "JYRAC公式Instは'2024nsfproject'で検索！",
    "JYRAC公式Instは'Jyrac_official'で検索！",
    "お問い合わせはDiscordID: pitayakun7 まで",
    "広告募集中"
];

// ============================================================
// スラッシュコマンド定義 (全15コマンド)
// ============================================================
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

    // 13. 議事録ログイン (Google OAuth連携)
    new SlashCommandBuilder()
        .setName('minutes-login')
        .setDescription('議事録作成用のGoogleアカウントを連携します'),

    // 14. 議事録録音開始
    new SlashCommandBuilder()
        .setName('minutes-start')
        .setDescription('ボイスチャンネルの録音を開始し、議事録を自動作成します')
        .addStringOption(o =>
            o.setName('title')
             .setDescription('会議のタイトル（省略可）')
             .setRequired(false)
        )
        .setDefaultMemberPermissions(PermissionsBitField.Flags.MuteMembers),

    // 15. 議事録録音停止・生成
    new SlashCommandBuilder()
        .setName('minutes-stop')
        .setDescription('録音を停止し、議事録を生成してGoogle Docsに保存します')
        .setDefaultMemberPermissions(PermissionsBitField.Flags.MuteMembers),

].map(c => c.toJSON());

// ============================================================
// Bot 起動イベント
// ============================================================
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

// ============================================================
// Keep Alive (Render用) + Google OAuth コールバック
// ============================================================
const app = express();
app.get('/', (req, res) => res.send('Bot is online!'));

/**
 * Google OAuth コールバック
 * Google Cloud Console の「承認済みリダイレクトURI」に
 * GOOGLE_REDIRECT_URI (例: https://your-app.onrender.com/oauth/callback) を登録してください。
 */
app.get('/oauth/callback', async (req, res) => {
    const { code, state } = req.query;
    const session = oauthSessions.get(state);

    if (!session || !code) {
        return res.send('<h2 style="font-family:sans-serif">❌ 無効なセッションです。もう一度 /minutes-login を実行してください。</h2>');
    }

    oauthSessions.delete(state);

    try {
        const oauth2Client = makeOAuthClient();
        const { tokens } = await oauth2Client.getToken(code);
        oauth2Client.setCredentials(tokens);
        userTokens.set(session.userId, oauth2Client);

        // Discordにて連携完了をDM通知
        const user = await client.users.fetch(session.userId);
        await user.send('✅ **Googleアカウントの連携が完了しました！**\nボイスチャンネルに入室後、`/minutes-start` で録音を開始できます。');

        res.send(`
            <html><body style="font-family:sans-serif;text-align:center;padding:60px;background:#f9f9f9">
                <h2 style="color:#27ae60">✅ 連携完了！</h2>
                <p>Discordに戻って <strong>/minutes-start</strong> を実行してください。</p>
                <p style="color:#999;font-size:12px">このタブは自動的に閉じられます...</p>
                <script>setTimeout(()=>window.close(),3000)</script>
            </body></html>
        `);
    } catch (e) {
        console.error('OAuth callback error:', e);
        res.send('<h2 style="font-family:sans-serif">❌ 認証に失敗しました。再度お試しください。</h2>');
    }
});

app.listen(3000);

// ============================================================
// インタラクション受信
// ============================================================
client.on(Events.InteractionCreate, async interaction => {

    // ──────────────────────────────────────────────────────────
    // 1. スラッシュコマンドの処理
    // ──────────────────────────────────────────────────────────
    if (interaction.isChatInputCommand()) {
        const { commandName, options } = interaction;

        // ── /log ─────────────────────────────────────────────
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

        // ── /verify ──────────────────────────────────────────
        if (commandName === 'verify') {
            const role  = options.getRole('role');
            const title = options.getString('title') ?? '認証パネル';
            const desc  = options.getString('description') ?? '以下のボタンを押して認証を完了してください。';

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

        // ── /delete ──────────────────────────────────────────
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

        // ── /ticket ──────────────────────────────────────────
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

        // ── /give-role / /remove-role ─────────────────────────
        if (['give-role', 'remove-role'].includes(commandName)) {
            const member = options.getMember('target');
            const role   = options.getRole('role');

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
            return;
        }

        // ── /role-confirmation ────────────────────────────────
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

        // ── /receive-notifications ────────────────────────────
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

        // ── /notice / /broadcast ──────────────────────────────
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
                        new TextInputBuilder().setCustomId('dm_speaker').setLabel('発言者').setStyle(TextInputStyle.Short).setRequired(true)
                    ),
                    new ActionRowBuilder().addComponents(
                        new TextInputBuilder().setCustomId('dm_text').setLabel('送信するメッセージ内容').setStyle(TextInputStyle.Paragraph).setRequired(true)
                    ),
                    new ActionRowBuilder().addComponents(
                        new TextInputBuilder().setCustomId('dm_url').setLabel('URL（任意）').setStyle(TextInputStyle.Short).setRequired(false)
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
                    new TextInputBuilder().setCustomId('dm_text').setLabel('送信するメッセージ内容').setStyle(TextInputStyle.Paragraph).setRequired(true)
                )
            );

            await interaction.showModal(modal);
            sendCommandLog(interaction, commandName);
            return;
        }

        // ── /request ─────────────────────────────────────────
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

        // ── /help ─────────────────────────────────────────────
        if (commandName === 'help') {
            const select = new StringSelectMenuBuilder()
                .setCustomId('help_select')
                .setPlaceholder('詳細を見たいコマンドを選択')
                .addOptions([
                    { label: '/verify (認証)', value: 'h_verify' },
                    { label: '/ticket (サポート)', value: 'h_ticket' },
                    { label: '/log (管理ログ)', value: 'h_log' },
                    { label: '/role-confirmation (確認)', value: 'h_role' },
                    { label: '/minutes-login (議事録ログイン)', value: 'h_mlogin' },
                    { label: '/minutes-start (録音開始)', value: 'h_mstart' },
                    { label: '/minutes-stop (録音停止・生成)', value: 'h_mstop' },
                ]);

            await interaction.reply({
                content: '📜 **コマンドヘルプ**\n詳細を確認したい機能を選択してください。',
                components: [new ActionRowBuilder().addComponents(select)],
                flags: MessageFlags.Ephemeral
            });
            sendCommandLog(interaction, commandName);
            return;
        }

        // ── /minutes-login ────────────────────────────────────
        if (commandName === 'minutes-login') {
            await interaction.deferReply({ flags: MessageFlags.Ephemeral });

            if (userTokens.has(interaction.user.id)) {
                return await interaction.editReply('✅ すでにGoogleアカウントと連携済みです。\n再連携する場合は一度このコマンドを実行してURLを開き直してください。');
            }

            const state        = `${interaction.user.id}_${Date.now()}`;
            const oauth2Client = makeOAuthClient();

            const authUrl = oauth2Client.generateAuthUrl({
                access_type : 'offline',
                scope       : [
                    'https://www.googleapis.com/auth/documents',
                    'https://www.googleapis.com/auth/drive.file',
                ],
                state,
                prompt: 'consent',
            });

            oauthSessions.set(state, { userId: interaction.user.id });

            // 10分後にセッションを自動削除
            setTimeout(() => oauthSessions.delete(state), 10 * 60 * 1000);

            const embed = new EmbedBuilder()
                .setTitle('🔑 Googleアカウント連携')
                .setDescription(
                    '以下のリンクからGoogleアカウントと連携してください。\n' +
                    '連携完了後、このBotからDMでお知らせします。\n\n' +
                    `**[▶ こちらをクリックして連携](${authUrl})**\n\n` +
                    '> ⚠️ このURLはあなた専用です。他の人に共有しないでください。\n' +
                    '> ⏱️ このリンクは10分間有効です。'
                )
                .setColor(0x4285F4);

            sendCommandLog(interaction, commandName);
            return await interaction.editReply({ embeds: [embed] });
        }

        // ── /minutes-start ────────────────────────────────────
        if (commandName === 'minutes-start') {
            await interaction.deferReply({ flags: MessageFlags.Ephemeral });

            // ログイン確認
            if (!userTokens.has(interaction.user.id)) {
                return await interaction.editReply('❌ Googleアカウントが連携されていません。先に `/minutes-login` を実行してください。');
            }

            // VC参加確認
            const voiceChannel = interaction.member?.voice?.channel;
            if (!voiceChannel) {
                return await interaction.editReply('❌ ボイスチャンネルに参加してからコマンドを実行してください。');
            }

            // 二重録音チェック
            if (recordings.has(interaction.guild.id)) {
                return await interaction.editReply('⚠️ すでに録音中です。`/minutes-stop` で停止してください。');
            }

            const title = options.getString('title') ?? `会議_${new Date().toLocaleDateString('ja-JP')}`;

            try {
                // VC接続
                const connection = joinVoiceChannel({
                    channelId     : voiceChannel.id,
                    guildId       : interaction.guild.id,
                    adapterCreator: interaction.guild.voiceAdapterCreator,
                    selfDeaf      : false,
                    selfMute      : true,
                });

                const audioChunks  = []; // { userId, pcm } の配列
                const activeStreams = new Map();

                // メンバーが発話するたびに音声を受信
                connection.receiver.speaking.on('start', userId => {
                    if (activeStreams.has(userId)) return;

                    const opusStream = connection.receiver.subscribe(userId, {
                        end: { behavior: EndBehaviorType.AfterSilence, duration: 500 },
                    });

                    const decoder = new prism.opus.Decoder({ rate: 48000, channels: 2, frameSize: 960 });
                    const chunks  = [];

                    decoder.on('data', chunk => chunks.push(chunk));
                    decoder.on('end', () => {
                        if (chunks.length > 0) audioChunks.push({ userId, pcm: Buffer.concat(chunks) });
                        activeStreams.delete(userId);
                    });

                    opusStream.pipe(decoder);
                    activeStreams.set(userId, { opusStream, decoder });
                });

                recordings.set(interaction.guild.id, {
                    connection,
                    audioChunks,
                    activeStreams,
                    startTime   : Date.now(),
                    initiatorId : interaction.user.id,
                    title,
                    textChannel : interaction.channelId,
                });

                const embed = new EmbedBuilder()
                    .setTitle('🔴 録音開始')
                    .setDescription(`**${title}** の録音を開始しました。\n会議終了後に \`/minutes-stop\` を実行してください。`)
                    .addFields(
                        { name: 'チャンネル', value: voiceChannel.name, inline: true },
                        { name: '開始時刻', value: `<t:${Math.floor(Date.now() / 1000)}:T>`, inline: true }
                    )
                    .setColor(0xE74C3C)
                    .setTimestamp();

                sendCommandLog(interaction, commandName);
                return await interaction.editReply({ embeds: [embed] });

            } catch (e) {
                console.error('minutes-start error:', e);
                return await interaction.editReply('❌ ボイスチャンネルへの接続に失敗しました。BotにConnect権限があるか確認してください。');
            }
        }

        // ── /minutes-stop ─────────────────────────────────────
        if (commandName === 'minutes-stop') {
            await interaction.deferReply({ flags: MessageFlags.Ephemeral });

            const rec = recordings.get(interaction.guild.id);
            if (!rec) {
                return await interaction.editReply('❌ 現在録音中ではありません。');
            }

            // 録音セッション削除 & VC切断
            recordings.delete(interaction.guild.id);
            for (const [, { opusStream }] of rec.activeStreams) opusStream.destroy();
            rec.connection.destroy();

            const elapsed = Math.floor((Date.now() - rec.startTime) / 1000);
            const mins    = Math.floor(elapsed / 60);
            const secs    = elapsed % 60;

            await interaction.editReply(`⏹️ 録音を停止しました（録音時間: ${mins}分${secs}秒）\n🤖 Geminiが議事録を生成しています。しばらくお待ちください...`);

            try {
                // ─── Step 1: Gemini で音声を文字起こし ───────────────────────
                let transcript = '';

                if (rec.audioChunks.length === 0) {
                    transcript = '（録音データがありませんでした）';
                } else {
                    const combinedPcm = Buffer.concat(rec.audioChunks.map(c => c.pcm));
                    const audioBase64 = combinedPcm.toString('base64');

                    const transcriptResult = await gemini.generateContent([
                        {
                            inlineData: {
                                mimeType: 'audio/L16;rate=48000',
                                data    : audioBase64,
                            },
                        },
                        {
                            text: '以下の音声を日本語でできるだけ正確に文字起こしをしてください。発言が聞き取れない場合は[不明瞭]と記載してください。',
                        },
                    ]);

                    transcript = transcriptResult.response.text() || '（文字起こし結果なし）';
                }

                // ─── Step 2: Gemini で議事録を生成 ───────────────────────────
                const minutesResult = await gemini.generateContent([
                    {
                        text: `
あなたはプロの議事録作成者です。
以下の会議の文字起こしテキストをもとに、構造化された日本語の議事録を作成してください。

## 会議概要
- 会議名: ${rec.title}
- 日時: ${new Date(rec.startTime).toLocaleString('ja-JP')}
- 録音時間: ${mins}分${secs}秒

## 議題・討議内容
（主要な話題をまとめてください）

## 決定事項
（会議で決まったことを箇条書きで）

## アクションアイテム
（誰が何をするかを記載。不明な場合は「担当者未定」）

## 次回予定
（次のステップや会議の予定があれば記載）

---
# 文字起こしテキスト:
${transcript}
`,
                    },
                ]);

                const minutesText = minutesResult.response.text();

                // ─── Step 3: Google Docs に保存 ───────────────────────────────
                const oauth2Client = userTokens.get(rec.initiatorId);
                const docs  = google.docs({ version: 'v1', auth: oauth2Client });

                const docRes = await docs.documents.create({
                    requestBody: { title: `【議事録】${rec.title}` },
                });

                const documentId = docRes.data.documentId;

                await docs.documents.batchUpdate({
                    documentId,
                    requestBody: {
                        requests: [
                            {
                                insertText: {
                                    location: { index: 1 },
                                    text    : minutesText,
                                },
                            },
                        ],
                    },
                });

                const docUrl = `https://docs.google.com/document/d/${documentId}/edit`;

                // ─── Step 4: 結果をDiscordに通知 ──────────────────────────────
                const resultEmbed = new EmbedBuilder()
                    .setTitle('📄 議事録が作成されました')
                    .setDescription(`**${rec.title}** の議事録をGoogle Docsに保存しました。`)
                    .addFields(
                        { name: '録音時間', value: `${mins}分${secs}秒`, inline: true },
                        { name: '作成者', value: `<@${rec.initiatorId}>`, inline: true },
                        { name: '📎 Google Docs URL', value: `[こちらをクリック](${docUrl})`, inline: false }
                    )
                    .setColor(0x27AE60)
                    .setTimestamp();

                await interaction.editReply({ embeds: [resultEmbed] });

                // コマンドを実行したテキストチャンネルにも公開通知
                const textChannel = await interaction.guild.channels.fetch(rec.textChannel).catch(() => null);
                if (textChannel) await textChannel.send({ embeds: [resultEmbed] });

                // ログ送信
                sendLog(interaction.guild, new EmbedBuilder()
                    .setTitle('📝 議事録作成ログ')
                    .addFields(
                        { name: '実行者', value: `<@${rec.initiatorId}>`, inline: true },
                        { name: '会議名', value: rec.title, inline: true },
                        { name: '録音時間', value: `${mins}分${secs}秒`, inline: true },
                        { name: 'Docs URL', value: docUrl }
                    )
                    .setColor(0x27AE60)
                    .setTimestamp()
                );

            } catch (e) {
                console.error('minutes-stop error:', e);
                await interaction.editReply(
                    '❌ 議事録の生成中にエラーが発生しました。\n' +
                    '`GEMINI_API_KEY` と Google アカウント連携 (`/minutes-login`) を確認してください。\n\n' +
                    `エラー詳細: \`${e.message}\``
                );
            }

            sendCommandLog(interaction, commandName);
            return;
        }
    }

    // ──────────────────────────────────────────────────────────
    // 2. モーダル送信の処理
    // ──────────────────────────────────────────────────────────
    if (interaction.isModalSubmit()) {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });

        // 作成依頼
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

        // ロール宛て一斉DM (/broadcast)
        if (interaction.customId === 'broadcast_modal') {
            const roleId = broadcastRoleMap.get(interaction.user.id);
            if (!roleId) return await interaction.editReply('❌ セッションが切れました。もう一度コマンドからやり直してください。');

            broadcastRoleMap.delete(interaction.user.id);

            const speaker     = interaction.fields.getTextInputValue('dm_speaker');
            const textContent = interaction.fields.getTextInputValue('dm_text');
            const url         = interaction.fields.getTextInputValue('dm_url').trim();

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

    // ──────────────────────────────────────────────────────────
    // 3. ボタン操作の処理
    // ──────────────────────────────────────────────────────────
    if (interaction.isButton()) {
        const { customId } = interaction;

        // 認証ボタン
        if (customId.startsWith('v_role_')) {
            const roleId = customId.split('_')[2];
            await interaction.reply({ content: '認証を処理しています...', flags: MessageFlags.Ephemeral });

            try {
                await interaction.member.roles.add(roleId);
                await interaction.editReply({ content: '✅ 認証が完了しました！ロールを付与しました。' });

                sendLog(interaction.guild, new EmbedBuilder()
                    .setTitle('🔐 認証ログ')
                    .addFields(
                        { name: '使用者', value: `${interaction.user}`, inline: true },
                        { name: '使用コマンド', value: '認証ボタン', inline: true },
                        { name: '日時', value: `<t:${Math.floor(Date.now() / 1000)}:F>`, inline: false },
                        { name: '取得ロール', value: `<@&${roleId}>`, inline: false }
                    )
                    .setColor(0x2ECC71)
                    .setTimestamp()
                );
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
                sendLog(interaction.guild, new EmbedBuilder()
                    .setTitle('🗑️ メッセージ削除ログ')
                    .addFields(
                        { name: '使用者', value: `${interaction.user}`, inline: true },
                        { name: '使用コマンド', value: '/delete', inline: true },
                        { name: '日時', value: `<t:${Math.floor(Date.now() / 1000)}:F>`, inline: false },
                        { name: 'チャンネル', value: `**#${chName}**`, inline: true },
                        { name: '削除件数', value: `${amount}件`, inline: true }
                    )
                    .setColor(0xE74C3C)
                    .setTimestamp()
                );
            } catch (e) {
                console.error(e);
            }
            return;
        }

        // チケット作成ボタン
        if (customId.startsWith('tkt_')) {
            const parts      = customId.split('_');
            const adminRoleId = parts[1];
            const key         = parts.slice(2).join('_');
            await interaction.reply({ content: 'チケットチャンネルを作成しています...', flags: MessageFlags.Ephemeral });

            try {
                const channel = await interaction.guild.channels.create({
                    name: `🎫｜${interaction.user.username}`,
                    type: ChannelType.GuildText,
                    permissionOverwrites: [
                        { id: interaction.guild.id,  deny: [PermissionsBitField.Flags.ViewChannel] },
                        { id: interaction.user.id,   allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages] },
                        { id: adminRoleId,            allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages] }
                    ]
                });

                const customDesc = ticketMessages.get(key);
                const panelDesc  = (customDesc !== null && customDesc !== undefined)
                    ? customDesc
                    : '発行ありがとうございます。担当者が来るのを今しばらくお待ちください。';

                await channel.send({
                    content: `<@&${adminRoleId}>`,
                    embeds: [
                        new EmbedBuilder()
                            .setTitle('📋 パネルでチケット発行')
                            .addFields(
                                { name: '発行者', value: `${interaction.user}` },
                                { name: 'メッセージ', value: panelDesc }
                            )
                            .setColor(0x9B59B6)
                            .setTimestamp()
                    ],
                    components: [
                        new ActionRowBuilder().addComponents(
                            new ButtonBuilder().setCustomId('t_close').setLabel('チケットを閉じる').setStyle(ButtonStyle.Danger)
                        )
                    ]
                });

                await interaction.editReply({ content: `✅ チケットを作成しました: ${channel}` });

                sendLog(interaction.guild, new EmbedBuilder()
                    .setTitle('🎫 チケット作成ログ')
                    .addFields(
                        { name: '使用者', value: `${interaction.user}`, inline: true },
                        { name: '使用コマンド', value: 'チケット作成ボタン', inline: true },
                        { name: '日時', value: `<t:${Math.floor(Date.now() / 1000)}:F>`, inline: false },
                        { name: 'チャンネル', value: `${channel}`, inline: false }
                    )
                    .setColor(0x3498DB)
                    .setTimestamp()
                );
            } catch (e) {
                await interaction.editReply({ content: '❌ チャンネルの作成に失敗しました。' });
            }
            return;
        }

        // チケットを閉じるボタン
        if (customId === 't_close') {
            await interaction.reply({ content: 'チケットを2秒後に削除します...', flags: MessageFlags.Ephemeral });

            sendLog(interaction.guild, new EmbedBuilder()
                .setTitle('🔒 チケット終了ログ')
                .addFields(
                    { name: '使用者', value: `${interaction.user}`, inline: true },
                    { name: '使用コマンド', value: 'チケットを閉じるボタン', inline: true },
                    { name: '日時', value: `<t:${Math.floor(Date.now() / 1000)}:F>`, inline: false },
                    { name: 'チャンネル', value: `**#${interaction.channel.name}**`, inline: false }
                )
                .setColor(0x607D8B)
                .setTimestamp()
            );

            setTimeout(() => interaction.channel.delete().catch(() => {}), 2000);
            return;
        }

        // 通知登録解除ボタン
        if (customId === 'n_rem') {
            await db.collection('subscribers').doc(interaction.user.id).delete();
            return await interaction.update({ content: '🗑️ 通知登録を解除しました。', components: [] });
        }

        // キャンセル・中止ボタン
        if (customId === 'bulk_no') {
            return await interaction.update({ content: '操作をキャンセルしました。', components: [] });
        }
    }

    // ──────────────────────────────────────────────────────────
    // 4. セレクトメニュー操作の処理
    // ──────────────────────────────────────────────────────────
    if (interaction.isStringSelectMenu()) {
        if (interaction.customId === 'help_select') {
            const value = interaction.values[0];
            let helpText = '';

            if (value === 'h_verify')  helpText = '**/verify**\nロール管理権限が必要です。ボタン付きの認証パネルを設置し、ユーザーが手軽にロールを獲得できるようにします。';
            if (value === 'h_ticket')  helpText = '**/ticket**\nチャンネル管理権限が必要です。ユーザー個別の問い合わせ用プライベートチャンネルを開設するパネルを設置します。';
            if (value === 'h_log')     helpText = '**/log**\n管理者権限が必要です。認証や一括削除のアクションが行われた際に送信されるログチャンネルの指定・解除を行います。';
            if (value === 'h_role')    helpText = '**/role-confirmation**\nモデレーター権限が必要です。対象のユーザーが現在持っている全ロールの一覧を表示します。';
            if (value === 'h_mlogin')  helpText = '**/minutes-login**\n議事録機能を使うためのGoogleアカウント連携を行います。表示されたURLをブラウザで開いてください。';
            if (value === 'h_mstart')  helpText = '**/minutes-start**\nミュートメンバー権限が必要です。ボイスチャンネルに入室した状態で実行すると録音が開始されます。';
            if (value === 'h_mstop')   helpText = '**/minutes-stop**\nミュートメンバー権限が必要です。録音を停止してGemini AIが議事録を生成し、Google DocsのURLをチャンネルに投稿します。';

            return await interaction.update({
                content: `📜 **ヘルプ詳細**\n\n${helpText}`,
                components: [interaction.message.components[0]]
            });
        }
    }
});

// ============================================================
// Bot ログイン
// ============================================================
client.login(process.env.DISCORD_TOKEN);
