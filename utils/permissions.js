'use strict';

const { EmbedBuilder, PermissionsBitField } = require('discord.js');
const { COMMAND_REQUIRED_PERMISSIONS } = require('../config');

/**
 * ユーザーがコマンドを使用できるか判定する
 * @param {import('discord.js').ChatInputCommandInteraction} interaction
 * @param {import('firebase-admin').firestore.Firestore} db
 * @returns {Promise<boolean>}
 */
async function hasCommandAccess(interaction, db) {
    const OWNER_ID = process.env.ADMIN_USER_ID;

    // 1. サーバーオーナーは常に許可
    if (interaction.guild.ownerId === interaction.user.id) return true;

    // 2. BOT作成者（OWNER_ID）は常に許可
    if (OWNER_ID && interaction.user.id === OWNER_ID) return true;

    // 3. Administratorを持つメンバーは常に許可
    if (interaction.memberPermissions.has(PermissionsBitField.Flags.Administrator)) return true;

    // 4. コマンド固有の必要権限を直接チェック
    const requiredPerm = COMMAND_REQUIRED_PERMISSIONS[interaction.commandName];
    if (requiredPerm && interaction.memberPermissions.has(requiredPerm)) return true;

    // 5. Firebaseの許可リストに登録されているか確認
    try {
        const doc = await db.collection('command_access').doc(interaction.user.id).get();
        if (doc.exists && doc.data()?.allowed === true) return true;
    } catch (e) {
        console.error('[権限チェック] Firebaseエラー:', e);
    }

    return false;
}

/**
 * ログチャンネルにEmbedを送信する
 * @param {import('discord.js').Guild} guild
 * @param {EmbedBuilder} embed
 * @param {import('firebase-admin').firestore.Firestore} db
 */
async function sendLog(guild, embed, db) {
    if (!guild) return;
    try {
        const logDoc = await db.collection('log_settings').doc(guild.id).get();
        if (!logDoc.exists) return;
        const channelId = logDoc.data().channelId;
        const logChannel = await guild.channels.fetch(channelId).catch(() => null);
        if (logChannel) await logChannel.send({ embeds: [embed] });
    } catch (e) {
        console.error('Log Error:', e);
    }
}

/**
 * コマンド実行ログをログチャンネルに送信する
 * @param {import('discord.js').ChatInputCommandInteraction} interaction
 * @param {string} commandName
 * @param {import('firebase-admin').firestore.Firestore} db
 */
async function sendCommandLog(interaction, commandName, db) {
    const embed = new EmbedBuilder()
        .setTitle('📋 コマンド実行ログ')
        .addFields(
            { name: '使用者', value: `${interaction.user}`, inline: true },
            { name: '使用コマンド', value: `/${commandName}`, inline: true },
            { name: '日時', value: `<t:${Math.floor(Date.now() / 1000)}:F>`, inline: false }
        )
        .setColor(0x95A5A6)
        .setTimestamp();
    await sendLog(interaction.guild, embed, db);
}

module.exports = { hasCommandAccess, sendLog, sendCommandLog };
