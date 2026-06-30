'use strict';

const { EmbedBuilder, MessageFlags } = require('discord.js');
const { sendLog } = require('../utils/permissions');

/**
 * オーナー専用コマンドを処理する
 * @param {import('discord.js').ChatInputCommandInteraction} interaction
 * @param {import('firebase-admin').firestore.Firestore} db
 * @returns {Promise<boolean>} 処理した場合 true
 */
async function handleAdminCommand(interaction, db) {
    const { commandName, options } = interaction;
    const OWNER_ID = process.env.ADMIN_USER_ID;

    if (!['grant-access', 'revoke-access', 'list-access'].includes(commandName)) return false;

    if (!OWNER_ID || interaction.user.id !== OWNER_ID) {
        await interaction.reply({
            content: '❌ このコマンドはボットオーナーのみ実行できます。',
            flags: MessageFlags.Ephemeral
        });
        return true;
    }

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    // /grant-access
    if (commandName === 'grant-access') {
        const target = options.getUser('target');
        await db.collection('command_access').doc(target.id).set({
            allowed: true,
            username: target.username,
            grantedBy: interaction.user.id,
            grantedTimestamp: new Date(),
        });

        const logEmbed = new EmbedBuilder()
            .setTitle('🔓 コマンド許可ログ')
            .addFields(
                { name: '操作者',     value: `${interaction.user}`,               inline: true },
                { name: '対象ユーザー', value: `${target} (${target.username})`, inline: true },
                { name: '操作',       value: '許可付与',                          inline: true },
                { name: '日時',       value: `<t:${Math.floor(Date.now() / 1000)}:F>`, inline: false }
            )
            .setColor(0x2ECC71)
            .setTimestamp();
        sendLog(interaction.guild, logEmbed, db);

        await interaction.editReply(`✅ **${target.username}** にコマンド使用許可を付与しました。`);
        return true;
    }

    // /revoke-access
    if (commandName === 'revoke-access') {
        const target = options.getUser('target');
        const doc = await db.collection('command_access').doc(target.id).get();

        if (!doc.exists || !doc.data()?.allowed) {
            await interaction.editReply(`❌ **${target.username}** はコマンド許可リストに登録されていません。`);
            return true;
        }

        await db.collection('command_access').doc(target.id).delete();

        const logEmbed = new EmbedBuilder()
            .setTitle('🔒 コマンド許可解除ログ')
            .addFields(
                { name: '操作者',     value: `${interaction.user}`,               inline: true },
                { name: '対象ユーザー', value: `${target} (${target.username})`, inline: true },
                { name: '操作',       value: '許可解除',                          inline: true },
                { name: '日時',       value: `<t:${Math.floor(Date.now() / 1000)}:F>`, inline: false }
            )
            .setColor(0xE74C3C)
            .setTimestamp();
        sendLog(interaction.guild, logEmbed, db);

        await interaction.editReply(`✅ **${target.username}** のコマンド使用許可を解除しました。`);
        return true;
    }

    // /list-access
    if (commandName === 'list-access') {
        const snap = await db.collection('command_access').where('allowed', '==', true).get();

        if (snap.empty) {
            await interaction.editReply('📋 現在、コマンド使用を許可しているユーザーはいません。');
            return true;
        }

        const lines = snap.docs.map(d => {
            const data = d.data();
            const ts = data.grantedTimestamp?.toDate
                ? Math.floor(data.grantedTimestamp.toDate().getTime() / 1000)
                : null;
            const timeStr = ts ? `<t:${ts}:f>` : '不明';
            return `・**${data.username ?? d.id}** (ID: \`${d.id}\`) — 付与日時: ${timeStr}`;
        });

        const embed = new EmbedBuilder()
            .setTitle('📋 コマンド使用許可ユーザー一覧')
            .setDescription(lines.join('\n'))
            .setColor(0x3498DB)
            .setTimestamp();

        await interaction.editReply({ embeds: [embed] });
        return true;
    }

    return false;
}

module.exports = { handleAdminCommand };
