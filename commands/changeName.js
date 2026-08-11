'use strict';

const {
    EmbedBuilder,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    ModalBuilder,
    TextInputBuilder,
    TextInputStyle,
    MessageFlags,
    PermissionsBitField,
} = require('discord.js');
const { sendCommandLog, sendLog, checkBotPermissionsOrReply } = require('../utils/permissions');
const { saveChangeNamePanel, getChangeNamePanel } = require('../utils/changeName');

/**
 * /change-name コマンドを処理する
 * パネル＋ボタンを設置し、ボタンを押したユーザー本人がモーダルで入力した名前に
 * ニックネームを自動で変更する仕組み
 * @param {import('discord.js').ChatInputCommandInteraction} interaction
 * @param {import('firebase-admin').firestore.Firestore} db
 * @returns {Promise<boolean>}
 */
async function handleChangeNameCommand(interaction, db) {
    if (interaction.commandName !== 'change-name') return false;

    if (await checkBotPermissionsOrReply(interaction, [
        PermissionsBitField.Flags.ManageNicknames,
    ])) return true;

    const title       = interaction.options.getString('title') ?? '名前変更パネル';
    const description = interaction.options.getString('description') ?? '下のボタンを押して、変更したい名前を入力してください。';
    const modalTitle  = interaction.options.getString('modal-title') ?? '名前の変更';

    const key = `cn_${Date.now()}`;
    await saveChangeNamePanel(db, key, {
        guildId: interaction.guild.id,
        modalTitle,
        inputLabel: '新しい名前',
    });

    const embed = new EmbedBuilder()
        .setTitle(title)
        .setDescription(description)
        .setColor(0xF39C12);

    const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId(`cn_${key}`)
            .setLabel('✏️ 名前を変更する')
            .setStyle(ButtonStyle.Primary)
    );

    // 公開メッセージとしてチャンネルに送信
    await interaction.channel.send({ embeds: [embed], components: [row] });
    // コマンド実行者への確認（ephemeral）
    await interaction.editReply({ content: '✅ 名前変更パネルを設置しました。' });
    sendCommandLog(interaction, 'change-name', db);
    return true;
}

/**
 * 名前変更パネルのボタンを処理する（モーダルを即時表示する）
 * @param {import('discord.js').ButtonInteraction} interaction
 * @param {import('firebase-admin').firestore.Firestore} db
 * @returns {Promise<boolean>}
 */
async function handleChangeNameButton(interaction, db) {
    if (!interaction.customId.startsWith('cn_')) return false;

    const key = interaction.customId.slice('cn_'.length);
    const panel = await getChangeNamePanel(db, key);
    const modalTitle  = panel?.modalTitle ?? '名前の変更';
    const inputLabel  = panel?.inputLabel ?? '新しい名前';

    const modal = new ModalBuilder()
        .setCustomId(`cn_modal_${key}`)
        .setTitle(modalTitle.slice(0, 45));

    modal.addComponents(
        new ActionRowBuilder().addComponents(
            new TextInputBuilder()
                .setCustomId('cn_new_name')
                .setLabel(inputLabel.slice(0, 45))
                .setStyle(TextInputStyle.Short)
                .setRequired(true)
                .setMaxLength(32)
        )
    );

    await interaction.showModal(modal);
    return true;
}

/**
 * 名前変更モーダルの送信内容を処理し、実行者本人のニックネームを変更する
 * @param {import('discord.js').ModalSubmitInteraction} interaction
 * @param {import('firebase-admin').firestore.Firestore} db
 * @returns {Promise<boolean>}
 */
async function handleChangeNameModal(interaction, db) {
    if (!interaction.customId.startsWith('cn_modal_')) return false;

    const newName = interaction.fields.getTextInputValue('cn_new_name');

    try {
        await interaction.member.setNickname(newName);
        await interaction.editReply({ content: `✅ 名前を **${newName}** に変更しました。` });

        sendLog(interaction.guild, new EmbedBuilder()
            .setTitle('✏️ 名前変更ログ')
            .addFields(
                { name: '使用者',     value: `${interaction.user}`, inline: true },
                { name: '使用コマンド', value: '/change-name パネル', inline: true },
                { name: '日時',       value: `<t:${Math.floor(Date.now() / 1000)}:F>`, inline: false },
                { name: '変更後の名前', value: newName, inline: false }
            )
            .setColor(0xF39C12)
            .setTimestamp(),
            db
        );
    } catch (e) {
        console.error('[change-name] ニックネーム変更エラー:', e);
        await interaction.editReply({ content: '❌ 名前の変更に失敗しました。Botのロール順位や権限（ニックネームの管理）を確認してください。' });
    }
    return true;
}

module.exports = { handleChangeNameCommand, handleChangeNameButton, handleChangeNameModal };
