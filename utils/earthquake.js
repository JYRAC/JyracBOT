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

    const prefs = detail.Intensity?.Observation?.Pref ?? [];
    const SHOW_THRESHOLD = ['3', '4', '5-', '5+', '6-', '6+', '7'];
    const prefLines = prefs
        .filter(p => SHOW_THRESHOLD.includes(p.MaxInt))
        .sort((a, b) => {
            const order = ['7', '6+', '6-', '5+', '5-', '4', '3'];
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
 * 気象庁地震情報の HTTPポーリングを開始する（30秒間隔）
 * @param {import('discord.js').Client} client
 * @param {import('firebase-admin').firestore.Firestore} db
 */
function startEarthquakeMonitor(client, db) {
    const LIST_URL    = 'https://www.jma.go.jp/bosai/quake/data/list.json';
    const DETAIL_BASE = 'https://www.jma.go.jp/bosai/quake/data/';
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

                    const INT_ORDER = ['1', '2', '3', '4', '5-', '5+', '6-', '6+', '7'];
                    const prefLines = (item.int ?? [])
                        .filter(p => ['3', '4', '5-', '5+', '6-', '6+', '7'].includes(p.maxi))
                        .sort((a, b) => INT_ORDER.indexOf(b.maxi) - INT_ORDER.indexOf(a.maxi))
                        .map(p => `震度${formatIntensity(p.maxi)}: ${prefNameFromCode(p.code)}`)
                        .join('\n');

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

                    if (prefLines) {
                        embed.addFields({ name: '観測地域', value: prefLines.slice(0, 1024), inline: false });
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
    poll();
    setInterval(poll, POLL_INTERVAL);
}

module.exports = {
    formatIntensity,
    intensityToColor,
    prefNameFromCode,
    buildJMAQuakeEmbed,
    extractStationsFromJMA,
    startEarthquakeMonitor,
};
