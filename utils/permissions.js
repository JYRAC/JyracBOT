'use strict';

const { EmbedBuilder, PermissionsBitField } = require('discord.js');

/**
 * Discord権限フラグ → 日本語の権限名 対応表
 * Bot権限不足のエラーを未然に防ぐためのメッセージ表示に利用する
 */
const PERMISSION_NAME_JA = {
    ManageMessages:      'メッセージの管理',
    ManageRoles:         'ロールの管理',
    ManageChannels:      'チャンネルの管理',
    ViewChannel:         'チャンネルを見る',
    SendMessages:        'メッセージを送信',
    EmbedLinks:          '埋め込みリンク',
    AttachFiles:         'ファイルを添付',
    ManageGuild:         'サーバー管理',
    KickMembers:         'メンバーをキック',
    BanMembers:          'メンバーをBAN',
    ModerateMembers:     'タイムアウト',
    ReadMessageHistory:  'メッセージ履歴を読む',
};

/**
 * 指定したチャンネルでBotが必要な権限を持っているか事前チェックする
 * 権限が不足している場合、不足している権限名のリストを返す（空配列なら問題なし）
 * @param {import('discord.js').GuildChannel} channel
 * @param {import('discord.js').ClientUser} botUser
 * @param {bigint[]} requiredFlags PermissionsBitField.Flags の配列
 * @returns {string[]} 不足している権限の日本語名リスト
 */
function getMissingBotPermissions(channel, botUser, requiredFlags) {
    if (!channel || !channel.guild) return [];
    const botMember = channel.guild.members.me;
    if (!botMember) return [];

    const permissions = channel.permissionsFor(botMember);
    if (!permissions) return requiredFlags.map(f => PERMISSION_NAME_JA[flagName(f)] ?? flagName(f));

    const missing = [];
    for (const flag of requiredFlags) {
        if (!permissions.has(flag)) {
            const name = flagName(flag);
            missing.push(PERMISSION_NAME_JA[name] ?? name);
        }
    }
    return missing;
}

/**
 * PermissionsBitField.Flags の値からキー名（英語）を逆引きする
 */
function flagName(flag) {
    const entry = Object.entries(PermissionsBitField.Flags).find(([, v]) => v === flag);
    return entry ? entry[0] : String(flag);
}

/**
 * Bot権限不足を未然にチェックし、不足していればephemeralでエラーメッセージを返す
 * 呼び出し元は戻り値が true の場合、処理を中断すること
 * @param {import('discord.js').ChatInputCommandInteraction|import('discord.js').ButtonInteraction} interaction
 * @param {bigint[]} requiredFlags
 * @param {{replied?: boolean, deferred?: boolean}} [opts]
 * @returns {Promise<boolean>} true: 権限不足のため中断すべき / false: 権限OK
 */
async function checkBotPermissionsOrReply(interaction, requiredFlags) {
    const missing = getMissingBotPermissions(interaction.channel, interaction.client.user, requiredFlags);
    if (missing.length === 0) return false;

    const content =
        `❌ 権限がありません。\n` +
        `以下のDiscord権限をBOTに付与してください。\n` +
        missing.map(name => `・**${name}**`).join('\n');

    if (interaction.deferred || interaction.replied) {
        await interaction.editReply({ content, components: [] }).catch(() => {});
    } else {
        await interaction.reply({ content, flags: 64 }).catch(() => {});
    }
    return true;
}

/**
 * ユーザーがコマンドを使用できるか判定する
 * Firebase の command_access コレクションに登録されているかのみで判定する
 * @param {import('discord.js').ChatInputCommandInteraction} interaction
 * @param {import('firebase-admin').firestore.Firestore} db
 * @returns {Promise<boolean>}
 */
async function hasCommandAccess(interaction, db) {
    // ENV に指定された管理者(作成者)は権限チェックを無条件でパスする
    if (interaction.user.id === process.env.ADMIN_USER_ID) return true;

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

module.exports = { hasCommandAccess, sendLog, sendCommandLog, checkBotPermissionsOrReply, getMissingBotPermissions };
