'use strict';

const { EmbedBuilder, AttachmentBuilder } = require('discord.js');
const { parseISO6709, buildJMAMapAttachment } = require('./map');

// ─── 震度速報専用 都道府県コード対応表 ─────────────────────────
// 気象庁 list.json の item.int[].code（2桁固定）→ 都道府県名
// （気象庁防災情報で使われる固定コードのため、変更されない前提でハードコード）
const PREF_CODE_MAP = {
    '01': '北海道',   '02': '青森県',   '03': '岩手県',   '04': '宮城県',
    '05': '秋田県',   '06': '山形県',   '07': '福島県',   '08': '茨城県',
    '09': '栃木県',   '10': '群馬県',   '11': '埼玉県',   '12': '千葉県',
    '13': '東京都',   '14': '神奈川県', '15': '新潟県',   '16': '富山県',
    '17': '石川県',   '18': '福井県',   '19': '山梨県',   '20': '長野県',
    '21': '岐阜県',   '22': '静岡県',   '23': '愛知県',   '24': '三重県',
    '25': '滋賀県',   '26': '京都府',   '27': '大阪府',   '28': '兵庫県',
    '29': '奈良県',   '30': '和歌山県', '31': '鳥取県',   '32': '島根県',
    '33': '岡山県',   '34': '広島県',   '35': '山口県',   '36': '徳島県',
    '37': '香川県',   '38': '愛媛県',   '39': '高知県',   '40': '福岡県',
    '41': '佐賀県',   '42': '長崎県',   '43': '熊本県',   '44': '大分県',
    '45': '宮崎県',   '46': '鹿児島県', '47': '沖縄県',
};

/**
 * 震度速報の都道府県コードを都道府県名に変換する
 * 対応表にないコードの場合はコードそのものを返す（フォールバック）
 */
function prefNameFromCode(code) {
    return PREF_CODE_MAP[code] ?? `地域コード${code}`;
}

// ─── 震度表示ヘルパー ──────────────────────────────────────────

/**
 * 震度文字列を日本語表記に変換する（例: '5-' → '5弱'）
 */
function formatIntensity(intStr) {
    if (!intStr) return '不明';
    return intStr.replace('-', '弱').replace('+', '強');
}

/**
 * 震度文字列をDiscord Embed用カラーコードに変換する
 */
function intensityToColor(intStr) {
    const colorMap = {
        '1': 0xf2f2ff, '2': 0x00aaff, '3': 0x0041ff, '4': 0xfae696,
        '5-': 0xffe600, '5+': 0xff9900, '6-': 0xff2800, '6+': 0xa50021, '7': 0xb40068,
    };
    return colorMap[intStr] ?? 0x5555ff;
}

// ─── Embed生成 ────────────────────────────────────────────────

/**
 * 気象庁 震源・震度情報 Body から EmbedBuilder を生成する
 * @returns {{ embed: EmbedBuilder, coord: object|null }}
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
            { name: '震源地',       value: hypo.Name ?? '不明',                       inline: true },
            { name: '最大震度',     value: maxInt ? `震度 ${formatIntensity(maxInt)}` : '不明', inline: true },
            { name: 'マグニチュード', value: `M${mag}`,                              inline: true },
            { name: '深さ',         value: depthStr,                                 inline: true },
            { name: '発生時刻',     value: originStr,                                inline: false },
        )
        .setTimestamp()
        .setFooter({ text: '気象庁 地震情報' });

    const tsunamiText = detail.Comments?.ForecastComment?.Text ?? '';
    if (tsunamiText.includes('津波')) {
        const isTsunamiDanger = !tsunamiText.includes('心配はありません');
        embed.addFields({
            name: isTsunamiDanger ? '🌊 津波情報' : '🌊 津波',
            value: tsunamiText.split('\n')[0].slice(0, 200),
            inline: false
        });
    }

    // 各地の震度を Area（地方）単位で細かく表示する
    // 構造: Pref > Area > City。Area.MaxInt を使い「〇〇県〇〇部」単位で表示する
    const prefs = detail.Intensity?.Observation?.Pref ?? [];
    const SHOW_THRESHOLD = ['3', '4', '5-', '5+', '6-', '6+', '7'];
    const INT_ORDER_DESC = ['7', '6+', '6-', '5+', '5-', '4', '3', '2', '1'];

    // Area（地方）ごとに最大震度と名称を収集
    const areaRows = [];
    for (const pref of prefs) {
        for (const area of pref.Area ?? []) {
            if (!SHOW_THRESHOLD.includes(area.MaxInt)) continue;
            areaRows.push({
                int:  area.MaxInt,
                name: `${pref.Name} ${area.Name}`,  // 例: 宮城県 北部
            });
        }
    }
    areaRows.sort((a, b) => INT_ORDER_DESC.indexOf(a.int) - INT_ORDER_DESC.indexOf(b.int));

    if (areaRows.length > 0) {
        // 震度ごとにグルーピングして表示（例: 震度5弱: 宮城県 北部 / 福島県 北部）
        const grouped = new Map();
        for (const row of areaRows) {
            const label = `震度${formatIntensity(row.int)}`;
            if (!grouped.has(label)) grouped.set(label, []);
            grouped.get(label).push(row.name);
        }
        const areaText = [...grouped.entries()]
            .map(([label, names]) => `**${label}**\n${names.join('  /  ')}`)
            .join('\n');

        embed.addFields({
            name: '各地の震度（震度3以上）',
            value: areaText.slice(0, 1024),
            inline: false
        });
    }

    return { embed, coord };
}

/**
 * 気象庁 震源・震度情報 Body から観測点リストを抽出する
 * 都道府県名(pref)も付与し、後段の絞り込み処理(map.js)で利用する
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
                            pref: pref.Name ?? null, // 都道府県名を保持
                        });
                    }
                }
            }
        }
    }
    return stations;
}

// ─── 地震情報ポーリング ────────────────────────────────────────

/**
 * EEW（緊急地震速報）の予測震度スケール値（数値）を日本語テキストに変換する
 * P2P地震情報 API は整数部のみ有効な小数で返すため Math.floor で丸める
 */
function eewScaleToText(scale) {
    const n = Math.floor(scale);
    const map = {
        '-1': '不明', 0: '震度0', 10: '震度1', 20: '震度2', 30: '震度3',
        40: '震度4', 45: '震度5弱', 50: '震度5強',
        55: '震度6弱', 60: '震度6強', 70: '震度7', 99: '震度7程度以上',
    };
    return map[n] ?? `震度不明(${n})`;
}

/**
 * 気象庁地震情報の HTTPポーリングを開始する（30秒間隔）
 * @param {import('discord.js').Client} client
 * @param {import('firebase-admin').firestore.Firestore} db
 */
function startEarthquakeMonitor(client, db) {
    const LIST_URL    = 'https://www.jma.go.jp/bosai/quake/data/list.json';
    const DETAIL_BASE = 'https://www.jma.go.jp/bosai/quake/data/';
    const EEW_URL     = 'https://api.p2pquake.net/v2/history?codes=556&limit=10';
    const POLL_INTERVAL = 30_000;

    const startedAt = Date.now();
    const seenIds = new Set();

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

    // ── EEW（緊急地震速報）ポーリング ──────────────────────────
    async function pollEEW() {
        try {
            const res = await fetch(EEW_URL, {
                headers: { 'User-Agent': 'JYRACDiscordBot/1.0' }
            });
            if (!res.ok) return;
            const list = await res.json();

            for (const item of list) {
                // 受信日時が Bot 起動前ならスキップ
                const itemTime = item.time ? new Date(item.time.replace(/\//g, '-')).getTime() : 0;
                if (itemTime < startedAt) continue;

                // 重複チェック: eventId + serial（報数）で一意に識別
                const eventId = item.issue?.eventId ?? '';
                const serial  = item.issue?.serial  ?? '0';
                const eewKey  = `eew_${eventId}_${serial}`;
                if (seenIds.has(eewKey)) continue;
                seenIds.add(eewKey);

                // テスト報は無視
                if (item.test) continue;
                // 取消の場合は取消通知を出す
                if (item.cancelled) {
                    const cancelEmbed = new EmbedBuilder()
                        .setTitle('🚫 緊急地震速報 取消')
                        .setColor(0x808080)
                        .setDescription('先ほどの緊急地震速報は取り消されました。')
                        .setTimestamp()
                        .setFooter({ text: '気象庁 緊急地震速報' });
                    await sendToChannels({ embeds: [cancelEmbed] });
                    continue;
                }

                const eq       = item.earthquake ?? {};
                const hypo     = eq.hypocenter   ?? {};
                const areas    = item.areas       ?? [];
                const serialNo = parseInt(serial, 10);

                // 警報対象地域（kindCode 10/11/19 のどれでも対象地域として表示）
                const warningAreas = areas.filter(a => a.kindCode != null);
                // 警報対象地域を都道府県（pref）でグルーピングして表示
                const prefMap = new Map();
                for (const a of warningAreas) {
                    const pref = a.pref ?? '不明';
                    if (!prefMap.has(pref)) prefMap.set(pref, []);
                    prefMap.get(pref).push(a.name);
                }
                const areaText = prefMap.size > 0
                    ? [...prefMap.entries()].map(([pref, names]) => `${pref}: ${names.join('・')}`).join('\n')
                    : '情報なし';

                // 全 area の最大予測震度（scaleFrom の最大値）
                const maxScale = areas.reduce((max, a) => Math.max(max, a.scaleFrom ?? -1), -1);
                const maxScaleText = maxScale >= 0 ? eewScaleToText(maxScale) : '不明';
                const color = maxScale >= 0 ? intensityToColor(
                    {10:'1',20:'2',30:'3',40:'4',45:'5-',50:'5+',55:'6-',60:'6+',70:'7',99:'7'}[maxScale] ?? '1'
                ) : 0xff0000;

                const issueTs = item.issue?.time
                    ? Math.floor(new Date(item.issue.time.replace(/\//g, '-')).getTime() / 1000)
                    : null;
                const issueTsStr = issueTs ? `<t:${issueTs}:F>` : '不明';

                const depthStr = hypo.depth != null && hypo.depth >= 0
                    ? (hypo.depth === 0 ? 'ごく浅い' : `${Math.floor(hypo.depth)} km`)
                    : '不明';

                const embed = new EmbedBuilder()
                    .setTitle(`🚨 緊急地震速報（警報）第${serialNo}報`)
                    .setColor(color)
                    .addFields(
                        { name: '震央',         value: hypo.name    ?? '不明',           inline: true },
                        { name: '深さ',         value: depthStr,                         inline: true },
                        { name: 'マグニチュード', value: hypo.magnitude != null && hypo.magnitude >= 0 ? `M${hypo.magnitude}` : '不明', inline: true },
                        { name: '最大予測震度', value: maxScaleText,                      inline: true },
                        { name: '発表時刻',     value: issueTsStr,                       inline: false },
                        { name: '警報対象の地域', value: areaText.slice(0, 1024),         inline: false },
                    )
                    .setTimestamp()
                    .setFooter({ text: '気象庁 緊急地震速報' });

                await sendToChannels({ embeds: [embed] });
                console.log(`[EEW] 第${serialNo}報 ${hypo.name ?? '不明'} M${hypo.magnitude} 最大予測震度${maxScaleText}`);
            }
        } catch (err) {
            console.error('[EEW監視] ポーリングエラー:', err.message);
        }
    }

    // ── 地震情報（確定）ポーリング ─────────────────────────────
    async function poll() {
        try {
            const res = await fetch(LIST_URL, {
                headers: { 'User-Agent': 'JYRACDiscordBot/1.0' }
            });
            if (!res.ok) return;
            const list = await res.json();

            for (const item of list) {
                const itemTime = item.rdt ? new Date(item.rdt).getTime() : 0;
                if (itemTime < startedAt) continue;

                const ttl = item.ttl ?? '';
                const eid = item.eid ?? item.ctt ?? '';
                const uniqueKey = `${eid}_${ttl}`;

                if (seenIds.has(uniqueKey)) continue;
                seenIds.add(uniqueKey);

                // ── 震源・震度情報（確定報）────────────────────────
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

                // ── 震度速報 ────────────────────────────────────────
                if (ttl === '震度速報') {
                    const maxi = item.maxi;
                    if (!maxi) continue;

                    const threshold = ['3', '4', '5-', '5+', '6-', '6+', '7'];
                    if (!threshold.includes(maxi)) continue;

                    const color = intensityToColor(maxi);
                    const arrivalTs = item.at ? Math.floor(new Date(item.at).getTime() / 1000) : null;
                    const arrivalStr = arrivalTs ? `<t:${arrivalTs}:F>` : '不明';

                    const embed = new EmbedBuilder()
                        .setTitle('⚡ 震度速報')
                        .setColor(color)
                        .setDescription('**速報のため震源情報は含まれません。続報をお待ちください。**')
                        .addFields(
                            { name: '最大震度', value: `震度 ${formatIntensity(maxi)}`, inline: true },
                            { name: '検知時刻', value: arrivalStr,                       inline: true },
                        )
                        .setTimestamp()
                        .setFooter({ text: '気象庁 震度速報' });

                    // 詳細JSONがある場合は Area（地方）単位の細かい震度情報を取得して表示する
                    if (item.json) {
                        try {
                            const detailRes = await fetch(`${DETAIL_BASE}${item.json}`, {
                                headers: { 'User-Agent': 'JYRACDiscordBot/1.0' }
                            });
                            if (detailRes.ok) {
                                const detail = await detailRes.json();
                                const prefs = detail.Body?.Intensity?.Observation?.Pref ?? [];
                                const SHOW_TH = ['3', '4', '5-', '5+', '6-', '6+', '7'];
                                const INT_ORD = ['7', '6+', '6-', '5+', '5-', '4', '3'];

                                const areaRows = [];
                                for (const pref of prefs) {
                                    for (const area of pref.Area ?? []) {
                                        if (!SHOW_TH.includes(area.MaxInt)) continue;
                                        areaRows.push({
                                            int:  area.MaxInt,
                                            name: `${pref.Name} ${area.Name}`,
                                        });
                                    }
                                }
                                areaRows.sort((a, b) => INT_ORD.indexOf(a.int) - INT_ORD.indexOf(b.int));

                                if (areaRows.length > 0) {
                                    const grouped = new Map();
                                    for (const row of areaRows) {
                                        const label = `震度${formatIntensity(row.int)}`;
                                        if (!grouped.has(label)) grouped.set(label, []);
                                        grouped.get(label).push(row.name);
                                    }
                                    const areaText = [...grouped.entries()]
                                        .map(([label, names]) => `**${label}**\n${names.join('  /  ')}`)
                                        .join('\n');
                                    embed.addFields({ name: '観測地域（震度3以上）', value: areaText.slice(0, 1024), inline: false });
                                }
                            }
                        } catch (e) {
                            // 詳細取得失敗時はフォールバック: 都道府県レベルで表示
                            const INT_ORDER_FB = ['1', '2', '3', '4', '5-', '5+', '6-', '6+', '7'];
                            const prefLines = (item.int ?? [])
                                .filter(p => threshold.includes(p.maxi))
                                .sort((a, b) => INT_ORDER_FB.indexOf(b.maxi) - INT_ORDER_FB.indexOf(a.maxi))
                                .map(p => `震度${formatIntensity(p.maxi)}: ${prefNameFromCode(p.code)}`)
                                .join('\n');
                            if (prefLines) {
                                embed.addFields({ name: '観測地域', value: prefLines.slice(0, 1024), inline: false });
                            }
                        }
                    } else {
                        // 詳細JSONなし: 都道府県レベルのフォールバック
                        const INT_ORDER_FB = ['1', '2', '3', '4', '5-', '5+', '6-', '6+', '7'];
                        const prefLines = (item.int ?? [])
                            .filter(p => threshold.includes(p.maxi))
                            .sort((a, b) => INT_ORDER_FB.indexOf(b.maxi) - INT_ORDER_FB.indexOf(a.maxi))
                            .map(p => `震度${formatIntensity(p.maxi)}: ${prefNameFromCode(p.code)}`)
                            .join('\n');
                        if (prefLines) {
                            embed.addFields({ name: '観測地域', value: prefLines.slice(0, 1024), inline: false });
                        }
                    }

                    await sendToChannels({ embeds: [embed] });
                    console.log(`[震度速報] 最大震度${maxi}`);
                }

                // ── 震源に関する情報 ────────────────────────────────
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
                                { name: '震源地',       value: hypo.Name ?? '不明',                          inline: true },
                                { name: 'マグニチュード', value: `M${eq.Magnitude ?? '不明'}`,               inline: true },
                                { name: '深さ',         value: coord ? (coord.depthKm === 0 ? 'ごく浅い' : `${coord.depthKm} km`) : '不明', inline: true },
                                { name: '発生時刻',     value: originTs ? `<t:${originTs}:F>` : '不明',     inline: false },
                            )
                            .setTimestamp()
                            .setFooter({ text: '気象庁 震源情報（震度情報は後続の震源・震度情報を参照）' });

                        if (tsunamiText) {
                            embed.addFields({ name: '🌊 津波', value: tsunamiText.split('\n')[0].slice(0, 200), inline: false });
                        }

                        const payload = { embeds: [embed] };
                        if (coord) {
                            const buf = await buildJMAMapAttachment(coord.lat, coord.lon, []).catch(() => null);
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
    console.log('[EEW監視] P2P地震情報API HTTPポーリング開始 (30秒間隔)');
    poll();
    pollEEW();
    setInterval(poll,    POLL_INTERVAL);
    setInterval(pollEEW, POLL_INTERVAL);
}

module.exports = {
    formatIntensity,
    intensityToColor,
    prefNameFromCode,
    eewScaleToText,
    buildJMAQuakeEmbed,
    extractStationsFromJMA,
    startEarthquakeMonitor,
};
