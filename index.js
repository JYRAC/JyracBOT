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
const sharp = require('sharp'); // npm install sharp
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

// --- 権限許可システム ---
const OWNER_ID = process.env.OWNER_ID; // .envに追加: OWNER_ID=あなたのDiscordユーザーID

/**
 * ユーザーがコマンドを使用できるか判定する
 * 条件: Discordの権限を持っている OR オーナーに許可されている
 * @param {import('discord.js').ChatInputCommandInteraction} interaction
 * @returns {Promise<boolean>}
 */
async function hasCommandAccess(interaction) {
    // 1. Discordのサーバー権限でそもそも使える場合はOK（オーナー・管理者など）
    //    setDefaultMemberPermissions で設定した権限を実際に持っているかチェック
    const cmd = interaction.guild.commands.cache.find(c => c.name === interaction.commandName)
               ?? (await interaction.guild.commands.fetch().then(cmds => cmds.find(c => c.name === interaction.commandName)).catch(() => null));

    if (cmd?.defaultMemberPermissions) {
        if (interaction.memberPermissions.has(cmd.defaultMemberPermissions)) return true;
    }

    // 2. Firebaseの許可リストに登録されているか確認
    try {
        const doc = await db.collection('command_access').doc(interaction.user.id).get();
        if (doc.exists && doc.data()?.allowed === true) return true;
    } catch (e) {
        console.error('[権限チェック] Firebaseエラー:', e);
    }

    return false;
}

// --- 🌟 観測点データの読み込み ---
let stationsData = {};
try {
    const rawData = fs.readFileSync(path.join(__dirname, 'stations.json'));
    stationsData = JSON.parse(rawData);
    console.log(`[システム] 観測点データ(stations.json)を読み込みました。`);
} catch (error) {
    console.warn(`[警告] stations.json が見つかりません。震度の描画はスキップされます。`);
}

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
// ─── 地震通知ユーティリティ ────────────────────────────────────

/**
 * 緯度・経度から国土地理院タイルのX/Y座標と、タイル内ピクセル位置を計算する
 * 出典: 国土地理院 地理院タイル https://maps.gsi.go.jp/development/ichiran.html
 */
function latLonToTileAndPixel(lat, lon, zoom) {
    const n = Math.pow(2, zoom);
    const latRad = lat * Math.PI / 180;
    const tileX = Math.floor((lon + 180) / 360 * n);
    const tileY = Math.floor(
        (1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2 * n
    );
    // タイル内ピクセル位置（0〜255）
    const pixX = Math.floor(((lon + 180) / 360 * n - tileX) * 256);
    const pixY = Math.floor(
        ((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2 * n - tileY) * 256
    );
    return { tileX, tileY, pixX, pixY };
}

/**
 * 国土地理院淡色地図タイル1枚をfetchしてBufferで返す
 * https://cyberjapandata.gsi.go.jp/xyz/pale/{z}/{x}/{y}.png
 * 出典: 国土地理院 地理院タイル
 */
async function fetchGSITile(zoom, x, y) {
    const url = `https://cyberjapandata.gsi.go.jp/xyz/blank/${zoom}/${x}/${y}.png`;
    const res = await fetch(url, {
        headers: { 'User-Agent': 'JYRACDiscordBot/1.0 (earthquake-notify)' }
    });
    if (!res.ok) throw new Error(`GSI Tile ${res.status}: ${url}`);
    return Buffer.from(await res.arrayBuffer());
}

/**
 * 国土地理院タイルを 3×3 枚合成し、震源地を画像中央にクロップして返す。
 * zoom=7 を使用することで日本周辺のみが表示される。
 * 震源地ピクセルを中心に extract() でクロップするため、常に真ん中に✕が表示される。
 * 出典: 国土地理院 地理院タイル (https://maps.gsi.go.jp/development/ichiran.html)
 */
/**
 * 震度のSVGスタンプ（角丸の四角形に文字）を生成する
 */
function getScaleSvg(scale) {
    const scaleMap = {
        '10': { text: '1', bg: '#99CCFF', c: '#000000' },
        '20': { text: '2', bg: '#00AAFF', c: '#FFFFFF' },
        '30': { text: '3', bg: '#00DD00', c: '#FFFFFF' },
        '40': { text: '4', bg: '#FFFF00', c: '#000000' },
        '45': { text: '5弱', bg: '#FFAA00', c: '#000000' },
        '50': { text: '5強', bg: '#FF6600', c: '#FFFFFF' },
        '55': { text: '6弱', bg: '#FF2200', c: '#FFFFFF' },
        '60': { text: '6強', bg: '#CC0000', c: '#FFFFFF' },
        '70': { text: '7', bg: '#990000', c: '#FFFFFF' }
    };
    const s = scaleMap[String(scale)];
    if (!s) return null;
    return Buffer.from(
        `<svg width="24" height="24" xmlns="http://www.w3.org/2000/svg">
            <rect width="24" height="24" rx="4" fill="${s.bg}" stroke="#ffffff" stroke-width="1.5"/>
            <text x="12" y="17" font-family="sans-serif" font-size="13" font-weight="bold" fill="${s.c}" text-anchor="middle">${s.text}</text>
        </svg>`
    );
}

/**
 * 国土地理院タイルを 3×3 枚合成し、震源地を中心にクロップして返す。
 * ★修正: 引数に points (各観測点の震度データ配列) を追加
 */
async function buildMapAttachment(lat, lon, points = null) {
    if (lat == null || lon == null || lat === -200 || lon === -200) return null;

    const zoom = 8;   // zoom=9: 3×3タイルで約2°×1.7°（震源地周辺のみ表示）
    const TILE = 256;
    const HALF = 1;   // 中心タイルから上下左右1枚 = 3×3
    const GRID = HALF * 2 + 1;

    const { tileX: cx, tileY: cy, pixX: markerPixX, pixY: markerPixY }
        = latLonToTileAndPixel(lat, lon, zoom);

    // 3×3 タイルを並列取得
    const fetches = [];
    for (let dy = -HALF; dy <= HALF; dy++) {
        for (let dx = -HALF; dx <= HALF; dx++) {
            const gx = dx + HALF; // 0〜2
            const gy = dy + HALF;
            fetches.push(
                fetchGSITile(zoom, cx + dx, cy + dy)
                    .then(buf => ({ gx, gy, buf }))
                    .catch(() => null)
            );
        }
    }
    const tiles = await Promise.all(fetches);
    const canvasSize = TILE * GRID; // 768×768

    const composites = tiles
        .filter(t => t !== null)
        .map(({ gx, gy, buf }) => ({ input: buf, left: gx * TILE, top: gy * TILE }));

    // --- 🌟 各観測点の震度スタンプを地図上に配置 ---
    if (points && Array.isArray(points) && typeof stationsData !== 'undefined') {
        const drawnCoords = new Set(); // 同じ場所に重なって描画されるのを防ぐ

        for (const pt of points) {
            // 1. JSONから観測点名(addr)や都道府県(pref)で緯度経度を柔軟に検索
            let st = null;
            if (stationsData[pt.pref] && stationsData[pt.pref][pt.addr]) {
                st = stationsData[pt.pref][pt.addr]; // 例: 北海道 -> 根室市
            } else if (stationsData[pt.addr]) {
                st = stationsData[pt.addr]; // 例: 根室市（直接記述の場合）
            } else if (stationsData[pt.pref] && stationsData[pt.pref].lat != null) {
                st = stationsData[pt.pref]; // 市町村が見つからなければ、県の代表座標に置く
            }

            if (!st || st.lat == null || st.lon == null) continue;

            // 既に同じ場所にスタンプを押したかチェック
            const coordKey = `${st.lat}_${st.lon}`;
            if (drawnCoords.has(coordKey)) continue;

            // 観測点の緯度経度を、現在のズームレベルでの絶対タイル座標に変換
            const { tileX: px, tileY: py, pixX: pPixX, pixY: pPixY } = latLonToTileAndPixel(st.lat, st.lon, zoom);
            
            // 中心タイル(cx, cy)を基準とした、3x3キャンバス内での相対的な位置を計算
            const diffX = px - (cx - HALF);
            const diffY = py - (cy - HALF);

            // 2. キャンバス（3x3のダウンロードした地図）の範囲内に収まっている場合のみスタンプを押す
            if (diffX >= 0 && diffX < GRID && diffY >= 0 && diffY < GRID) {
                const absX = diffX * TILE + pPixX;
                const absY = diffY * TILE + pPixY;
                
                const svgBuf = getScaleSvg(pt.scale);
                if (svgBuf) {
                    composites.push({
                        input: svgBuf,
                        left: Math.max(0, Math.min(canvasSize - 24, Math.floor(absX - 12))),
                        top: Math.max(0, Math.min(canvasSize - 24, Math.floor(absY - 12))),
                    });
                    drawnCoords.add(coordKey);
                }
            } else {
                // 枠外だった場合は、なぜ出ないのかをコンソールに表示する
                console.log(`[地図生成] ${pt.pref}${pt.addr} は画面の枠外のためスタンプをスキップしました`);
            }
        }
    }


    // 震源地の絶対ピクセル座標（3×3キャンバス内）
    const markerAbsX = HALF * TILE + markerPixX;
    const markerAbsY = HALF * TILE + markerPixY;

    // 赤✕ SVG（白縁取り付き）
    const ARM = 16, SW = 5, PAD = 12;
    const sz  = (ARM + PAD) * 2;
    const h   = sz / 2;
    const markerSvg = Buffer.from(
        `<svg width="${sz}" height="${sz}" xmlns="http://www.w3.org/2000/svg">` +
        `<line x1="${h-ARM}" y1="${h-ARM}" x2="${h+ARM}" y2="${h+ARM}" stroke="white" stroke-width="${SW+4}" stroke-linecap="round"/>` +
        `<line x1="${h+ARM}" y1="${h-ARM}" x2="${h-ARM}" y2="${h+ARM}" stroke="white" stroke-width="${SW+4}" stroke-linecap="round"/>` +
        `<line x1="${h-ARM}" y1="${h-ARM}" x2="${h+ARM}" y2="${h+ARM}" stroke="#EE0000" stroke-width="${SW}" stroke-linecap="round"/>` +
        `<line x1="${h+ARM}" y1="${h-ARM}" x2="${h-ARM}" y2="${h+ARM}" stroke="#EE0000" stroke-width="${SW}" stroke-linecap="round"/>` +
        `</svg>`
    );
    composites.push({
        input: markerSvg,
        left: Math.max(0, Math.min(canvasSize - sz, Math.floor(markerAbsX - h))),
        top:  Math.max(0, Math.min(canvasSize - sz, Math.floor(markerAbsY - h))),
    });

    const OUT_W = canvasSize, OUT_H = 500;
    const cropLeft = Math.max(0, Math.min(canvasSize - OUT_W, Math.floor(markerAbsX - OUT_W / 2)));
    const cropTop  = Math.max(0, Math.min(canvasSize - OUT_H, Math.floor(markerAbsY - OUT_H / 2)));

    return await sharp({
        create: { width: canvasSize, height: canvasSize, channels: 4, background: { r: 220, g: 220, b: 220, alpha: 1 } }
    })
        .composite(composites)
        .extract({ left: cropLeft, top: cropTop, width: OUT_W, height: OUT_H })
        .png()
        .toBuffer();
}
/**
 * JST形式 "YYYY/MM/DD HH:mm:ss" → Unix秒 に変換
 */
function jstToUnix(jstStr) {
    if (!jstStr) return null;
    const s = jstStr.replace(
        /^(\d{4})\/(\d{2})\/(\d{2}) (\d{2}:\d{2}:\d{2})$/,
        '$1-$2-$3T$4+09:00'
    );
    const ts = Math.floor(new Date(s).getTime() / 1000);
    return isNaN(ts) ? null : ts;
}

/**
 * JST形式 "YYYY/MM/DD HH:mm:ss" → Unixミリ秒 に変換（ポーリング時刻比較用）
 */
function jstToUnixMs(jstStr) {
    if (!jstStr) return null;
    const s = jstStr.replace(
        /^(\d{4})\/(\d{2})\/(\d{2}) (\d{2}:\d{2}:\d{2}(?:\.\d+)?)$/,
        '$1-$2-$3T$4+09:00'
    );
    const ts = new Date(s).getTime();
    return isNaN(ts) ? null : ts;
}

// 津波イベント追跡マップ: eventKey → 報数
// eventKey = 発表元の発表日時（issue.time の地震発生時刻部分）
const tsunamiEventCounter = new Map();

// EEW追跡マップ: eventKey(originTime+震源地名) → 最終serial
// 同じ地震について地震情報(code:551)が来たら finishedEEWEvents に追加し、以降のEEWは「最終報」として送信して終了する
const eewLastSerial = new Map();
const finishedEEWEvents = new Set();

/**
 * EEWのイベントキーを生成（originTime + 震源地名で同一地震を識別）
 */
function getEEWEventKey(data) {
    const origin = data.earthquake?.originTime ?? '';
    const name = data.earthquake?.hypocenter?.name ?? '';
    return `${origin}__${name}`;
}

/**
 * 地震情報(551)のイベントキーを生成（同じ方式で対応するEEWイベントを探す）
 */
function getQuakeEventKey(data) {
    const time = data.earthquake?.time ?? '';
    const name = data.earthquake?.hypocenter?.name ?? '';
    return `${time}__${name}`;
}

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

/**
 * EEW(緊急地震速報)のEmbedを生成
 * @param {object} data - code:556のデータ
 * @param {boolean} isLastReport - この地震について確定情報(地震情報/code:551)が
 *                                  既に届いている場合は true（最終報として表示）
 */
function buildEEWEmbed(data, isLastReport = false) {
    // EEW(code:556) のフィールドパス: data.earthquake.hypocenter, data.issue.serial
    const hypo = data.earthquake?.hypocenter ?? {};
    const rawScale = data.areas?.[0]?.scaleFrom;
    const intensity = (rawScale != null && rawScale !== -1)
        ? (INTENSITY_LABEL[String(Math.floor(rawScale))] ?? '予測震度あり')
        : '不明';
    const color = INTENSITY_COLOR[intensity] ?? 0xFF0000;
    const serial = data.issue?.serial ?? '?';
    const originTs = jstToUnix(data.earthquake?.originTime);
    const serialLabel = isLastReport ? `第${serial}報（最終）` : `第${serial}報`;

    const embed = new EmbedBuilder()
        .setTitle('🚨 緊急地震速報')
        .setColor(color)
        .setDescription(isLastReport
            ? '**地震が発生しました。今後は地震情報をご確認ください。**'
            : '**強い揺れに備えてください！**')
        .addFields(
            { name: '震源地', value: hypo.name ?? '不明', inline: true },
            { name: '最大予測震度', value: intensity !== '不明' ? `震度 ${intensity}` : '不明', inline: true },
            { name: 'マグニチュード', value: (hypo.magnitude != null && hypo.magnitude !== -1) ? `M${hypo.magnitude}` : '不明', inline: true },
            { name: '深さ', value: (hypo.depth != null && hypo.depth !== -1) ? `${Math.floor(hypo.depth)} km` : '不明', inline: true },
            { name: '第N報', value: serialLabel, inline: true },
        )
        .setTimestamp(originTs ? new Date(originTs * 1000) : new Date())
        .setFooter({ text: 'P2P地震情報 | 緊急地震速報' });

    return embed;
}

function buildQuakeEmbed(data) {
    const hypo = data.earthquake?.hypocenter ?? {};
    const rawScale = data.earthquake?.maxScale;
    const intensity = (rawScale != null && rawScale !== -1)
        ? (INTENSITY_LABEL[String(rawScale)] ?? '不明')
        : '不明';
    const color = INTENSITY_COLOR[intensity] ?? 0x5555FF;

    const quakeTs = jstToUnix(data.earthquake?.time);
    const quakeTimeStr = quakeTs ? `<t:${quakeTs}:F>` : '不明';

    const embed = new EmbedBuilder()
        .setTitle('🌏 地震情報')
        .setColor(color)
        .addFields(
            { name: '震源地', value: hypo.name ?? '不明', inline: true },
            { name: '最大震度', value: intensity !== '不明' ? `震度 ${intensity}` : '不明', inline: true },
            { name: 'マグニチュード', value: (hypo.magnitude != null && hypo.magnitude !== -1) ? `M${hypo.magnitude}` : '不明', inline: true },
            { name: '深さ', value: (hypo.depth != null && hypo.depth !== -1) ? `${hypo.depth} km` : '不明', inline: true },
            { name: '発生時刻', value: quakeTimeStr, inline: false },
        )
        .setTimestamp()
        .setFooter({ text: 'P2P地震情報' });

    // 津波情報
    const tsunami = data.earthquake?.domesticTsunami;
    if (tsunami && tsunami !== 'None') {
        embed.addFields({ name: '🌊 国内津波', value: getTsunamiLabel(tsunami), inline: false });
    }

    // 震源地図は broadcast() 側で buildMapAttachment() を使って生成

    return embed;
}

/**
 * 津波情報 Embed を生成（第◯報付き）
 * @param {object} data - code:552 のデータ
 * @param {number} reportNo - 報数
 */
function buildTsunamiEmbed(data, reportNo) {
    const isCancelled = data.cancelled === true;
    const issueTs = jstToUnix(data.issue?.time);
    const issueTimeStr = issueTs ? `<t:${issueTs}:F>` : (data.issue?.time ?? '不明');

    const embed = new EmbedBuilder()
        .setTitle(isCancelled ? '🌊 津波予報 解除' : `🌊 津波予報 第${reportNo}報`)
        .setColor(isCancelled ? 0x00AAFF : 0xFF6600)
        .addFields(
            { name: '発表時刻', value: issueTimeStr, inline: true },
            { name: '発表元', value: data.issue?.source ?? '気象庁', inline: true },
        )
        .setTimestamp()
        .setFooter({ text: 'P2P地震情報 | 津波予報' });

    if (!isCancelled && Array.isArray(data.areas) && data.areas.length > 0) {
        // 警報レベルでグループ化して表示
        const gradeLabel = {
            'MajorWarning': '🚨 大津波警報',
            'Warning':      '⚠️ 津波警報',
            'Watch':        '🔵 津波注意報',
            'Unknown':      '❓ 不明',
        };
        const groups = {};
        for (const area of data.areas) {
            const label = gradeLabel[area.grade] ?? area.grade;
            if (!groups[label]) groups[label] = [];
            groups[label].push(area.name);
        }
        for (const [label, names] of Object.entries(groups)) {
            // Discord Embed フィールドの value は 1024文字まで
            const value = names.join('、');
            embed.addFields({ name: label, value: value.slice(0, 1024), inline: false });
        }
    } else if (isCancelled) {
        embed.setDescription('津波予報がすべて解除されました。');
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
    const API_URL = 'https://api.p2pquake.net/v2/history?codes=551&codes=552&codes=556&limit=10';
    const POLL_INTERVAL = 30_000; // 30秒ごと

    // 起動時刻（これ以前のデータは無視）
    const startedAt = Date.now();
    const seenIds = new Set();

    async function getNotifyChannels() {
        const snap = await db.collection('earthquake_settings').get();
        return snap.docs.map(d => d.data().channelId).filter(Boolean);
    }

    // lat/lon を受け取り、地図画像を生成して添付する
    async function broadcast(embed, lat, lon) {
        const channelIds = await getNotifyChannels().catch(() => []);

        // 地図画像を生成（失敗しても通知本文は送る）
        let attachment = null;
        if (lat != null && lon != null) {
            const buf = await buildMapAttachment(lat, lon).catch(e => {
                console.error('[地図生成エラー]', e.message);
                return null;
            });
            if (buf) {
                attachment = new AttachmentBuilder(buf, { name: 'map.png' });
                embed.setImage('attachment://map.png');
            }
        }

        for (const channelId of channelIds) {
            const ch = await client.channels.fetch(channelId).catch(() => null);
            if (!ch) continue;
            const payload = { embeds: [embed] };
            if (attachment) payload.files = [attachment];
            await ch.send(payload).catch(console.error);
        }
    }

    async function poll() {
        try {
            const res = await fetch(API_URL);
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const items = await res.json();

            for (const data of items.reverse()) {
                if (seenIds.has(data.id)) continue;
                seenIds.add(data.id);

                const dataTime = jstToUnixMs(data.time);
                if (dataTime !== null && dataTime < startedAt - 60_000) continue;

                if (data.code === 551) {
                    // 地震情報: 震源座標を渡す
                    const hypo = data.earthquake?.hypocenter ?? {};
                   await broadcast(buildQuakeEmbed(data), hypo.latitude, hypo.longitude, data.points);

                    // この地震に対応するEEW追跡があれば「終了」マークを付ける
                    // （以後その地震のEEW速報は来ても再通知しない）
                    const quakeKey = getQuakeEventKey(data);
                    finishedEEWEvents.add(quakeKey);
                    if (finishedEEWEvents.size > 50) {
                        finishedEEWEvents.delete(finishedEEWEvents.values().next().value);
                    }

                } else if (data.code === 552) {
                    // 津波予報: 報数を追跡（震源座標なし）
                    const eventKey = data.issue?.time ?? data.id;
                    const reportNo = (tsunamiEventCounter.get(eventKey) ?? 0) + 1;
                    tsunamiEventCounter.set(eventKey, reportNo);
                    if (tsunamiEventCounter.size > 50) {
                        tsunamiEventCounter.delete(tsunamiEventCounter.keys().next().value);
                    }
                    await broadcast(buildTsunamiEmbed(data, reportNo), null, null);

                } else if (data.code === 556) {
                    // 緊急地震速報: 震源座標を渡す
                    if (data.cancelled) continue;

                    const eewKey = getEEWEventKey(data);
                    // 既に地震情報(551)を受信済みのイベントは打ち切り（再通知しない）
                    if (finishedEEWEvents.has(eewKey)) continue;

                    eewLastSerial.set(eewKey, data.issue?.serial ?? 0);
                    if (eewLastSerial.size > 50) {
                        eewLastSerial.delete(eewLastSerial.keys().next().value);
                    }

                    const hypo = data.earthquake?.hypocenter ?? {};
                    await broadcast(buildEEWEmbed(data, false), hypo.latitude, hypo.longitude);
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

// ─── 気象庁 津波詳細情報モジュール（到達予想時刻・高さ・実況） ──────────────
// P2P地震情報には津波の「到達予想時刻」「予想の高さ」「実況」が含まれないため、
// 気象庁が無料公開しているAtomフィード(PULL型)経由でVTSE41電文を直接取得する。
// 出典: 気象庁 防災情報XMLフォーマット形式電文（PULL型） https://xml.kishou.go.jp/xmlpull.html

const JMA_EQVOL_FEED = 'https://www.data.jma.go.jp/developer/xml/feed/eqvol.xml';

// 簡易XMLタグ抽出（正規表現ベース。属性付きタグにも対応）
function xmlTag(xml, tagName) {
    const m = xml.match(new RegExp(`<${tagName}(?:\\s[^>]*)?>([\\s\\S]*?)</${tagName}>`));
    return m ? m[1].trim() : null;
}
function xmlTagAll(xml, tagName) {
    const re = new RegExp(`<${tagName}(?:\\s[^>]*)?>([\\s\\S]*?)</${tagName}>`, 'g');
    const out = [];
    let m;
    while ((m = re.exec(xml)) !== null) out.push(m[1].trim());
    return out;
}
function xmlAttr(tagXml, attrName) {
    const m = tagXml.match(new RegExp(`${attrName}="([^"]*)"`));
    return m ? m[1] : null;
}
// <Item>...</Item> ブロックを丸ごと抽出（ネストタグ込み）
function xmlBlocks(xml, tagName) {
    const re = new RegExp(`<${tagName}(?:\\s[^>]*)?>[\\s\\S]*?</${tagName}>`, 'g');
    return xml.match(re) ?? [];
}

const tsunamiGradeLabelJMA = {
    '大津波警報': '🚨 大津波警報',
    '津波警報':   '⚠️ 津波警報',
    '津波注意報': '🔵 津波注意報',
};

/**
 * VTSE41（津波警報・注意報・予報）XML電文をパースしてDiscord Embedを生成
 */
function parseTsunamiXML(xmlText, reportNo) {
    const isCancel = /<InfoType>取消<\/InfoType>/.test(xmlText);
    const reportDateTime = xmlTag(xmlText, 'ReportDateTime');
    const headline = xmlTag(xmlText, 'Headline')?.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

    const embed = new EmbedBuilder()
        .setColor(isCancel ? 0x00AAFF : 0xFF3300)
        .setFooter({ text: '気象庁 津波警報・注意報・予報 (VTSE41)' })
        .setTimestamp();

    if (isCancel) {
        embed.setTitle('🌊 津波警報・注意報 解除')
             .setDescription(headline || '津波警報・注意報がすべて解除されました。');
        return embed;
    }

    embed.setTitle(`🌊 津波警報・注意報・予報 第${reportNo}報`);
    if (headline) embed.setDescription(headline);

    // 発表時刻
    if (reportDateTime) {
        const ts = jstToUnix(reportDateTime.replace('T', ' ').replace(/\+09:00$/, '').replace(/-/g, '/'));
        embed.addFields({ name: '発表時刻', value: ts ? `<t:${ts}:F>` : reportDateTime, inline: false });
    }

    // <Item> ごとに 予報区・グレード・高さ・到達予想時刻 / 実況 を取得
    const items = xmlBlocks(xmlText, 'Item');
    const lines = [];

    for (const item of items.slice(0, 15)) { // Discordフィールド数制限を考慮し最大15件
        const areaName = xmlTag(item, 'Name');
        const grade = xmlTag(item, 'Category')
            ? xmlTag(xmlTag(item, 'Category') ?? '', 'Kind') ?? null
            : null;
        // Categoryブロック内のKind/Nameを再取得（入れ子構造のため個別抽出）
        const categoryBlock = (item.match(/<Category>[\s\S]*?<\/Category>/) ?? [''])[0];
        const kindName = xmlTag(categoryBlock, 'Name'); // 例: 大津波警報 / 津波警報 / 津波注意報

        // 予想される高さ（MaxHeight内のTsunamiHeight）
        const maxHeightBlock = (item.match(/<MaxHeight>[\s\S]*?<\/MaxHeight>/) ?? [''])[0];
        const heightTagMatch = maxHeightBlock.match(/<jmx_eb:TsunamiHeight[^>]*description="([^"]*)"[^>]*\/?>/);
        const heightDesc = heightTagMatch ? heightTagMatch[1] : null;

        // 到達予想時刻（ArrivalTime）
        const arrivalTime = xmlTag(item, 'ArrivalTime');
        // 既に到達中/到達確認（Condition）
        const condition = xmlTag(item, 'Condition');

        if (!areaName) continue;

        const gradeLabel = tsunamiGradeLabelJMA[kindName] ?? kindName ?? '津波情報';
        let line = `**${areaName}**（${gradeLabel}）`;
        if (heightDesc) line += `\n　予想の高さ: **${heightDesc}**`;
        if (condition) {
            line += `\n　状況: ${condition}`;
        } else if (arrivalTime) {
            const ts = jstToUnix(arrivalTime.replace('T', ' ').replace(/\+09:00$/, '').replace(/-/g, '/'));
            line += `\n　到達予想時刻: ${ts ? `<t:${ts}:t>` : arrivalTime}`;
        }
        lines.push(line);
    }

    if (lines.length > 0) {
        // 4000文字制限を考慮して分割
        let buf = '';
        let fieldIdx = 1;
        for (const line of lines) {
            if ((buf + '\n\n' + line).length > 1000) {
                embed.addFields({ name: `対象地域 ${fieldIdx}`, value: buf, inline: false });
                buf = line;
                fieldIdx++;
            } else {
                buf = buf ? `${buf}\n\n${line}` : line;
            }
        }
        if (buf) embed.addFields({ name: fieldIdx === 1 ? '対象地域' : `対象地域 ${fieldIdx}`, value: buf, inline: false });
    }

    // 津波観測（実況）情報があれば追加
    const obsBlocks = xmlBlocks(xmlText, 'Observation');
    if (obsBlocks.length > 0) {
        const obsLines = [];
        for (const obsXml of obsBlocks) {
            const stations = xmlBlocks(obsXml, 'Station');
            for (const st of stations.slice(0, 10)) {
                const stName = xmlTag(st, 'Name');
                const maxH = (st.match(/<MaxHeight>[\s\S]*?<\/MaxHeight>/) ?? [''])[0];
                const hMatch = maxH.match(/<jmx_eb:TsunamiHeight[^>]*description="([^"]*)"[^>]*\/?>/);
                const hDesc = hMatch ? hMatch[1] : null;
                const obsTime = xmlTag(maxH, 'DateTime');
                if (stName && hDesc) {
                    const ts = obsTime ? jstToUnix(obsTime.replace('T', ' ').replace(/\+09:00$/, '').replace(/-/g, '/')) : null;
                    obsLines.push(`**${stName}**: ${hDesc}${ts ? `（<t:${ts}:t> 観測）` : ''}`);
                }
            }
        }
        if (obsLines.length > 0) {
            embed.addFields({ name: '🌊 観測実況（到達後の実測値）', value: obsLines.join('\n').slice(0, 1024), inline: false });
        }
    }

    return embed;
}

/**
 * 気象庁の地震火山Atomフィードをポーリングし、
 * 津波警報・注意報・予報（VTSE41）のXMLを検出してDiscordに詳細通知する。
 */
// ─── 気象情報通知モジュール ────────────────────────────────────

function startWeatherMonitor() {
    // ★ ここにNERVの情報を取得していたRSSのURLを入力してください
    const RSS_URL = 'https://unnerv.jp/@UN_NERV.rss'; 
    const POLL_INTERVAL = 60_000; // 60秒ごとに確認

    const seenItems = new Set();
    const startedAt = Date.now();

    async function getNotifyChannels() {
        const snap = await db.collection('weather_settings').get();
        return snap.docs.map(d => d.data().channelId).filter(Boolean);
    }

    async function poll() {
        try {
            const res = await fetch(RSS_URL);
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const xmlText = await res.text();

            // <item>タグを抽出
            const items = xmlText.match(/<item>[\s\S]*?<\/item>/g) || [];

            // 古い順に処理して順番通りに通知する
            for (const item of items.reverse()) {
                const guidMatch = item.match(/<guid[^>]*>([\s\S]*?)<\/guid>/);
                const titleMatch = item.match(/<title>([\s\S]*?)<\/title>/);
                const descMatch = item.match(/<description>([\s\S]*?)<\/description>/);
                const linkMatch = item.match(/<link>([\s\S]*?)<\/link>/);
                const pubDateMatch = item.match(/<pubDate>([\s\S]*?)<\/pubDate>/);

                const guid = guidMatch ? guidMatch[1].trim() : null;
                // 重複チェック
                if (!guid || seenItems.has(guid)) continue;
                seenItems.add(guid);

                // 起動前の古い情報を無視
                const pubDate = pubDateMatch ? pubDateMatch[1].trim() : null;
                const pubTsMs = pubDate ? new Date(pubDate).getTime() : Date.now();
                if (pubTsMs < startedAt - 60_000) continue; 

                const title = titleMatch ? titleMatch[1].trim() : '気象情報';
                let description = descMatch ? descMatch[1] : '';
                const link = linkMatch ? linkMatch[1].trim() : null;

                // --- 🌟 画像URLの抽出 ---
                let imageUrl = null;
                const imgMatch = description.match(/<img[^>]+src="([^">]+)"/);
                const enclosureMatch = item.match(/<enclosure[^>]+url="([^">]+)"/);
                
                if (imgMatch) {
                    imageUrl = imgMatch[1];
                } else if (enclosureMatch) {
                    imageUrl = enclosureMatch[1];
                }

                // --- 🌟 情報を抜き出す処理 ---
                let area = "全国";
                const areaMatch = title.match(/【(.*?(?:都|道|府|県|地方|地域|管内))\s/) || description.match(/【(.*?(?:都|道|府|県|地方|地域|管内))\s/); 
                if (areaMatch) {
                    area = areaMatch[1];
                }

                // 不要なHTMLタグやハッシュタグの除去
                description = description
                    .replace(/&lt;a[^&]*&gt;/gi, '')
                    .replace(/&lt;\/a&gt;/gi, '')
                    .replace(/&lt;[^&]*&gt;/gi, '')
                    .replace(/&amp;/g, '&')
                    .replace(/<[^>]+>/g, '') // 通常のHTMLタグも消す
                    .replace(/#[^\s]+/g, '') 
                    .trim();

                // フィルタリング処理
                const isWeatherRelated = title.includes('気象') || description.includes('気象') || title.includes('警報') || title.includes('注意報');
                if (!isWeatherRelated) {
                    continue; 
                }

                // --- 🌟 日本標準時(JST)のフォーマット作成 ---
                const d = pubTsMs ? new Date(pubTsMs) : new Date();
                const formatter = new Intl.DateTimeFormat('ja-JP', {
                    timeZone: 'Asia/Tokyo',
                    year: 'numeric', month: '2-digit', day: '2-digit',
                    hour: '2-digit', minute: '2-digit'
                });
                const formattedDate = formatter.format(d).replace(/\//g, '/');

                // --- 🌟 Embed生成 ---
                const embed = new EmbedBuilder()
                    .setTitle(`🌦️ NERV 気象情報`)
                    .setDescription(`# ${area}\n\n${description.slice(0, 1000)}`)
                    .setColor(0x2B90D9)
                    .addFields(
                        { name: '対象地域', value: `**${area}**`, inline: true },
                        { name: '警報・注意報', value: `**⚠️ 下部画像を参照**`, inline: true },
                        { name: '\u200b', value: '\u200b', inline: true }, // 段落合わせの空欄
                        { name: '警戒レベル', value: `**⚠️ 下部画像を参照**`, inline: true },
                        { name: '発表日時 (JST)', value: `**${formattedDate}**`, inline: true },
                        { name: '\u200b', value: '\u200b', inline: true }
                    )
                    .setURL(link || null)
                    .setFooter({ text: '特務機関NERV (@UN_NERV) | データ取得: RSS' });
                
                if (imageUrl) {
                    embed.setImage(imageUrl);
                }

                // 設定されている全てのチャンネルへ配信
                const channelIds = await getNotifyChannels().catch(() => []);
                for (const channelId of channelIds) {
                    const ch = await client.channels.fetch(channelId).catch(() => null);
                    if (!ch) continue;
                    await ch.send({ embeds: [embed] }).catch(console.error);
                }
            }
        } catch (err) {
            console.error('[気象情報監視] ポーリングエラー:', err.message);
        }
    }

    console.log('[気象情報監視] HTTPポーリング開始 (60秒間隔)');
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

    // 15. 疑似地震テスト ★追加
    new SlashCommandBuilder()
        .setName('earthquake-test')
        .setDescription('地震通知の表示テストを行います（管理者専用）')
        .addStringOption(o =>
            o.setName('type')
                .setDescription('通知の種類')
                .setRequired(true)
                .addChoices(
                    { name: '🌏 地震情報のみ', value: 'quake' },
                    { name: '🚨 EEW→（30秒後）地震情報 の連続テスト', value: 'sequence' },
                    { name: '🚨 緊急地震速報 (EEW) のみ', value: 'eew' },
                    { name: '🌊 津波予報（P2P簡易版）', value: 'tsunami' },
                    { name: '🌊 津波警報・注意報（気象庁詳細版）', value: 'tsunami_jma' },
                )
        )
        .addStringOption(o =>
            o.setName('location')
                .setDescription('震源地プリセット')
                .setRequired(false)
                .addChoices(
                    { name: '東京 (東京湾北部)', value: 'tokyo' },
                    { name: '大阪 (大阪府南部)', value: 'osaka' },
                    { name: '仙台 (宮城県沖)', value: 'sendai' },
                    { name: '福岡 (福岡県西方沖)', value: 'fukuoka' },
                    { name: '北海道 (胆振地方中東部)', value: 'hokkaido' },
                    { name: '沖縄 (沖縄本島近海)', value: 'okinawa' },
                )
        )
        .setDefaultMemberPermissions(PermissionsBitField.Flags.ManageChannels),

    // 16. NERV気象情報検索 ★追加
    // 16. NERV気象情報自動通知設定
        new SlashCommandBuilder()
            .setName('weather-setup')
            .setDescription('特務機関NERVの気象情報を自動通知するチャンネルを設定します')
            .addChannelOption(o => o.setName('channel')
                .setDescription('通知先チャンネル (省略すると設定を解除します)')
                .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
            )
            .setDefaultMemberPermissions(PermissionsBitField.Flags.ManageChannels),

    // 17. コマンド使用許可付与（オーナー専用）
    new SlashCommandBuilder()
        .setName('grant-access')
        .setDescription('指定ユーザーに全コマンドの使用を許可します（オーナー専用）')
        .addUserOption(o => o.setName('target').setDescription('許可するユーザー').setRequired(true)),

    // 18. コマンド使用許可解除（オーナー専用）
    new SlashCommandBuilder()
        .setName('revoke-access')
        .setDescription('指定ユーザーのコマンド使用許可を解除します（オーナー専用）')
        .addUserOption(o => o.setName('target').setDescription('解除するユーザー').setRequired(true)),

    // 19. コマンド使用許可一覧（オーナー専用）
    new SlashCommandBuilder()
        .setName('list-access')
        .setDescription('コマンド使用を許可しているユーザーの一覧を表示します（オーナー専用）'),

].map(c => c.toJSON());

// --- Bot 起動イベント ---
client.once(Events.ClientReady, async () => {
    const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);

    try {
        await rest.put(Routes.applicationCommands(client.user.id), { body: commands });
        console.log('--- All 19 Commands Registered ---');
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
    startWeatherMonitor();

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

        // ─── オーナー専用コマンド（権限チェック前に処理） ───────────────
        if (['grant-access', 'revoke-access', 'list-access'].includes(commandName)) {
            // オーナーIDが未設定、またはオーナー本人でない場合は拒否
            if (!OWNER_ID || interaction.user.id !== OWNER_ID) {
                return await interaction.reply({
                    content: '❌ このコマンドはボットオーナーのみ実行できます。',
                    flags: MessageFlags.Ephemeral
                });
            }

            await interaction.deferReply({ flags: MessageFlags.Ephemeral });

            if (commandName === 'grant-access') {
                const target = options.getUser('target');
                await db.collection('command_access').doc(target.id).set({
                    allowed: true,
                    username: target.username,
                    grantedBy: interaction.user.id,
                    grantedAt: new Date()
                });

                const logEmbed = new EmbedBuilder()
                    .setTitle('🔓 コマンド許可ログ')
                    .addFields(
                        { name: '操作者', value: `${interaction.user}`, inline: true },
                        { name: '対象ユーザー', value: `${target} (${target.username})`, inline: true },
                        { name: '操作', value: '許可付与', inline: true },
                        { name: '日時', value: `<t:${Math.floor(Date.now() / 1000)}:F>`, inline: false }
                    )
                    .setColor(0x2ECC71)
                    .setTimestamp();
                sendLog(interaction.guild, logEmbed);

                return await interaction.editReply(`✅ **${target.username}** にコマンド使用許可を付与しました。`);
            }

            if (commandName === 'revoke-access') {
                const target = options.getUser('target');
                const doc = await db.collection('command_access').doc(target.id).get();

                if (!doc.exists || !doc.data()?.allowed) {
                    return await interaction.editReply(`❌ **${target.username}** はコマンド許可リストに登録されていません。`);
                }

                await db.collection('command_access').doc(target.id).delete();

                const logEmbed = new EmbedBuilder()
                    .setTitle('🔒 コマンド許可解除ログ')
                    .addFields(
                        { name: '操作者', value: `${interaction.user}`, inline: true },
                        { name: '対象ユーザー', value: `${target} (${target.username})`, inline: true },
                        { name: '操作', value: '許可解除', inline: true },
                        { name: '日時', value: `<t:${Math.floor(Date.now() / 1000)}:F>`, inline: false }
                    )
                    .setColor(0xE74C3C)
                    .setTimestamp();
                sendLog(interaction.guild, logEmbed);

                return await interaction.editReply(`✅ **${target.username}** のコマンド使用許可を解除しました。`);
            }

            if (commandName === 'list-access') {
                const snap = await db.collection('command_access').where('allowed', '==', true).get();

                if (snap.empty) {
                    return await interaction.editReply('📋 現在、コマンド使用を許可しているユーザーはいません。');
                }

                const lines = snap.docs.map(d => {
                    const data = d.data();
                    const ts = data.grantedAt?.toDate
                        ? Math.floor(data.grantedAt.toDate().getTime() / 1000)
                        : null;
                    const timeStr = ts ? `<t:${ts}:f>` : '不明';
                    return `・**${data.username ?? d.id}** (ID: \`${d.id}\`) — 付与日時: ${timeStr}`;
                });

                const embed = new EmbedBuilder()
                    .setTitle('📋 コマンド使用許可ユーザー一覧')
                    .setDescription(lines.join('\n'))
                    .setColor(0x3498DB)
                    .setTimestamp();

                return await interaction.editReply({ embeds: [embed] });
            }
        }

        // ─── 通常コマンドの権限チェック ────────────────────────────────
        // setDefaultMemberPermissions が設定されているコマンドは
        // Discord権限 OR Firebase許可のどちらかを満たす必要がある
        const NO_PERMISSION_COMMANDS = [
            'log', 'verify', 'delete', 'ticket', 'give-role', 'remove-role',
            'role-confirmation', 'notice', 'broadcast', 'export',
            'earthquake-setup', 'earthquake-test', 'weather-setup'
        ];

        if (NO_PERMISSION_COMMANDS.includes(commandName)) {
            const allowed = await hasCommandAccess(interaction);
            if (!allowed) {
                return await interaction.reply({
                    content: '❌ このコマンドを使用する権限がありません。\nサーバー管理者またはボットオーナーに許可を申請してください。',
                    flags: MessageFlags.Ephemeral
                });
            }
        }
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
                    { label: '/earthquake-setup (地震通知設定)', value: 'h_earthquake' },
                    { label: '/earthquake-test (疑似地震テスト)', value: 'h_eqtest' }, // ★追加
                    { label: '/weather-nerv (NERV気象情報)', value: 'h_nerv' }, // ★追加
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

        // /earthquake-test コマンド ★追加
        if (commandName === 'earthquake-test') {
            await interaction.deferReply({ flags: MessageFlags.Ephemeral });

            // 震源地プリセット
            const LOCATIONS = {
                tokyo:    { name: '東京湾北部',       lat: 35.6762, lon: 139.6503, mag: 7.3, depth: 40  },
                osaka:    { name: '大阪府南部',       lat: 34.6937, lon: 135.5023, mag: 6.5, depth: 15  },
                sendai:   { name: '宮城県沖',         lat: 38.2682, lon: 141.4694, mag: 7.8, depth: 60  },
                fukuoka:  { name: '福岡県西方沖',     lat: 33.5904, lon: 130.4017, mag: 6.2, depth: 10  },
                hokkaido: { name: '胆振地方中東部',   lat: 42.6864, lon: 142.0060, mag: 6.7, depth: 37  },
                okinawa:  { name: '沖縄本島近海',     lat: 26.2124, lon: 127.6792, mag: 5.8, depth: 20  },
            };

            const locKey = options.getString('location') ?? Object.keys(LOCATIONS)[Math.floor(Math.random() * 6)];
            const loc = LOCATIONS[locKey];
            const type = options.getString('type');

            // 通知先チャンネルを解決
            const snap = await db.collection('earthquake_settings').doc(interaction.guild.id).get();
            const notifyChannelId = snap.exists ? snap.data().channelId : null;
            const targetChannel = notifyChannelId
                ? await client.channels.fetch(notifyChannelId).catch(() => null)
                : interaction.channel;

            if (!targetChannel) {
                await interaction.editReply('❌ 通知チャンネルを取得できませんでした。');
                sendCommandLog(interaction, commandName);
                return;
            }

            const nowJST = () => new Date().toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' })
                                          .replace(/\//g, '/').replace(',', '');

            // 共通: Embedに地図を添付して送信するヘルパー
            async function sendWithMap(embed, lat, lon) {
                const payload = { embeds: [embed] };
                if (lat != null && lon != null) {
                    const buf = await buildMapAttachment(lat, lon).catch(() => null);
                    if (buf) {
                        const attachment = new AttachmentBuilder(buf, { name: 'map.png' });
                        embed.setImage('attachment://map.png');
                        payload.files = [attachment];
                    }
                }
                await targetChannel.send(payload).catch(console.error);
            }

            // 疑似 EEW データ生成
            function makeFakeEEW(serial) {
                return {
                    earthquake: {
                        originTime: nowJST(),
                        hypocenter: {
                            name:      loc.name,
                            latitude:  loc.lat,
                            longitude: loc.lon,
                            depth:     loc.depth,
                            magnitude: loc.mag,
                        },
                    },
                    issue: { serial },
                    areas: [{ scaleFrom: 50 }],
                    cancelled: false,
                };
            }

            // 疑似 地震情報（確定報）データ生成
            function makeFakeQuake() {
                return {
                    earthquake: {
                        time: nowJST(),
                        hypocenter: {
                            name: loc.name,
                            latitude:  loc.lat,
                            longitude: loc.lon,
                            depth:     loc.depth,
                            magnitude: loc.mag,
                        },
                        maxScale: 50, // 震度5強
                        domesticTsunami: 'None',
                    },
                };
            }

            if (type === 'quake') {
                const embed = buildQuakeEmbed(makeFakeQuake());
                await sendWithMap(embed, loc.lat, loc.lon);
                await interaction.editReply(`✅ **#${targetChannel.name}** にテスト通知（地震情報）を送信しました。\n震源: ${loc.name} (${loc.lat}, ${loc.lon})`);

            } else if (type === 'eew') {
                const embed = buildEEWEmbed(makeFakeEEW(1));
                await sendWithMap(embed, loc.lat, loc.lon);
                await interaction.editReply(`✅ **#${targetChannel.name}** にテスト通知（EEW）を送信しました。\n震源: ${loc.name} (${loc.lat}, ${loc.lon})`);

            } else if (type === 'sequence') {
                // ★ EEW(第1報) → 5秒後 EEW(第2報) → 合計約30秒後に地震情報（確定報）を流す連続テスト
                await interaction.editReply(`▶️ **#${targetChannel.name}** で地震通知シーケンス（EEW→30秒後に確定情報）を開始します。\n震源: ${loc.name} (${loc.lat}, ${loc.lon})`);

                // 第1報（すぐ送信）
                await sendWithMap(buildEEWEmbed(makeFakeEEW(1)), loc.lat, loc.lon);

                // 第2報（10秒後）
                setTimeout(async () => {
                    await sendWithMap(buildEEWEmbed(makeFakeEEW(2)), loc.lat, loc.lon);
                }, 10_000);

                // 第3報（20秒後）
                setTimeout(async () => {
                    await sendWithMap(buildEEWEmbed(makeFakeEEW(3)), loc.lat, loc.lon);
                }, 20_000);

                // 確定の地震情報（30秒後）
                setTimeout(async () => {
                    await sendWithMap(buildQuakeEmbed(makeFakeQuake()), loc.lat, loc.lon);
                }, 30_000);

            } else if (type === 'tsunami') {
                // 津波予報の疑似データ（P2P簡易版）
                const fakeData = {
                    cancelled: false,
                    issue: {
                        time: nowJST(),
                        source: '気象庁（テスト）',
                    },
                    areas: [
                        { grade: 'Warning',      name: '三陸沿岸' },
                        { grade: 'Warning',      name: '福島県' },
                        { grade: 'Watch',        name: '茨城県' },
                        { grade: 'Watch',        name: '千葉県外房' },
                    ],
                };
                const embed = buildTsunamiEmbed(fakeData, 1);
                await targetChannel.send({ embeds: [embed] }).catch(console.error);
                await interaction.editReply(`✅ **#${targetChannel.name}** にテスト通知（津波予報・簡易版）を送信しました。`);

            } else if (type === 'tsunami_jma') {
                // 津波警報・注意報の疑似データ（気象庁詳細版: 到達予想時刻・高さ・実況つき）
                const nowTs = Math.floor(Date.now() / 1000);
                const fakeEmbed = new EmbedBuilder()
                    .setTitle('🌊 津波警報・注意報・予報 第1報（テスト）')
                    .setColor(0xFF3300)
                    .setDescription(`${loc.name}を震源とする地震により、津波警報・注意報を発表しました。沿岸部では直ちに高台へ避難してください。`)
                    .addFields(
                        { name: '発表時刻', value: `<t:${nowTs}:F>`, inline: false },
                        {
                            name: '対象地域',
                            value:
                                `**岩手県**（⚠️ 津波警報）\n　予想の高さ: **3m**\n　到達予想時刻: <t:${nowTs + 600}:t>\n\n` +
                                `**宮城県**（🚨 大津波警報）\n　予想の高さ: **5m超**\n　到達予想時刻: <t:${nowTs + 480}:t>\n\n` +
                                `**福島県**（🔵 津波注意報）\n　予想の高さ: **1m**\n　到達予想時刻: <t:${nowTs + 900}:t>`,
                            inline: false,
                        },
                        {
                            name: '🌊 観測実況（到達後の実測値）',
                            value: `**石巻**: 4.2m（<t:${nowTs - 60}:t> 観測）\n**宮古**: 2.8m（<t:${nowTs - 120}:t> 観測）`,
                            inline: false,
                        },
                    )
                    .setFooter({ text: '気象庁 津波警報・注意報・予報 (VTSE41) ※これはテストデータです' })
                    .setTimestamp();
                await targetChannel.send({ embeds: [fakeEmbed] }).catch(console.error);
                await interaction.editReply(`✅ **#${targetChannel.name}** にテスト通知（津波警報・気象庁詳細版）を送信しました。`);
            }

            sendCommandLog(interaction, commandName);
            return;
        }

        // /weather-nerv コマンド ★追加
        // /weather-setup コマンド
        if (commandName === 'weather-setup') {
            await interaction.deferReply({ flags: MessageFlags.Ephemeral });
            const targetChannel = options.getChannel('channel');

            try {
                // earthquake_settings と同様に weather_settings コレクションを使用
                const docRef = db.collection('weather_settings').doc(interaction.guild.id);
                
                if (targetChannel) {
                    await docRef.set({ channelId: targetChannel.id });
                    await interaction.editReply(`✅ 特務機関NERVの気象情報通知を **${targetChannel}** に設定しました。`);
                } else {
                    await docRef.delete();
                    await interaction.editReply('🗑️ 特務機関NERVの気象情報通知設定を解除しました。');
                }
            } catch (e) {
                console.error(e);
                await interaction.editReply('❌ 設定の保存に失敗しました。');
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
            if (value === 'h_eqtest') helpText = '**/earthquake-test**\nチャンネル管理権限が必要です。設定済みの通知チャンネルに疑似地震通知を送信して表示を確認できます。\ntype:\n　・地震情報のみ / EEWのみ\n　・EEW→（30秒後）地震情報 の連続テスト（第1報→第2報→第3報→確定情報の流れを再現）\n　・津波予報（P2P簡易版） / 津波警報・注意報（気象庁詳細版・到達予想時刻と高さ付き）\nlocation: 震源地プリセット（省略時はランダム）';
            if (value === 'h_nerv') helpText = '**/weather-nerv**\n特務機関NERVの気象警報・注意報・地震情報などを都道府県名で検索し、最新の1件を表示します。\nprefecture: 都道府県名（例: 東京都、大阪府、福岡県、北海道）\nデータ元: 特務機関NERV (@UN_NERV) RSS';

            return await interaction.update({ content: `📜 **ヘルプ詳細**\n\n${helpText}`, components: [interaction.message.components[0]] });
        }
    }
});

// --- Bot ログイン ---
client.login(process.env.DISCORD_TOKEN);
