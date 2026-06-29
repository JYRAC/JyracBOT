'use strict';

const { EmbedBuilder, AttachmentBuilder, ChannelType, MessageFlags } = require('discord.js');
const { buildJMAQuakeEmbed, extractStationsFromJMA, formatIntensity, intensityToColor } = require('../utils/earthquake');
const { buildJMAMapAttachment } = require('../utils/map');
const { sendLog, sendCommandLog } = require('../utils/permissions');

/** 地震テスト用プリセット震源地 */
const LOCATIONS = {
    tokyo:    { name: '東京湾北部',     lat: 35.5,  lon: 139.8, mag: 7.3, depth: 40 },
    osaka:    { name: '大阪府南部',     lat: 34.5,  lon: 135.5, mag: 6.5, depth: 15 },
    sendai:   { name: '宮城県沖',       lat: 38.3,  lon: 141.6, mag: 7.8, depth: 60 },
    fukuoka:  { name: '福岡県西方沖',   lat: 33.7,  lon: 130.2, mag: 6.2, depth: 10 },
    hokkaido: { name: '胆振地方中東部', lat: 42.7,  lon: 142.0, mag: 6.7, depth: 37 },
    okinawa:  { name: '沖縄本島近海',   lat: 26.2,  lon: 127.7, mag: 5.8, depth: 20 },
};

/**
 * ダミーの気象庁 Body データを生成する（テスト用）
 */
function makeFakeJMABody(loc, maxInt = '5+') {
    const now = new Date().toISOString();
    const depthM = loc.depth * 1000;
    const coordinate = `+${loc.lat}+${loc.lon}-${depthM}/`;
    return {
        Earthquake: {
            OriginTime: now,
            ArrivalTime: now,
            Hypocenter: {
                Area: { Name: loc.name, Code: '999', Coordinate: coordinate }
            },
            Magnitude: loc.mag.toString(),
        },
        Intensity: {
            Observation: {
                MaxInt: maxInt,
                Pref: [{
                    Name: '疑似都道府県',
                    Code: '99',
                    MaxInt: maxInt,
                    Area: [{
                        Name: '疑似地域',
                        Code: '9901',
                        MaxInt: maxInt,
                        City: [{
                            Name: '疑似市',
                            Code: '9990100',
                            MaxInt: maxInt,
                            IntensityStation: [
                                { Name: '疑似観測点A', Code: '9990101', Int: maxInt, latlon: { lat: loc.lat + 0.1, lon: loc.lon + 0.1 } },
                                { Name: '疑似観測点B', Code: '9990102', Int: '4',    latlon: { lat: loc.lat - 0.1, lon: loc.lon + 0.2 } },
                                { Name: '疑似観測点C', Code: '9990103', Int: '3',    latlon: { lat: loc.lat + 0.2, lon: loc.lon - 0.1 } },
                            ]
                        }]
                    }]
                }]
            }
        },
        Comments: {
            ForecastComment: { Text: 'この地震による津波の心配はありません。\n※これはテストデータです。' }
        }
    };
}

/**
 * 地震・気象コマンドを処理する
 * /earthquake-setup /earthquake-test /weather-setup
 * @param {import('discord.js').ChatInputCommandInteraction} interaction
 * @param {import('discord.js').Client} client
 * @param {import('firebase-admin').firestore.Firestore} db
 * @returns {Promise<boolean>}
 */
async function handleEarthquakeCommand(interaction, client, db) {
    const { commandName, options } = interaction;

    // ── /earthquake-setup ─────────────────────────────────────
    if (commandName === 'earthquake-setup') {
        const channel = options.getChannel('channel');
        const docRef = db.collection('earthquake_settings').doc(interaction.guild.id);

        if (channel) {
            await docRef.set({ channelId: channel.id, guildName: interaction.guild.name });
            await interaction.editReply(`✅ 地震・緊急地震速報の通知先を ${channel} に設定しました。`);

            sendLog(interaction.guild, new EmbedBuilder()
                .setTitle('🌏 地震通知設定ログ')
                .addFields(
                    { name: '設定者', value: `${interaction.user}`, inline: true },
                    { name: '通知先', value: `${channel}`,          inline: true },
                    { name: '日時',   value: `<t:${Math.floor(Date.now() / 1000)}:F>`, inline: false }
                )
                .setColor(0xFF6600)
                .setTimestamp(),
                db
            );
        } else {
            const doc = await docRef.get();
            if (!doc.exists) return void await interaction.editReply('❌ 現在、地震通知は設定されていません。');
            await docRef.delete();
            await interaction.editReply('🗑️ 地震通知の設定を解除しました。');
        }

        sendCommandLog(interaction, commandName, db);
        return true;
    }

    // ── /earthquake-test ──────────────────────────────────────
    if (commandName === 'earthquake-test') {
        const locKey = options.getString('location') ?? Object.keys(LOCATIONS)[Math.floor(Math.random() * 6)];
        const loc    = LOCATIONS[locKey];
        const type   = options.getString('type');

        const snap = await db.collection('earthquake_settings').doc(interaction.guild.id).get();
        const notifyChannelId = snap.exists ? snap.data().channelId : null;
        const targetChannel = notifyChannelId
            ? await client.channels.fetch(notifyChannelId).catch(() => null)
            : interaction.channel;

        if (!targetChannel) {
            await interaction.editReply('❌ 通知チャンネルを取得できませんでした。');
            sendCommandLog(interaction, commandName, db);
            return true;
        }

        /** 地図付きペイロードを targetChannel に送信するヘルパー */
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

        if (type === 'quake') {
            const fakeBody = makeFakeJMABody(loc, '5+');
            const { embed, coord } = buildJMAQuakeEmbed(fakeBody, '震源・震度情報（テスト）');
            const stations = extractStationsFromJMA(fakeBody);
            await sendWithJMAMap(embed, coord?.lat, coord?.lon, stations);
            await interaction.editReply(`✅ **#${targetChannel.name}** にテスト通知（震源・震度情報）を送信しました。\n震源: ${loc.name} (${loc.lat}, ${loc.lon})`);

        } else if (type === 'eew') {
            const nowTs = Math.floor(Date.now() / 1000);
            const embed = new EmbedBuilder()
                .setTitle('🚨 緊急地震速報（テスト）')
                .setColor(0xFF2800)
                .setDescription('**強い揺れに備えてください！（これはテストです）**')
                .addFields(
                    { name: '震源地',       value: loc.name,       inline: true },
                    { name: '最大予測震度', value: '震度 5強',     inline: true },
                    { name: 'マグニチュード', value: `M${loc.mag}`, inline: true },
                    { name: '深さ',         value: `${loc.depth} km`, inline: true },
                    { name: '第N報',        value: '第1報',        inline: true },
                    { name: '発生時刻',     value: `<t:${nowTs}:F>`, inline: false },
                )
                .setTimestamp()
                .setFooter({ text: '※ 気象庁EEWはAPIで提供されないため、このテストは独自形式です' });
            await sendWithJMAMap(embed, loc.lat, loc.lon, []);
            await interaction.editReply(`✅ **#${targetChannel.name}** にテスト通知（EEW形式）を送信しました。`);

        } else if (type === 'sequence') {
            await interaction.editReply(`▶️ **#${targetChannel.name}** で地震通知シーケンス（震度速報→震源情報→震源・震度情報）を開始します。\n震源: ${loc.name}`);

            const nowTs = Math.floor(Date.now() / 1000);
            const speedEmbed = new EmbedBuilder()
                .setTitle('⚡ 震度速報（テスト）')
                .setColor(0xff9900)
                .setDescription('**速報のため震源情報は含まれません。続報をお待ちください。**')
                .addFields(
                    { name: '最大震度', value: '震度 5強', inline: true },
                    { name: '検知時刻', value: `<t:${nowTs}:F>`, inline: true },
                    { name: '観測地域', value: `5+: 疑似地域\n4: 周辺地域`, inline: false }
                )
                .setFooter({ text: '気象庁 震度速報（テスト）' });
            await targetChannel.send({ embeds: [speedEmbed] }).catch(console.error);

            setTimeout(async () => {
                const srcEmbed = new EmbedBuilder()
                    .setTitle('📍 震源に関する情報（テスト）')
                    .setColor(0x5599ff)
                    .addFields(
                        { name: '震源地',       value: loc.name,           inline: true },
                        { name: 'マグニチュード', value: `M${loc.mag}`,    inline: true },
                        { name: '深さ',         value: `${loc.depth} km`,  inline: true },
                        { name: '🌊 津波',      value: 'この地震による津波の心配はありません。', inline: false }
                    )
                    .setTimestamp()
                    .setFooter({ text: '気象庁 震源情報（テスト）' });
                const buf = await buildJMAMapAttachment(loc.lat, loc.lon, []).catch(() => null);
                const payload2 = { embeds: [srcEmbed] };
                if (buf) {
                    const a = new AttachmentBuilder(buf, { name: 'map.png' });
                    srcEmbed.setImage('attachment://map.png');
                    payload2.files = [a];
                }
                await targetChannel.send(payload2).catch(console.error);
            }, 10_000);

            setTimeout(async () => {
                const fakeBody = makeFakeJMABody(loc, '5+');
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

        sendCommandLog(interaction, commandName, db);
        return true;
    }

    // ── /weather-setup ────────────────────────────────────────
    if (commandName === 'weather-setup') {
        const targetChannel = options.getChannel('channel');
        try {
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
        sendCommandLog(interaction, commandName, db);
        return true;
    }

    return false;
}

module.exports = { handleEarthquakeCommand };
