'use strict';

const fs = require('fs');
const path = require('path');
const { EmbedBuilder, AttachmentBuilder, PermissionFlagsBits } = require('discord.js');
const { fetchAllMessages, formatMessagesToText } = require('../utils/export');
const { sendLog, sendCommandLog } = require('../utils/permissions');

/**
 * /export コマンドを処理する
 * @param {import('discord.js').ChatInputCommandInteraction} interaction
 * @param {import('firebase-admin').firestore.Firestore} db
 * @returns {Promise<boolean>}
 */
async function handleExportCommand(interaction, db) {
    if (interaction.commandName !== 'export') return false;

    const { options } = interaction;
    const targetChannel = options.getChannel('channel') || interaction.channel;
    const limit  = options.getInteger('limit') ?? null;
    const before = options.getString('before') || undefined;
    const after  = options.getString('after')  || undefined;

    if (!targetChannel.isTextBased()) {
        await interaction.editReply('❌ テキストチャンネルのみエクスポート可能です。');
        return true;
    }

    const perms = targetChannel.permissionsFor(interaction.guild.members.me);
    if (!perms.has(PermissionFlagsBits.ReadMessageHistory)) {
        await interaction.editReply('❌ Botにメッセージ履歴の読み取り権限がありません。');
        return true;
    }

    try {
        const limitLabel = limit !== null ? `最大 ${limit} 件` : '全件';
        await interaction.editReply(`⏳ **#${targetChannel.name}** のメッセージを取得中... (${limitLabel})`);

        const messages = await fetchAllMessages(targetChannel, { limit, before, after });

        if (messages.length === 0) {
            await interaction.editReply('⚠️ 取得できるメッセージがありませんでした。');
            return true;
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
                { name: '使用者',     value: `${interaction.user}`,                    inline: true },
                { name: '使用コマンド', value: '/export',                              inline: true },
                { name: '日時',       value: `<t:${Math.floor(Date.now() / 1000)}:F>`, inline: false },
                { name: 'チャンネル', value: `${targetChannel}`,                       inline: true },
                { name: '取得件数',   value: `${messages.length} 件`,                  inline: true }
            )
            .setColor(0x1ABC9C)
            .setTimestamp();
        sendLog(interaction.guild, logEmbed, db);

    } catch (err) {
        console.error('エクスポートエラー:', err);
        await interaction.editReply(`❌ エラーが発生しました: \`${err.message}\``);
    }

    sendCommandLog(interaction, 'export', db);
    return true;
}

module.exports = { handleExportCommand };
