'use strict';

const {
    ModalBuilder,
    ActionRowBuilder,
    TextInputBuilder,
    TextInputStyle,
} = require('discord.js');
const { sendCommandLog } = require('../utils/permissions');

/**
 * /entry-message コマンドを処理する
 * 新規メンバー参加時に送信するDMメッセージを設定するモーダルを表示する
 * @param {import('discord.js').ChatInputCommandInteraction} interaction
 * @param {import('firebase-admin').firestore.Firestore} db
 * @returns {Promise<boolean>} 処理した場合 true
 */
async function handleEntryMessageCommand(interaction, db) {
    if (interaction.commandName !== 'entry-message') return false;

    const modal = new ModalBuilder()
        .setCustomId('entry_message_modal')
        .setTitle('入室時DMメッセージ設定');

    modal.addComponents(
        new ActionRowBuilder().addComponents(
            new TextInputBuilder()
                .setCustomId('entry_text')
                .setLabel('新規メンバーへ送信するDMメッセージ')
                .setStyle(TextInputStyle.Paragraph)
                .setRequired(true)
                .setMaxLength(2000)
        )
    );

    await interaction.showModal(modal);
    sendCommandLog(interaction, interaction.commandName, db);
    return true;
}

/**
 * entry_message_modal の送信内容を処理する
 * 入力されたテキストをそのままサーバーの入室時DMメッセージとしてFirebaseに保存する
 * @param {import('discord.js').ModalSubmitInteraction} interaction
 * @param {import('firebase-admin').firestore.Firestore} db
 * @returns {Promise<boolean>} 処理した場合 true
 */
async function handleEntryMessageModal(interaction, db) {
    if (interaction.customId !== 'entry_message_modal') return false;

    const textContent = interaction.fields.getTextInputValue('entry_text');

    await db.collection('entry_message_settings').doc(interaction.guild.id).set({
        message: textContent,
        guildName: interaction.guild.name,
        setBy: interaction.user.id,
        updatedAt: new Date(),
    });

    await interaction.editReply(
        '✅ 新規メンバー参加時に送信するDMメッセージを設定しました。\n次回以降、このサーバーに新しく参加したメンバーへ自動でDM送信されます。'
    );
    return true;
}

/**
 * GuildMemberAdd イベントを処理する
 * サーバーに設定されている入室時DMメッセージを、参加した新規メンバーへ送信する
 * @param {import('discord.js').GuildMember} member
 * @param {import('firebase-admin').firestore.Firestore} db
 */
async function handleGuildMemberAdd(member, db) {
    if (member.user.bot) return;

    try {
        const doc = await db.collection('entry_message_settings').doc(member.guild.id).get();
        if (!doc.exists) return;

        const { message } = doc.data();
        if (!message) return;

        await member.send(message);
    } catch (e) {
        // DMを閉じているユーザーなど、送信できない場合はエラーを無視する
        console.error('[entry-message] DM送信エラー:', e);
    }
}

module.exports = { handleEntryMessageCommand, handleEntryMessageModal, handleGuildMemberAdd };
