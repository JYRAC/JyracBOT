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
 * 各コマンドに必要なDiscord権限のマップ
 * setDefaultMemberPermissions と同じ値を使用
 * (グローバルコマンドはguild.commandsキャッシュに乗らないため直接定義)
 */
const COMMAND_REQUIRED_PERMISSIONS = {
    'log':               PermissionsBitField.Flags.Administrator,
    'verify':            PermissionsBitField.Flags.ManageRoles,
    'delete':            PermissionsBitField.Flags.ManageMessages,
    'ticket':            PermissionsBitField.Flags.ManageChannels,
    'give-role':         PermissionsBitField.Flags.ManageRoles,
    'remove-role':       PermissionsBitField.Flags.ManageRoles,
    'role-confirmation': PermissionsBitField.Flags.ModerateMembers,
    'notice':            PermissionsBitField.Flags.ManageRoles,
    'broadcast':         PermissionsBitField.Flags.ManageRoles,
    'export':            PermissionsBitField.Flags.ManageMessages,
    'earthquake-setup':  PermissionsBitField.Flags.ManageChannels,
    'earthquake-test':   PermissionsBitField.Flags.ManageChannels,
    'weather-setup':     PermissionsBitField.Flags.ManageChannels,
};

/**
 * ユーザーがコマンドを使用できるか判定する
 * 条件: 対応するDiscord権限を持っている OR オーナーにFirebase許可されている
 * @param {import('discord.js').ChatInputCommandInteraction} interaction
 * @returns {Promise<boolean>}
 */
async function hasCommandAccess(interaction) {
    // 1. サーバーオーナーは常に許可
    if (interaction.guild.ownerId === interaction.user.id) return true;

    // 2. Administratorを持つメンバーは常に許可
    if (interaction.memberPermissions.has(PermissionsBitField.Flags.Administrator)) return true;

    // 3. コマンド固有の必要権限を直接チェック
    const requiredPerm = COMMAND_REQUIRED_PERMISSIONS[interaction.commandName];
    if (requiredPerm && interaction.memberPermissions.has(requiredPerm)) return true;

    // 4. Firebaseの許可リストに登録されているか確認
    try {
        const doc = await db.collection('command_access').doc(interaction.user.id).get();
        if (doc.exists && doc.data()?.allowed === true) return true;
    } catch (e) {
        console.error('[権限チェック] Firebaseエラー:', e);
    }

    return false;
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


// ─── 地震通知モジュール（気象庁非公式JSON API版） ──────────────
// データソース: https://www.jma.go.jp/bosai/quake/data/list.json
// 個別地震: https://www.jma.go.jp/bosai/quake/data/{jsonName}.json
// 地図: 国土地理院タイル（観測点緯度経度はAPIから直接取得）

// ─── 地図生成ユーティリティ ────────────────────────────────────

/**
 * 緯度・経度から国土地理院タイルのX/Y座標と、タイル内ピクセル位置を計算する
 */
function latLonToTileAndPixel(lat, lon, zoom) {
    const n = Math.pow(2, zoom);
    const latRad = lat * Math.PI / 180;
    const tileX = Math.floor((lon + 180) / 360 * n);
    const tileY = Math.floor(
        (1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2 * n
    );
    const pixX = Math.floor(((lon + 180) / 360 * n - tileX) * 256);
    const pixY = Math.floor(
        ((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2 * n - tileY) * 256
    );
    return { tileX, tileY, pixX, pixY };
}

/**
 * 国土地理院タイルをfetchしてBufferで返す
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
 * 震度スタンプSVGを生成する（気象庁の配色指針に準拠）
 */
function getScaleSvg(intStr) {
    // intStr: "1","2","3","4","5-","5+","6-","6+","7"
    const scaleMap = {
        '1':  { text: '1',  bg: '#f2f2ff', c: '#000000' },
        '2':  { text: '2',  bg: '#00aaff', c: '#000000' },
        '3':  { text: '3',  bg: '#0041ff', c: '#ffffff' },
        '4':  { text: '4',  bg: '#fae696', c: '#000000' },
        '5-': { text: '5弱', bg: '#ffe600', c: '#000000' },
        '5+': { text: '5強', bg: '#ff9900', c: '#000000' },
        '6-': { text: '6弱', bg: '#ff2800', c: '#ffffff' },
        '6+': { text: '6強', bg: '#a50021', c: '#ffffff' },
        '7':  { text: '7',  bg: '#b40068', c: '#ffffff' },
    };
    const s = scaleMap[intStr];
    if (!s) return null;
    const fontSize = intStr.length > 1 ? 11 : 13;
    return Buffer.from(
        `<svg width="24" height="24" xmlns="http://www.w3.org/2000/svg">
            <rect width="24" height="24" rx="4" fill="${s.bg}" stroke="#555" stroke-width="1"/>
            <text x="12" y="17" font-family="sans-serif" font-size="${fontSize}" font-weight="bold" fill="${s.c}" text-anchor="middle">${s.text}</text>
        </svg>`
    );
}

/**
 * ISO 6709形式の座標文字列から緯度・経度・深さを取得する
 * 例: "+38.4+141.9-60000/" → { lat: 38.4, lon: 141.9, depthKm: 60 }
 */
function parseISO6709(coordinate) {
    if (!coordinate) return null;
    // ISO 6709: 符号付き数値が連続する形式
    // パターン: 符号+数値 が複数続く
    const parts = coordinate.replace('/', '').split(/(?=[+-])/).filter(s => s !== '');
    if (parts.length < 2) return null;
    const lat = parseFloat(parts[0]);
    const lon = parseFloat(parts[1]);
    let depthKm = 0;
    if (parts.length >= 3) {
        const depthRaw = parseFloat(parts[2]);
        depthKm = Math.abs(depthRaw / 1000); // m→km, 負値を正に
    }
    if (isNaN(lat) || isNaN(lon)) return null;
    return { lat, lon, depthKm };
}

/**
 * 気象庁APIの震度文字列を表示用に変換する
 * "5-" → "5弱", "5+" → "5強", etc.
 */
function formatIntensity(intStr) {
    if (!intStr) return '不明';
    return intStr.replace('-', '弱').replace('+', '強');
}

/**
 * 震度文字列をEmbedカラーに変換する
 */
function intensityToColor(intStr) {
    const colorMap = {
        '1': 0xf2f2ff, '2': 0x00aaff, '3': 0x0041ff, '4': 0xfae696,
        '5-': 0xffe600, '5+': 0xff9900, '6-': 0xff2800, '6+': 0xa50021, '7': 0xb40068,
    };
    return colorMap[intStr] ?? 0x5555ff;
}

/**
 * 国土地理院タイルを 3×3 枚合成し、震源地を中心にクロップした地図画像を返す。
 * @param {number} epicLat - 震源緯度
 * @param {number} epicLon - 震源経度
 * @param {Array}  stations - 観測点配列 [{lat, lon, int}] (APIから直接取得した緯度経度)
 */
async function buildJMAMapAttachment(epicLat, epicLon, stations = []) {
    if (epicLat == null || epicLon == null) return null;

    const zoom = 8;
    const TILE = 256;
    const HALF = 1;
    const GRID = HALF * 2 + 1;

    const { tileX: cx, tileY: cy, pixX: markerPixX, pixY: markerPixY }
        = latLonToTileAndPixel(epicLat, epicLon, zoom);

    // 3×3タイルを並列取得
    const fetches = [];
    for (let dy = -HALF; dy <= HALF; dy++) {
        for (let dx = -HALF; dx <= HALF; dx++) {
            const gx = dx + HALF;
            const gy = dy + HALF;
            fetches.push(
                fetchGSITile(zoom, cx + dx, cy + dy)
                    .then(buf => ({ gx, gy, buf }))
                    .catch(() => null)
            );
        }
    }
    const tiles = await Promise.all(fetches);
    const canvasSize = TILE * GRID;

    const composites = tiles
        .filter(t => t !== null)
        .map(({ gx, gy, buf }) => ({ input: buf, left: gx * TILE, top: gy * TILE }));

    // 観測点の震度スタンプを配置（APIから緯度経度を直接取得するため正確）
    const drawnCoords = new Set();
    for (const st of stations) {
        if (st.lat == null || st.lon == null) continue;
        const coordKey = `${st.lat.toFixed(2)}_${st.lon.toFixed(2)}`;
        if (drawnCoords.has(coordKey)) continue;

        const { tileX: px, tileY: py, pixX: pPixX, pixY: pPixY }
            = latLonToTileAndPixel(st.lat, st.lon, zoom);

        const diffX = px - (cx - HALF);
        const diffY = py - (cy - HALF);

        if (diffX >= 0 && diffX < GRID && diffY >= 0 && diffY < GRID) {
            const absX = diffX * TILE + pPixX;
            const absY = diffY * TILE + pPixY;
            const svgBuf = getScaleSvg(st.int);
            if (svgBuf) {
                composites.push({
                    input: svgBuf,
                    left: Math.max(0, Math.min(canvasSize - 24, Math.floor(absX - 12))),
                    top:  Math.max(0, Math.min(canvasSize - 24, Math.floor(absY - 12))),
                });
                drawnCoords.add(coordKey);
            }
        }
    }

    // 震源地の赤×マーカー
    const markerAbsX = HALF * TILE + markerPixX;
    const markerAbsY = HALF * TILE + markerPixY;

    const ARM = 16, SW = 5, PAD = 12;
    const sz = (ARM + PAD) * 2;
    const h = sz / 2;
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

// ─── Embed生成 ──────────────────────────────────────────────────

/**
 * 気象庁 震源・震度情報(VXSE5k) から地震情報Embedを生成する
 * @param {object} detail - 個別地震JSONの Body
 * @param {string} title  - 情報名（Head.Title）
 */
function buildJMAQuakeEmbed(detail, title) {
    const eq = detail.Earthquake ?? {};
    const hypo = eq.Hypocenter?.Area ?? {};
    const coord = parseISO6709(hypo.Coordinate);

    const maxInt = detail.Intensity?.Observation?.MaxInt ?? null;
    const color = maxInt ? intensityToColor(maxInt) : 0x5555ff;

    const originTime = eq.OriginTime ? new Date(eq.OriginTime) : null;
    const originTs = originTime ? Math.floor(originTime.getTime() / 1000) : null;
    const originStr = originTs ? `<t:${originTs}:F>` : '不明';

    const mag = eq.Magnitude ?? '不明';
    const depthStr = coord
        ? (coord.depthKm === 0 ? 'ごく浅い' : `${coord.depthKm} km`)
        : '不明';

    const embed = new EmbedBuilder()
        .setTitle(`🌏 ${title ?? '地震情報'}`)
        .setColor(color)
        .addFields(
            { name: '震源地', value: hypo.Name ?? '不明', inline: true },
            { name: '最大震度', value: maxInt ? `震度 ${formatIntensity(maxInt)}` : '不明', inline: true },
            { name: 'マグニチュード', value: `M${mag}`, inline: true },
            { name: '深さ', value: depthStr, inline: true },
            { name: '発生時刻', value: originStr, inline: false },
        )
        .setTimestamp()
        .setFooter({ text: '気象庁 地震情報' });

    // 津波コメントがあれば追加
    const tsunamiText = detail.Comments?.ForecastComment?.Text ?? '';
    if (tsunamiText.includes('津波')) {
        const isTsunamiDanger = !tsunamiText.includes('心配はありません');
        embed.addFields({
            name: isTsunamiDanger ? '🌊 津波情報' : '🌊 津波',
            value: tsunamiText.split('\n')[0].slice(0, 200),
            inline: false
        });
    }

    // 都道府県ごとの最大震度（震度3以上のみ表示）
    const prefs = detail.Intensity?.Observation?.Pref ?? [];
    const SHOW_THRESHOLD = ['3', '4', '5-', '5+', '6-', '6+', '7'];
    const prefLines = prefs
        .filter(p => SHOW_THRESHOLD.includes(p.MaxInt))
        .sort((a, b) => {
            const order = ['7','6+','6-','5+','5-','4','3'];
            return order.indexOf(a.MaxInt) - order.indexOf(b.MaxInt);
        })
        .map(p => `${formatIntensity(p.MaxInt)}: ${p.Name}`)
        .join('\n');

    if (prefLines) {
        embed.addFields({
            name: '各地の震度（震度3以上）',
            value: prefLines.slice(0, 1024),
            inline: false
        });
    }

    return { embed, coord };
}

/**
 * 気象庁APIの個別地震JSONから観測点の緯度経度+震度リストを抽出する
 * IntensityStation[].latlon が存在する場合はそこから取得（最も正確）
 */
function extractStationsFromJMA(detail) {
    const stations = [];
    const prefs = detail.Intensity?.Observation?.Pref ?? [];
    for (const pref of prefs) {
        for (const area of pref.Area ?? []) {
            for (const city of area.City ?? []) {
                for (const st of city.IntensityStation ?? []) {
                    if (st.latlon?.lat != null && st.latlon?.lon != null) {
                        stations.push({
                            lat: st.latlon.lat,
                            lon: st.latlon.lon,
                            int: st.Int,
                        });
                    }
                }
            }
        }
    }
    return stations;
}

// ─── 気象庁地震モニター（HTTPポーリング） ──────────────────────

/**
 * 気象庁非公式JSON APIをポーリングして地震情報をDiscordに通知する
 * - list.json を30秒ごとに確認
 * - VXSE5k（震源・震度情報、確定報）を検出したら個別JSONを取得してEmbed送信
 * - 震度速報(VXSE51)は震度のみで速報として送信
 * - 通知先チャンネルIDは Firestore の earthquake_settings/{guildId} に保存
 */
function startEarthquakeMonitor() {
    const LIST_URL = 'https://www.jma.go.jp/bosai/quake/data/list.json';
    const DETAIL_BASE = 'https://www.jma.go.jp/bosai/quake/data/';
    const POLL_INTERVAL = 30_000;

    const startedAt = Date.now();
    const seenIds = new Set(); // "eid_ttl" でユニーク管理

    async function getNotifyChannels() {
        const snap = await db.collection('earthquake_settings').get();
        return snap.docs.map(d => d.data().channelId).filter(Boolean);
    }

    async function sendToChannels(payload) {
        const channelIds = await getNotifyChannels();
        for (const channelId of channelIds) {
            const ch = await client.channels.fetch(channelId).catch(() => null);
            if (!ch) continue;
            await ch.send(payload).catch(console.error);
        }
    }

    async function poll() {
        try {
            const res = await fetch(LIST_URL, {
                headers: { 'User-Agent': 'JYRACDiscordBot/1.0' }
            });
            if (!res.ok) return;
            const list = await res.json();

            for (const item of list) {
                // 起動前のデータは無視
                const itemTime = item.rdt ? new Date(item.rdt).getTime() : 0;
                if (itemTime < startedAt) continue;

                const ttl = item.ttl ?? '';
                const eid = item.eid ?? item.ctt ?? '';
                const uniqueKey = `${eid}_${ttl}`;

                if (seenIds.has(uniqueKey)) continue;
                seenIds.add(uniqueKey);

                // ─── 震源・震度情報 (VXSE5k) ───────────────────────────
                if (ttl === '震源・震度情報' && item.json) {
                    try {
                        const detailRes = await fetch(`${DETAIL_BASE}${item.json}`, {
                            headers: { 'User-Agent': 'JYRACDiscordBot/1.0' }
                        });
                        if (!detailRes.ok) continue;
                        const detail = await detailRes.json();
                        const body = detail.Body;
                        if (!body) continue;

                        const { embed, coord } = buildJMAQuakeEmbed(body, detail.Head?.Title);
                        const stations = extractStationsFromJMA(body);

                        const payload = { embeds: [embed] };

                        // 地図生成（座標が取れた場合のみ）
                        if (coord) {
                            const buf = await buildJMAMapAttachment(coord.lat, coord.lon, stations)
                                .catch(e => { console.error('[地図生成エラー]', e.message); return null; });
                            if (buf) {
                                const attachment = new AttachmentBuilder(buf, { name: 'map.png' });
                                embed.setImage('attachment://map.png');
                                payload.files = [attachment];
                            }
                        }

                        await sendToChannels(payload);
                        console.log(`[地震通知] ${item.anm ?? '不明'} M${item.mag} 震度${item.maxi ?? '?'}`);

                    } catch (e) {
                        console.error('[地震通知] 個別JSON取得エラー:', e.message);
                    }
                }

                // ─── 震度速報 (VXSE51) ─────────────────────────────────
                if (ttl === '震度速報') {
                    const maxi = item.maxi;
                    if (!maxi) continue;

                    // 震度3未満は通知しない
                    const threshold = ['3', '4', '5-', '5+', '6-', '6+', '7'];
                    if (!threshold.includes(maxi)) continue;

                    const color = intensityToColor(maxi);
                    const arrivalTs = item.at ? Math.floor(new Date(item.at).getTime() / 1000) : null;
                    const arrivalStr = arrivalTs ? `<t:${arrivalTs}:F>` : '不明';

                    // 都道府県ごとの震度をリスト化
                    const prefLines = (item.int ?? [])
                        .filter(p => ['3','4','5-','5+','6-','6+','7'].includes(p.maxi))
                        .map(p => `${formatIntensity(p.maxi)}: (コード ${p.code})`)
                        .join('\n');

                    const embed = new EmbedBuilder()
                        .setTitle('⚡ 震度速報')
                        .setColor(color)
                        .setDescription('**速報のため震源情報は含まれません。続報をお待ちください。**')
                        .addFields(
                            { name: '最大震度', value: `震度 ${formatIntensity(maxi)}`, inline: true },
                            { name: '検知時刻', value: arrivalStr, inline: true },
                        )
                        .setTimestamp()
                        .setFooter({ text: '気象庁 震度速報' });

                    if (prefLines) {
                        embed.addFields({ name: '観測地域', value: prefLines.slice(0, 1024), inline: false });
                    }

                    await sendToChannels({ embeds: [embed] });
                    console.log(`[震度速報] 最大震度${maxi}`);
                }

                // ─── 震源に関する情報 (VXSE52) ────────────────────────
                if (ttl === '震源に関する情報' && item.json) {
                    try {
                        const detailRes = await fetch(`${DETAIL_BASE}${item.json}`, {
                            headers: { 'User-Agent': 'JYRACDiscordBot/1.0' }
                        });
                        if (!detailRes.ok) continue;
                        const detail = await detailRes.json();
                        const eq = detail.Body?.Earthquake ?? {};
                        const hypo = eq.Hypocenter?.Area ?? {};
                        const coord = parseISO6709(hypo.Coordinate);

                        const originTs = eq.OriginTime
                            ? Math.floor(new Date(eq.OriginTime).getTime() / 1000)
                            : null;

                        const tsunamiText = detail.Body?.Comments?.ForecastComment?.Text ?? '';

                        const embed = new EmbedBuilder()
                            .setTitle('📍 震源に関する情報')
                            .setColor(0x5599ff)
                            .addFields(
                                { name: '震源地', value: hypo.Name ?? '不明', inline: true },
                                { name: 'マグニチュード', value: `M${eq.Magnitude ?? '不明'}`, inline: true },
                                { name: '深さ', value: coord ? (coord.depthKm === 0 ? 'ごく浅い' : `${coord.depthKm} km`) : '不明', inline: true },
                                { name: '発生時刻', value: originTs ? `<t:${originTs}:F>` : '不明', inline: false },
                            )
                            .setTimestamp()
                            .setFooter({ text: '気象庁 震源情報（震度情報は後続の震源・震度情報を参照）' });

                        if (tsunamiText) {
                            embed.addFields({ name: '🌊 津波', value: tsunamiText.split('\n')[0].slice(0, 200), inline: false });
                        }

                        const payload = { embeds: [embed] };
                        if (coord) {
                            const buf = await buildJMAMapAttachment(coord.lat, coord.lon, [])
                                .catch(() => null);
                            if (buf) {
                                const attachment = new AttachmentBuilder(buf, { name: 'map.png' });
                                embed.setImage('attachment://map.png');
                                payload.files = [attachment];
                            }
                        }

                        await sendToChannels(payload);
                        console.log(`[震源情報] ${hypo.Name ?? '不明'} M${eq.Magnitude}`);

                    } catch (e) {
                        console.error('[震源情報] エラー:', e.message);
                    }
                }
            }
        } catch (err) {
            console.error('[地震監視] ポーリングエラー:', err.message);
        }
    }

    console.log('[地震監視] 気象庁API HTTPポーリング開始 (30秒間隔)');
    poll();
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
                    { name: '🌏 震源・震度情報（確定報）', value: 'quake' },
                    { name: '🚨 緊急地震速報（EEW）形式', value: 'eew' },
                    { name: '▶️ 震度速報→震源情報→確定報 の連続テスト', value: 'sequence' },
                    { name: '🌊 津波警報・注意報', value: 'tsunami' },
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
            return;
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

        // /earthquake-test コマンド（気象庁API形式テストデータ）
        if (commandName === 'earthquake-test') {
            await interaction.deferReply({ flags: MessageFlags.Ephemeral });

            // 震源地プリセット（緯度経度を正確に持つ）
            const LOCATIONS = {
                tokyo:    { name: '東京湾北部',     lat: 35.5,  lon: 139.8, mag: 7.3, depth: 40 },
                osaka:    { name: '大阪府南部',     lat: 34.5,  lon: 135.5, mag: 6.5, depth: 15 },
                sendai:   { name: '宮城県沖',       lat: 38.3,  lon: 141.6, mag: 7.8, depth: 60 },
                fukuoka:  { name: '福岡県西方沖',   lat: 33.7,  lon: 130.2, mag: 6.2, depth: 10 },
                hokkaido: { name: '胆振地方中東部', lat: 42.7,  lon: 142.0, mag: 6.7, depth: 37 },
                okinawa:  { name: '沖縄本島近海',   lat: 26.2,  lon: 127.7, mag: 5.8, depth: 20 },
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

            // 共通: Embedに地図を添付して送信するヘルパー
            async function sendWithJMAMap(embed, lat, lon, stations = []) {
                const payload = { embeds: [embed] };
                if (lat != null && lon != null) {
                    const buf = await buildJMAMapAttachment(lat, lon, stations).catch(() => null);
                    if (buf) {
                        const attachment = new AttachmentBuilder(buf, { name: 'map.png' });
                        embed.setImage('attachment://map.png');
                        payload.files = [attachment];
                    }
                }
                await targetChannel.send(payload).catch(console.error);
            }

            // 疑似 気象庁API形式の Body データを生成（VXSE5k形式）
            function makeFakeJMABody(maxInt = '5+') {
                const now = new Date().toISOString();
                // ISO 6709形式: "+緯度+経度-深さ(m)/"
                const depthM = loc.depth * 1000;
                const coordinate = `+${loc.lat}+${loc.lon}-${depthM}/`;
                return {
                    Earthquake: {
                        OriginTime: now,
                        ArrivalTime: now,
                        Hypocenter: {
                            Area: {
                                Name: loc.name,
                                Code: '999',
                                Coordinate: coordinate,
                            }
                        },
                        Magnitude: loc.mag.toString(),
                    },
                    Intensity: {
                        Observation: {
                            MaxInt: maxInt,
                            Pref: [
                                {
                                    Name: '疑似都道府県',
                                    Code: '99',
                                    MaxInt: maxInt,
                                    Area: [
                                        {
                                            Name: '疑似地域',
                                            Code: '9901',
                                            MaxInt: maxInt,
                                            City: [
                                                {
                                                    Name: '疑似市',
                                                    Code: '9990100',
                                                    MaxInt: maxInt,
                                                    IntensityStation: [
                                                        // 震源付近に疑似観測点を配置（正確な座標使用）
                                                        { Name: '疑似観測点A', Code: '9990101', Int: maxInt, latlon: { lat: loc.lat + 0.1, lon: loc.lon + 0.1 } },
                                                        { Name: '疑似観測点B', Code: '9990102', Int: '4',    latlon: { lat: loc.lat - 0.1, lon: loc.lon + 0.2 } },
                                                        { Name: '疑似観測点C', Code: '9990103', Int: '3',    latlon: { lat: loc.lat + 0.2, lon: loc.lon - 0.1 } },
                                                    ]
                                                }
                                            ]
                                        }
                                    ]
                                }
                            ]
                        }
                    },
                    Comments: {
                        ForecastComment: { Text: 'この地震による津波の心配はありません。\n※これはテストデータです。' }
                    }
                };
            }

            if (type === 'quake') {
                const fakeBody = makeFakeJMABody('5+');
                const { embed, coord } = buildJMAQuakeEmbed(fakeBody, '震源・震度情報（テスト）');
                const stations = extractStationsFromJMA(fakeBody);
                await sendWithJMAMap(embed, coord?.lat, coord?.lon, stations);
                await interaction.editReply(`✅ **#${targetChannel.name}** にテスト通知（震源・震度情報）を送信しました。\n震源: ${loc.name} (${loc.lat}, ${loc.lon})`);

            } else if (type === 'eew') {
                // EEWは気象庁の非公式APIには含まれないため、独自形式のEmbedでテスト表示
                const nowTs = Math.floor(Date.now() / 1000);
                const embed = new EmbedBuilder()
                    .setTitle('🚨 緊急地震速報（テスト）')
                    .setColor(0xFF2800)
                    .setDescription('**強い揺れに備えてください！（これはテストです）**')
                    .addFields(
                        { name: '震源地', value: loc.name, inline: true },
                        { name: '最大予測震度', value: '震度 5強', inline: true },
                        { name: 'マグニチュード', value: `M${loc.mag}`, inline: true },
                        { name: '深さ', value: `${loc.depth} km`, inline: true },
                        { name: '第N報', value: '第1報', inline: true },
                        { name: '発生時刻', value: `<t:${nowTs}:F>`, inline: false },
                    )
                    .setTimestamp()
                    .setFooter({ text: '※ 気象庁EEWはAPIで提供されないため、このテストは独自形式です' });
                await sendWithJMAMap(embed, loc.lat, loc.lon, []);
                await interaction.editReply(`✅ **#${targetChannel.name}** にテスト通知（EEW形式）を送信しました。`);

            } else if (type === 'sequence') {
                await interaction.editReply(`▶️ **#${targetChannel.name}** で地震通知シーケンス（震度速報→震源情報→震源・震度情報）を開始します。\n震源: ${loc.name}`);

                // 1. 震度速報（即時）
                const nowTs = Math.floor(Date.now() / 1000);
                const speedEmbed = new EmbedBuilder()
                    .setTitle('⚡ 震度速報（テスト）')
                    .setColor(0xff9900)
                    .setDescription('**速報のため震源情報は含まれません。続報をお待ちください。**')
                    .addFields(
                        { name: '最大震度', value: '震度 5強', inline: true },
                        { name: '検知時刻', value: `<t:${nowTs}:F>`, inline: true },
                        { name: '観測地域', value: `5強: 疑似地域\n4: 周辺地域`, inline: false }
                    )
                    .setFooter({ text: '気象庁 震度速報（テスト）' });
                await targetChannel.send({ embeds: [speedEmbed] }).catch(console.error);

                // 2. 震源情報（10秒後）
                setTimeout(async () => {
                    const depthM = loc.depth * 1000;
                    const fakeSourceBody = {
                        Earthquake: {
                            OriginTime: new Date().toISOString(),
                            Hypocenter: { Area: { Name: loc.name, Coordinate: `+${loc.lat}+${loc.lon}-${depthM}/` } },
                            Magnitude: loc.mag.toString(),
                        },
                        Comments: { ForecastComment: { Text: 'この地震による津波の心配はありません。' } }
                    };
                    const srcEmbed = new EmbedBuilder()
                        .setTitle('📍 震源に関する情報（テスト）')
                        .setColor(0x5599ff)
                        .addFields(
                            { name: '震源地', value: loc.name, inline: true },
                            { name: 'マグニチュード', value: `M${loc.mag}`, inline: true },
                            { name: '深さ', value: `${loc.depth} km`, inline: true },
                            { name: '🌊 津波', value: 'この地震による津波の心配はありません。', inline: false }
                        )
                        .setTimestamp()
                        .setFooter({ text: '気象庁 震源情報（テスト）' });
                    const buf = await buildJMAMapAttachment(loc.lat, loc.lon, []).catch(() => null);
                    const payload2 = { embeds: [srcEmbed] };
                    if (buf) { const a = new AttachmentBuilder(buf, { name: 'map.png' }); srcEmbed.setImage('attachment://map.png'); payload2.files = [a]; }
                    await targetChannel.send(payload2).catch(console.error);
                }, 10_000);

                // 3. 震源・震度情報（25秒後）
                setTimeout(async () => {
                    const fakeBody = makeFakeJMABody('5+');
                    const { embed: finalEmbed, coord } = buildJMAQuakeEmbed(fakeBody, '震源・震度情報（テスト・確定報）');
                    const stations = extractStationsFromJMA(fakeBody);
                    await sendWithJMAMap(finalEmbed, coord?.lat, coord?.lon, stations);
                }, 25_000);

            } else if (type === 'tsunami') {
                const nowTs = Math.floor(Date.now() / 1000);
                const tsunamiEmbed = new EmbedBuilder()
                    .setTitle('🌊 津波警報・注意報（テスト）')
                    .setColor(0xFF3300)
                    .setDescription(`${loc.name}を震源とする地震により津波警報・注意報を発表しました。`)
                    .addFields(
                        { name: '発表時刻', value: `<t:${nowTs}:F>`, inline: false },
                        {
                            name: '対象地域',
                            value:
                                `**三陸沿岸**（🚨 大津波警報）予想の高さ: 5m超\n到達予想: <t:${nowTs + 480}:t>\n\n` +
                                `**福島県**（⚠️ 津波警報）予想の高さ: 3m\n到達予想: <t:${nowTs + 600}:t>\n\n` +
                                `**茨城県**（🔵 津波注意報）予想の高さ: 1m\n到達予想: <t:${nowTs + 900}:t>`,
                            inline: false
                        }
                    )
                    .setFooter({ text: '気象庁 津波警報・注意報（テスト）' })
                    .setTimestamp();
                await targetChannel.send({ embeds: [tsunamiEmbed] }).catch(console.error);
                await interaction.editReply(`✅ **#${targetChannel.name}** にテスト通知（津波警報・注意報）を送信しました。`);
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
            if (value === 'h_earthquake') helpText = '**/earthquake-setup**\nチャンネル管理権限が必要です。地震情報をリアルタイムで通知するチャンネルを設定します。\n`channel` を省略すると設定を解除します。\nデータ元: 気象庁非公式JSON API\n通知される情報: 震度速報（震度3以上）・震源に関する情報・震源・震度情報（確定報）';
            if (value === 'h_eqtest') helpText = '**/earthquake-test**\nチャンネル管理権限が必要です。設定済みの通知チャンネルに疑似地震通知を送信して表示を確認できます。\ntype:\n　・震源・震度情報（確定報）\n　・EEW形式\n　・震度速報→震源情報→確定報 の連続テスト\n　・津波警報・注意報\nlocation: 震源地プリセット（省略時はランダム）\nデータ形式: 気象庁非公式JSON API形式';
            if (value === 'h_nerv') helpText = '**/weather-nerv**\n特務機関NERVの気象警報・注意報・地震情報などを都道府県名で検索し、最新の1件を表示します。\nprefecture: 都道府県名（例: 東京都、大阪府、福岡県、北海道）\nデータ元: 特務機関NERV (@UN_NERV) RSS';

            return await interaction.update({ content: `📜 **ヘルプ詳細**\n\n${helpText}`, components: [interaction.message.components[0]] });
        }
    }
});

// --- Bot ログイン ---
client.login(process.env.DISCORD_TOKEN);
