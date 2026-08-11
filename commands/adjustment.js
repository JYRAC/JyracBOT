'use strict';

const {
    ModalBuilder,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    TextInputBuilder,
    TextInputStyle,
    MessageFlags,
} = require('discord.js');
const { sendCommandLog } = require('../utils/permissions');
const {
    MAX_CANDIDATES,
    MARKS,
    parseCandidates,
    createAdjustment,
    getAdjustment,
    setAdjustmentAnswer,
    closeAdjustment,
    buildAdjustmentEmbed,
} = require('../utils/adjustment');

/**
 * 候補日の回答ボタンを含む ActionRow 群（候補用の行 + 締め切るボタンの行）を組み立てる
 * @param {string} messageId
 * @param {number} candidateCount
 * @param {boolean} closed
 */
function buildAdjustmentRows(messageId, candidateCount, closed) {
    if (closed) return [];

    const rows = [];
    for (let i = 0; i < candidateCount; i++) {
        rows.push(new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId(`adj_o_${messageId}_${i}`).setLabel(`${i + 1}. ⭕`).setStyle(ButtonStyle.Success),
            new ButtonBuilder().setCustomId(`adj_s_${messageId}_${i}`).setLabel(`${i + 1}. 🔺`).setStyle(ButtonStyle.Secondary),
            new ButtonBuilder().setCustomId(`adj_x_${messageId}_${i}`).setLabel(`${i + 1}. ❌`).setStyle(ButtonStyle.Danger),
        ));
    }
    rows.push(new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`adj_close_${messageId}`).setLabel('🔒 締め切る（作成者のみ）').setStyle(ButtonStyle.Secondary)
    ));
    return rows;
}

/**
 * /adjustment コマンドを処理する（「調整さん」風の日程調整パネルを作るモーダルを表示する）
 * @param {import('discord.js').ChatInputCommandInteraction} interaction
 * @returns {Promise<boolean>}
 */
async function handleAdjustmentCommand(interaction) {
    if (interaction.commandName !== 'adjustment') return false;

    const modal = new ModalBuilder()
        .setCustomId('adjustment_modal')
        .setTitle('日程調整パネル作成');

    modal.addComponents(
        new ActionRowBuilder().addComponents(
            new TextInputBuilder()
                .setCustomId('adj_title')
                .setLabel('調整の件名')
                .setStyle(TextInputStyle.Short)
                .setPlaceholder('例: 8月の飲み会の日程')
                .setRequired(true)
                .setMaxLength(100)
        ),
        new ActionRowBuilder().addComponents(
            new TextInputBuilder()
                .setCustomId('adj_candidates')
                .setLabel(`候補日（1行に1件、最大${MAX_CANDIDATES}件）`)
                .setStyle(TextInputStyle.Paragraph)
                .setPlaceholder('8/10(土) 19:00\n8/11(日) 20:00\n8/12(月) 21:00')
                .setRequired(true)
        ),
        new ActionRowBuilder().addComponents(
            new TextInputBuilder()
                .setCustomId('adj_deadline')
                .setLabel('回答締切（任意）')
                .setStyle(TextInputStyle.Short)
                .setRequired(false)
                .setMaxLength(100)
        )
    );

    await interaction.showModal(modal);
    return true;
}

/**
 * adjustment_modal の送信内容を処理し、公開パネルを作成する
 * @param {import('discord.js').ModalSubmitInteraction} interaction
 * @param {import('firebase-admin').firestore.Firestore} db
 * @returns {Promise<boolean>}
 */
async function handleAdjustmentModal(interaction, db) {
    if (interaction.customId !== 'adjustment_modal') return false;

    const title = interaction.fields.getTextInputValue('adj_title');
    const deadline = interaction.fields.getTextInputValue('adj_deadline')?.trim() || null;
    const candidates = parseCandidates(interaction.fields.getTextInputValue('adj_candidates'));

    if (candidates.length === 0) {
        await interaction.editReply('❌ 候補日を1件以上入力してください。');
        return true;
    }

    const data = {
        guildId: interaction.guild.id,
        channelId: interaction.channel.id,
        creatorId: interaction.user.id,
        title,
        deadline,
        candidates,
        responses: {},
        closed: false,
    };

    const sentMessage = await interaction.channel.send({ embeds: [buildAdjustmentEmbed(data)] });
    await createAdjustment(db, sentMessage.id, data);
    await sentMessage.edit({ components: buildAdjustmentRows(sentMessage.id, candidates.length, false) });

    await interaction.editReply(
        `✅ 日程調整パネルを作成しました: ${sentMessage.url}\n（候補日は最大${MAX_CANDIDATES}件までです）`
    );
    sendCommandLog(interaction, 'adjustment', db);
    return true;
}

/**
 * 調整さんパネルのボタン（回答 / 締め切り）を処理する
 * @param {import('discord.js').ButtonInteraction} interaction
 * @param {import('firebase-admin').firestore.Firestore} db
 * @returns {Promise<boolean>}
 */
async function handleAdjustmentButton(interaction, db) {
    const { customId } = interaction;
    if (!customId.startsWith('adj_')) return false;

    // 締め切るボタン
    if (customId.startsWith('adj_close_')) {
        const messageId = customId.replace('adj_close_', '');
        const data = await getAdjustment(db, messageId);
        if (!data) {
            await interaction.reply({ content: '❌ このパネルの情報が見つかりませんでした。', flags: MessageFlags.Ephemeral });
            return true;
        }
        if (interaction.user.id !== data.creatorId) {
            await interaction.reply({ content: '❌ この調整さんを締め切れるのは作成者のみです。', flags: MessageFlags.Ephemeral });
            return true;
        }
        await closeAdjustment(db, messageId);
        const updated = await getAdjustment(db, messageId);
        await interaction.update({ embeds: [buildAdjustmentEmbed(updated)], components: [] });
        return true;
    }

    // 回答ボタン（⭕/🔺/❌）
    const match = customId.match(/^adj_(o|s|x)_(\d+)_(\d+)$/);
    if (!match) return false;

    const [, markKey, messageId, indexStr] = match;
    const candidateIndex = parseInt(indexStr, 10);

    const data = await getAdjustment(db, messageId);
    if (!data) {
        await interaction.reply({ content: '❌ このパネルの情報が見つかりませんでした。', flags: MessageFlags.Ephemeral });
        return true;
    }
    if (data.closed) {
        await interaction.reply({ content: '🔒 この調整さんは締め切られています。', flags: MessageFlags.Ephemeral });
        return true;
    }

    await setAdjustmentAnswer(db, messageId, interaction.user.id, interaction.user.username, candidateIndex, markKey);
    const updated = await getAdjustment(db, messageId);

    await interaction.update({
        embeds: [buildAdjustmentEmbed(updated)],
        components: buildAdjustmentRows(messageId, data.candidates.length, false),
    });

    await interaction.followUp({
        content: `✅ 「${data.candidates[candidateIndex]}」への回答を ${MARKS[markKey]} で記録しました。`,
        flags: MessageFlags.Ephemeral,
    }).catch(() => {});
    return true;
}

module.exports = { handleAdjustmentCommand, handleAdjustmentModal, handleAdjustmentButton };
