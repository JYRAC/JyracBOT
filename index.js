'use strict';

require('dotenv').config();

const {
    Client,
    GatewayIntentBits,
    Partials,
    REST,
    Routes,
    SlashCommandBuilder,
    ChannelType,
    ActivityType,
    Events,
    EmbedBuilder,
} = require('discord.js');

const express = require('express');
const admin   = require('firebase-admin');

// ─── モジュール読み込み ────────────────────────────────────────
const { ACTIVITIES, PUBLIC_COMMANDS, MODAL_COMMANDS, OWNER_COMMANDS } = require('./config');
const { hasCommandAccess, sendCommandLog, sendLog } = require('./utils/permissions');
const { startEarthquakeMonitor }            = require('./utils/earthquake');
const { getVerifyPanelRoleId }               = require('./utils/verifyPanel');

const { handleAdminCommand }      = require('./commands/admin');
const { handleModerationCommand } = require('./commands/moderation');
const { handleMessagingCommand }  = require('./commands/messaging');
const { handleExportCommand }     = require('./commands/export');
const { handleEarthquakeCommand } = require('./commands/earthquake');
const { handleEntryMessageCommand, handleGuildMemberAdd } = require('./commands/entryMessage');
const { handleChangeNameCommand } = require('./commands/changeName');
const { handleAdjustmentCommand } = require('./commands/adjustment');

const { handleButton, handleModal, handleSelectMenu } = require('./interactions/handlers');
const { isCanvasAvailable } = require('./utils/map');

// ─── 起動時診断ログ ─────────────────────────────────────────────
// 地震発生を待たずに、起動直後のログで地図描画が可能かどうかを確認できるようにする。
// Renderのログタブで "[起動診断]" を検索すればすぐ分かる。
console.log(`[起動診断] Node.js: ${process.version} / platform: ${process.platform} / arch: ${process.arch}`);
console.log(`[起動診断] @napi-rs/canvas 利用可否: ${isCanvasAvailable() ? '✅ OK' : '❌ NG（地図は描画されません。上のエラーログを確認してください）'}`);

// ─── Firebase 初期化 ───────────────────────────────────────────
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
const db = admin.firestore();

// ─── セッションストア ──────────────────────────────────────────
const broadcastRoleMap = new Map(); // userId → roleId
const ticketMessages   = new Map(); // key → panelDesc

// ─── Discord Client ────────────────────────────────────────────
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMembers,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildMessageReactions,
    ],
    partials: [
        Partials.Message,
        Partials.Channel,
        Partials.Reaction,
    ],
});

// ─── スラッシュコマンド定義 ────────────────────────────────────
// ※ setDefaultMemberPermissions を廃止し、Firebase登録ユーザーなら誰でも利用可能
const commands = [
    new SlashCommandBuilder()
        .setName('verify')
        .setDescription('認証パネル（パネル＋ボタン形式）を作成します')
        .addRoleOption(o => o.setName('role').setDescription('付与するロール').setRequired(true))
        .addStringOption(o => o.setName('title').setDescription('パネルのタイトル'))
        .addStringOption(o => o.setName('description').setDescription('パネルの説明文')),

    new SlashCommandBuilder()
        .setName('unverify')
        .setDescription('ロール解除パネルを作成します')
        .addRoleOption(o => o.setName('role').setDescription('剥奪するロール').setRequired(true))
        .addStringOption(o => o.setName('title').setDescription('パネルのタイトル'))
        .addStringOption(o => o.setName('description').setDescription('パネルの説明文')),

    new SlashCommandBuilder()
        .setName('ticket')
        .setDescription('チケットパネルを作成します')
        .addRoleOption(o => o.setName('admin-role').setDescription('対応を行う管理ロール').setRequired(true))
        .setName('verifies')
        .setDescription('最大15ロール対応のリアクション式認証パネルを作成します（role-1が1番目の絵文字と同期）')
        .addRoleOption(o => o.setName('role-1').setDescription('1番目のリアクションに対応するロール').setRequired(true))
        .addRoleOption(o => o.setName('role-2').setDescription('2番目のリアクションに対応するロール'))
        .addRoleOption(o => o.setName('role-3').setDescription('3番目のリアクションに対応するロール'))
        .addRoleOption(o => o.setName('role-4').setDescription('4番目のリアクションに対応するロール'))
        .addRoleOption(o => o.setName('role-5').setDescription('5番目のリアクションに対応するロール'))
        .addRoleOption(o => o.setName('role-6').setDescription('6番目のリアクションに対応するロール'))
        .addRoleOption(o => o.setName('role-7').setDescription('7番目のリアクションに対応するロール'))
        .addRoleOption(o => o.setName('role-8').setDescription('8番目のリアクションに対応するロール'))
        .addRoleOption(o => o.setName('role-9').setDescription('9番目のリアクションに対応するロール'))
        .addRoleOption(o => o.setName('role-10').setDescription('10番目のリアクションに対応するロール'))
        .addRoleOption(o => o.setName('role-11').setDescription('11番目のリアクションに対応するロール'))
        .addRoleOption(o => o.setName('role-12').setDescription('12番目のリアクションに対応するロール'))
        .addRoleOption(o => o.setName('role-13').setDescription('13番目のリアクションに対応するロール'))
        .addRoleOption(o => o.setName('role-14').setDescription('14番目のリアクションに対応するロール'))
        .addRoleOption(o => o.setName('role-15').setDescription('15番目のリアクションに対応するロール'))
        .addStringOption(o => o.setName('title').setDescription('パネルのタイトル'))
        .addStringOption(o => o.setName('description').setDescription('パネルの説明文')),

    new SlashCommandBuilder()
        .setName('ticket')
        .setDescription('チケット機能（パネル設置・カテゴリー管理）')
        .addSubcommand(sub => sub
            .setName('panel')
            .setDescription('チケットパネルを設置します')
            .addRoleOption(o => o.setName('admin-role').setDescription('対応を行う管理ロール（既定値）').setRequired(true))
            .addStringOption(o => o.setName('title').setDescription('パネルのタイトル'))
            .addStringOption(o => o.setName('description').setDescription('パネルの説明文'))
            .addStringOption(o => o.setName('panel-desc').setDescription('チケット作成時に送信されるメッセージ（既定値）'))
        )
        .addSubcommand(sub => sub
            .setName('category-add')
            .setDescription('チケット作成時に選択できるカテゴリーを登録します')
            .addStringOption(o => o.setName('name').setDescription('カテゴリー名').setRequired(true))
            .addStringOption(o => o.setName('emoji').setDescription('カテゴリーに表示する絵文字').setRequired(true))
            .addRoleOption(o => o.setName('admin-role').setDescription('このカテゴリー専用の対応ロール（省略時はパネルの既定ロール）'))
            .addChannelOption(o => o.setName('parent').setDescription('チケットチャンネルの作成先カテゴリー').addChannelTypes(ChannelType.GuildCategory))
            .addStringOption(o => o.setName('panel-desc').setDescription('このカテゴリー専用のチケット内メッセージ（省略時はパネルの既定値）'))
        )
        .addSubcommand(sub => sub
            .setName('category-remove')
            .setDescription('登録済みのチケットカテゴリーを削除します')
            .addStringOption(o => o.setName('name').setDescription('削除するカテゴリー名').setRequired(true))
        )
        .addSubcommand(sub => sub
            .setName('category-list')
            .setDescription('登録済みのチケットカテゴリー一覧を表示します')
        ),

    new SlashCommandBuilder()
        .setName('delete')
        .setDescription('メッセージを一括削除します')
        .addIntegerOption(o => o.setName('amount').setDescription('件数(1-100)').setRequired(true).setMinValue(1).setMaxValue(100)),

    new SlashCommandBuilder()
        .setName('log')
        .setDescription('ログの送信先を設定または解除します')
        .addChannelOption(o => o.setName('channel').setDescription('送信先チャンネル（指定なしで設定解除）').setRequired(false)),

    new SlashCommandBuilder()
        .setName('give-role')
        .setDescription('指定したユーザーにロールを付与します')
        .addUserOption(o => o.setName('target').setDescription('対象ユーザー').setRequired(true))
        .addRoleOption(o => o.setName('role').setDescription('付与するロール').setRequired(true)),

    new SlashCommandBuilder()
        .setName('remove-role')
        .setDescription('指定したユーザーからロールを剥奪します')
        .addUserOption(o => o.setName('target').setDescription('対象ユーザー').setRequired(true))
        .addRoleOption(o => o.setName('role').setDescription('剥奪するロール').setRequired(true)),

    new SlashCommandBuilder()
        .setName('role-confirmation')
        .setDescription('指定ユーザーが所持しているロールの一覧を確認します')
        .addUserOption(o => o.setName('target').setDescription('確認対象のユーザー').setRequired(true)),

    new SlashCommandBuilder()
        .setName('entry-message')
        .setDescription('新規メンバー参加時に送信するDMメッセージを設定します'),

    new SlashCommandBuilder()
        .setName('change-name')
        .setDescription('名前変更パネルを作成します（ボタンを押すとモーダルで自分のニックネームを変更できます）')
        .addStringOption(o => o.setName('title').setDescription('パネルのタイトル'))
        .addStringOption(o => o.setName('description').setDescription('パネルの説明文'))
        .addStringOption(o => o.setName('modal-title').setDescription('ボタンを押した際に表示するモーダルのタイトル')),

    new SlashCommandBuilder()
        .setName('adjustment')
        .setDescription('日程調整パネル（調整さん風）を作成します'),

    new SlashCommandBuilder()
        .setName('receive-notifications')
        .setDescription('重要なお知らせの通知登録・解除を行います'),

    new SlashCommandBuilder()
        .setName('notice')
        .setDescription('登録ユーザーにお知らせをDM送信します(管理者専用)')
        .addStringOption(o => o.setName('password').setDescription('認証パスワード').setRequired(true)),

    new SlashCommandBuilder()
        .setName('broadcast')
        .setDescription('指定ロールの所持者に一斉DMを送信します(管理者専用)')
        .addRoleOption(o => o.setName('target-role').setDescription('送信対象のロール').setRequired(true))
        .addStringOption(o => o.setName('password').setDescription('認証パスワード').setRequired(true)),

    new SlashCommandBuilder()
        .setName('request')
        .setDescription('新規コマンドの作成依頼を送ります'),

    new SlashCommandBuilder()
        .setName('help')
        .setDescription('コマンドの一覧と詳細を表示します'),

    new SlashCommandBuilder()
        .setName('export')
        .setDescription('チャンネルのメッセージをテキストファイルにエクスポートします')
        .addChannelOption(o => o.setName('channel').setDescription('エクスポートするチャンネル（省略時: 現在のチャンネル）').setRequired(false))
        .addIntegerOption(o => o.setName('limit').setDescription('取得するメッセージ数（省略時: チャンネル全件）').setMinValue(1).setRequired(false))
        .addStringOption(o => o.setName('before').setDescription('このメッセージID以前のメッセージを取得').setRequired(false))
        .addStringOption(o => o.setName('after').setDescription('このメッセージID以降のメッセージを取得').setRequired(false)),

    new SlashCommandBuilder()
        .setName('earthquake-setup')
        .setDescription('地震・緊急地震速報の通知チャンネルを設定または解除します')
        .addChannelOption(o => o.setName('channel').setDescription('通知先チャンネル（省略すると設定を解除）').setRequired(false)),

    new SlashCommandBuilder()
        .setName('earthquake-test')
        .setDescription('地震通知の表示テストを行います（管理者専用）')
        .addStringOption(o =>
            o.setName('type')
                .setDescription('通知の種類')
                .setRequired(true)
                .addChoices(
                    { name: '🌏 震源・震度情報（確定報）',          value: 'quake' },
                    { name: '🚨 緊急地震速報（EEW）形式',           value: 'eew' },
                    { name: '▶️ 震度速報→震源情報→確定報 の連続テスト', value: 'sequence' },
                    { name: '🌊 津波警報・注意報',                  value: 'tsunami' },
                )
        )
        .addStringOption(o =>
            o.setName('location')
                .setDescription('震源地プリセット')
                .setRequired(false)
                .addChoices(
                    { name: '東京 (東京湾北部)',         value: 'tokyo' },
                    { name: '大阪 (大阪府南部)',         value: 'osaka' },
                    { name: '仙台 (宮城県沖)',           value: 'sendai' },
                    { name: '福岡 (福岡県西方沖)',       value: 'fukuoka' },
                    { name: '北海道 (胆振地方中東部)',   value: 'hokkaido' },
                    { name: '沖縄 (沖縄本島近海)',       value: 'okinawa' },
                )
        ),

    new SlashCommandBuilder()
        .setName('weather-setup')
        .setDescription('特務機関NERVの気象情報を自動通知するチャンネルを設定します')
        .addChannelOption(o => o.setName('channel')
            .setDescription('通知先チャンネル (省略すると設定を解除します)')
            .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
        ),

    new SlashCommandBuilder()
        .setName('grant-access')
        .setDescription('指定ユーザーに全コマンドの使用を許可します（オーナー専用）')
        .addUserOption(o => o.setName('target').setDescription('許可するユーザー').setRequired(true)),

    new SlashCommandBuilder()
        .setName('revoke-access')
        .setDescription('指定ユーザーのコマンド使用許可を解除します（オーナー専用）')
        .addUserOption(o => o.setName('target').setDescription('解除するユーザー').setRequired(true)),

    new SlashCommandBuilder()
        .setName('list-access')
        .setDescription('コマンド使用を許可しているユーザーの一覧を表示します（オーナー専用）'),

].map(c => c.toJSON());

// ─── Bot 起動イベント ──────────────────────────────────────────
client.once(Events.ClientReady, async () => {
    // const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
    try {
        // await rest.put(Routes.applicationCommands(client.user.id), { body: commands });
        console.log('--- All Commands Registered ---');
    } catch (error) {
        console.error(error);
    }

    setInterval(() => {
        client.user.setActivity(
            ACTIVITIES[Math.floor(Math.random() * ACTIVITIES.length)],
            { type: ActivityType.Custom }
        );
    }, 15000);

    startEarthquakeMonitor(client, db);
    console.log(`Logged in as ${client.user.tag}`);
});

// ─── Keep Alive (Render用) ─────────────────────────────────────
const app = express();
app.get('/', (req, res) => res.send('Bot is online!'));
app.get('/health', (req, res) => {
    const ready = client.isReady();
    res.status(ready ? 200 : 503).json({
        ready,
        ping: ready ? client.ws.ping : null,
        uptime: process.uptime(),
    });
});
app.listen(3000);

// ─── インタラクション受信 ──────────────────────────────────────
client.on(Events.InteractionCreate, async interaction => {

    // 1. スラッシュコマンド
    if (interaction.isChatInputCommand()) {
        const { commandName } = interaction;

        // オーナー専用コマンド（Firebase登録チェックも不要）
        if (OWNER_COMMANDS.includes(commandName)) {
            await handleAdminCommand(interaction, db);
            return;
        }

        // パブリックコマンド（誰でも使える）
        if (PUBLIC_COMMANDS.includes(commandName)) {
            if (await handleModerationCommand(interaction, db, ticketMessages)) return;
            if (await handleExportCommand(interaction, db)) return;
            if (await handleEarthquakeCommand(interaction, client, db)) return;
            if (await handleMessagingCommand(interaction, db, broadcastRoleMap)) return;
            if (await handleEntryMessageCommand(interaction, db)) return;
            if (await handleChangeNameCommand(interaction, db)) return;
            if (await handleAdjustmentCommand(interaction)) return;
            return;
        }

        // それ以外のコマンド: Firebase登録ユーザーのみ利用可能
        if (!MODAL_COMMANDS.includes(commandName)) {
            await interaction.deferReply({ flags: 64 }); // MessageFlags.Ephemeral
        }
        const allowed = await hasCommandAccess(interaction, db);
        if (!allowed) {
            const errMsg = { content: '❌ このコマンドを使用する権限がありません。\nBotオーナーにアクセス許可を申請してください。' };
            if (MODAL_COMMANDS.includes(commandName)) {
                await interaction.reply({ ...errMsg, flags: 64 });
            } else {
                await interaction.editReply(errMsg);
            }
            return;
        }

        // 各コマンドハンドラに委譲
        if (await handleModerationCommand(interaction, db, ticketMessages)) return;
        if (await handleExportCommand(interaction, db)) return;
        if (await handleEarthquakeCommand(interaction, client, db)) return;
        if (await handleMessagingCommand(interaction, db, broadcastRoleMap)) return;
        if (await handleEntryMessageCommand(interaction, db)) return;
        if (await handleChangeNameCommand(interaction, db)) return;
        if (await handleAdjustmentCommand(interaction)) return;
    }

    // 2. モーダル
    if (interaction.isModalSubmit()) {
        await handleModal(interaction, client, db, broadcastRoleMap);
        return;
    }

    // 3. ボタン
    if (interaction.isButton()) {
        await handleButton(interaction, db, ticketMessages);
        return;
    }

    // 4. セレクトメニュー
    if (interaction.isStringSelectMenu()) {
        await handleSelectMenu(interaction, db);
        return;
    }
});

// ─── 入室時DMメッセージ送信 ─────────────────────────────────────
// /entry-message で設定された内容を、新規メンバー参加時にDMで送信する
client.on(Events.GuildMemberAdd, async member => {
    await handleGuildMemberAdd(member, db);
});

// ─── 認証パネル（複数ロール・リアクション形式）────────────────
/**
 * リアクションからロールIDを解決する（絵文字が部分的にしか届いていない場合はfetchする）
 */
async function resolveVerifyRole(reaction, user) {
    if (user.bot) return null;
    try {
        if (reaction.partial) await reaction.fetch();
        if (reaction.message.partial) await reaction.message.fetch();
    } catch {
        return null;
    }

    const guild = reaction.message.guild;
    if (!guild) return null;

    const key = reaction.emoji.id ?? reaction.emoji.name;
    const roleId = await getVerifyPanelRoleId(db, reaction.message.id, key);
    if (!roleId) return null;

    return { guild, roleId };
}

client.on(Events.MessageReactionAdd, async (reaction, user) => {
    const resolved = await resolveVerifyRole(reaction, user);
    if (!resolved) return;
    const { guild, roleId } = resolved;

    try {
        const member = await guild.members.fetch(user.id);
        await member.roles.add(roleId);

        sendLog(guild, new EmbedBuilder()
            .setTitle('🔐 認証ログ（リアクション）')
            .addFields(
                { name: '使用者',     value: `${member}`,                                   inline: true },
                { name: '使用コマンド', value: '認証パネル（リアクション）',                    inline: true },
                { name: '日時',       value: `<t:${Math.floor(Date.now() / 1000)}:F>`,        inline: false },
                { name: '取得ロール', value: `<@&${roleId}>`,                                  inline: false }
            )
            .setColor(0x2ECC71)
            .setTimestamp(),
            db
        );
    } catch (e) {
        console.error('[認証パネル] ロール付与エラー:', e);
    }
});

client.on(Events.MessageReactionRemove, async (reaction, user) => {
    const resolved = await resolveVerifyRole(reaction, user);
    if (!resolved) return;
    const { guild, roleId } = resolved;

    try {
        const member = await guild.members.fetch(user.id);
        await member.roles.remove(roleId);
    } catch (e) {
        console.error('[認証パネル] ロール剥奪エラー:', e);
    }
});

client.on('debug', console.log);
client.on('warn', console.warn);
client.on('error', (err) => console.error('[client error]', err));
client.on('shardError', (err) => console.error('[shardError]', err));
client.on('shardDisconnect', (event, id) => console.error('[shardDisconnect]', id, event));

// ─── Bot ログイン ──────────────────────────────────────────────
fetch('https://discord.com/api/v10/gateway')
    .then(r => r.text())
    .then(t => console.log('[NETWORK TEST BODY]', t.slice(0, 500)))
    .catch(e => console.error('[NETWORK TEST FAILED]', e));

client.login(process.env.DISCORD_TOKEN);

client.login(process.env.DISCORD_TOKEN)
    .then(() => console.log('[LOGIN OK]'))
    .catch(err => console.error('[LOGIN REJECTED]', err));

process.on('unhandledRejection', (reason) => {
    console.error('[unhandledRejection]', reason);
});
process.on('uncaughtException', (err) => {
    console.error('[uncaughtException]', err);
});
