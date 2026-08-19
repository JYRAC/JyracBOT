'use strict';

const {
    EmbedBuilder,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    ChannelType,
    PermissionsBitField,
    MessageFlags,
} = require('discord.js');
const { sendLog, checkBotPermissionsOrReply } = require('../utils/permissions');
const { getTicketCategory } = require('../utils/ticketCategory');
const { getTicketPanel } = require('../utils/ticketPanel');
const { handleEntryMessageModal } = require('../commands/entryMessage');
const { handleChangeNameButton, handleChangeNameModal } = require('../commands/changeName');
const { handleAdjustmentModal, handleAdjustmentButton } = require('../commands/adjustment');

/**
 * チケットチャンネルを作成し、パネル埋め込み＋閉じるボタンを送信する共通処理
 * ボタン形式（カテゴリー未登録）・セレクトメニュー形式（カテゴリー選択）の両方から呼ばれる
 * @param {import('discord.js').ButtonInteraction|import('discord.js').StringSelectMenuInteraction} interaction 事前に reply 済み（ephemeral）であること
 * @param {import('firebase-admin').firestore.Firestore} db
 * @param {{adminRoleId: string, panelDesc: string, parentId?: string|null}} opts
 */
async function createTicketChannel(interaction, db, opts) {
    const { adminRoleId, panelDesc, parentId } = opts;

    if (await checkBotPermissionsOrReply(interaction, [
        PermissionsBitField.Flags.ManageChannels,
    ])) return;

    try {
        const channel = await interaction.guild.channels.create({
            name: `🎫｜${interaction.user.username}`,
            type: ChannelType.GuildText,
            parent: parentId ?? undefined,
            permissionOverwrites: [
                { id: interaction.guild.id,  deny:  [PermissionsBitField.Flags.ViewChannel] },
                { id: interaction.user.id,   allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages] },
                { id: adminRoleId,            allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages] }
            ]
        });

        const ticketEmbed = new EmbedBuilder()
            .setTitle('Ticket')
            .addFields(
                { name: '発行者',     value: `${interaction.user}` },
                { name: 'メッセージ', value: panelDesc }
            )
            .setColor(0x9B59B6)
            .setTimestamp();

        await channel.send({
            content: `<@&${adminRoleId}>`,
            embeds: [ticketEmbed],
            components: [
                new ActionRowBuilder().addComponents(
                    new ButtonBuilder().setCustomId('t_close').setLabel('チケットを閉じる').setStyle(ButtonStyle.Danger)
                )
            ]
        });

        await interaction.editReply({ content: `✅ チケットを作成しました: ${channel}` });

        sendLog(interaction.guild, new EmbedBuilder()
            .setTitle('🎫 チケット作成ログ')
            .addFields(
                { name: '使用者',     value: `${interaction.user}`, inline: true },
                { name: '使用コマンド', value: 'チケット作成ボタン', inline: true },
                { name: '日時',       value: `<t:${Math.floor(Date.now() / 1000)}:F>`, inline: false },
                { name: 'チャンネル', value: `${channel}`,          inline: false }
            )
            .setColor(0x3498DB)
            .setTimestamp(),
            db
        );
    } catch (e) {
        console.error('[ticket] チャンネル作成エラー:', e);
        await interaction.editReply({ content: '❌ チャンネルの作成に失敗しました。' });
    }
}

// ─── ボタン操作 ────────────────────────────────────────────────

/**
 * ボタンインタラクションを処理する
 * @param {import('discord.js').ButtonInteraction} interaction
 * @param {import('firebase-admin').firestore.Firestore} db
 * @param {Map<string, string|null>} ticketMessages
 */
async function handleButton(interaction, db, ticketMessages) {
    const { customId } = interaction;

    // 名前変更ボタン（即座にモーダルを表示する必要があるため最初に処理する）
    if (customId.startsWith('cn_') && !customId.startsWith('cn_modal_')) {
        if (await handleChangeNameButton(interaction, db)) return;
    }

    // 調整さんパネルのボタン（回答 / 締め切り）
    if (customId.startsWith('adj_')) {
        if (await handleAdjustmentButton(interaction, db)) return;
    }

    // 認証ボタン
    if (customId.startsWith('v_role_')) {
        const roleId = customId.split('_')[2];

        // 実行前に権限を事前チェックし、未然にエラーを防ぐ
        if (await checkBotPermissionsOrReply(interaction, [
            PermissionsBitField.Flags.ManageRoles,
        ])) return;

        await interaction.reply({ content: '認証を処理しています...', flags: MessageFlags.Ephemeral });
        try {
            await interaction.member.roles.add(roleId);
            await interaction.editReply({ content: '✅ 認証が完了しました！ロールを付与しました。' });

            sendLog(interaction.guild, new EmbedBuilder()
                .setTitle('🔐 認証ログ')
                .addFields(
                    { name: '使用者',     value: `${interaction.user}`, inline: true },
                    { name: '使用コマンド', value: '認証ボタン',        inline: true },
                    { name: '日時',       value: `<t:${Math.floor(Date.now() / 1000)}:F>`, inline: false },
                    { name: '取得ロール', value: `<@&${roleId}>`,       inline: false }
                )
                .setColor(0x2ECC71)
                .setTimestamp(),
                db
            );
        } catch {
            await interaction.editReply({ content: '❌ ロールの付与に失敗しました。Botのロール順位を確認してください。' });
        }
        return;
    }

    // ロール解除ボタン
    if (customId.startsWith('uv_role_')) {
        const roleId = customId.split('_')[2];

        // 実行前に権限を事前チェックし、未然にエラーを防ぐ
        if (await checkBotPermissionsOrReply(interaction, [
            PermissionsBitField.Flags.ManageRoles,
        ])) return;

        await interaction.reply({ content: '解除を処理しています...', flags: MessageFlags.Ephemeral });
        try {
            await interaction.member.roles.remove(roleId);
            await interaction.editReply({ content: '✅ ロールを解除しました。' });

            sendLog(interaction.guild, new EmbedBuilder()
                .setTitle('🔓 解除ログ')
                .addFields(
                    { name: '使用者',     value: `${interaction.user}`, inline: true },
                    { name: '使用コマンド', value: '解除ボタン',        inline: true },
                    { name: '日時',       value: `<t:${Math.floor(Date.now() / 1000)}:F>`, inline: false },
                    { name: '解除ロール', value: `<@&${roleId}>`,       inline: false }
                )
                .setColor(0xE74C3C)
                .setTimestamp(),
                db
            );
        } catch {
            await interaction.editReply({ content: '❌ ロールの解除に失敗しました。Botのロール順位を確認してください。' });
        }
        return;
    }

    // 一括削除確認
    if (customId.startsWith('bulk_yes_')) {
        const amount = parseInt(customId.split('_')[2]);
        const chName = interaction.channel.name;

        // 実行前に権限を事前チェックし、未然にエラーを防ぐ
        if (await checkBotPermissionsOrReply(interaction, [
            PermissionsBitField.Flags.ManageMessages,
        ])) return;

        await interaction.update({ content: 'メッセージを削除しています...', components: [] });
        try {
            if (amount === 1) {
                // Discordのbulk delete APIは2件未満の削除に対応していないため、
                // 1件のみの場合はチャンネル内の直近メッセージを個別に取得して削除する
                const recent = await interaction.channel.messages.fetch({ limit: 1 });
                const target = recent.first();
                if (target) await target.delete();
            } else {
                await interaction.channel.bulkDelete(amount, true);
            }
            sendLog(interaction.guild, new EmbedBuilder()
                .setTitle('🗑️ メッセージ削除ログ')
                .addFields(
                    { name: '使用者',     value: `${interaction.user}`, inline: true },
                    { name: '使用コマンド', value: '/delete',           inline: true },
                    { name: '日時',       value: `<t:${Math.floor(Date.now() / 1000)}:F>`, inline: false },
                    { name: 'チャンネル', value: `**#${chName}**`,      inline: true },
                    { name: '削除件数',   value: `${amount}件`,         inline: true }
                )
                .setColor(0xE74C3C)
                .setTimestamp(),
                db
            );
        } catch (e) {
            console.error(e);
            if (e.code === 50013) {
                // Discord側でBotにメッセージの管理権限が付与されていない場合
                await interaction.followUp({
                    content: '❌ メッセージを削除できませんでした。\nBotのロールに **「メッセージの管理」** 権限が付与されているか確認してください。\n（サーバー設定 → ロール → Botのロール → 権限 → メッセージの管理 をON）',
                    flags: MessageFlags.Ephemeral
                }).catch(() => {});
            } else {
                await interaction.followUp({
                    content: '❌ メッセージの削除中にエラーが発生しました。',
                    flags: MessageFlags.Ephemeral
                }).catch(() => {});
            }
        }
        return;
    }

    // チケット作成ボタン（カテゴリー未登録時のシンプルな1ボタン形式）
    if (customId.startsWith('tkt_') && !customId.startsWith('tkt_cat_')) {
        const parts       = customId.split('_');
        const adminRoleId = parts[1];
        const key         = parts.slice(2).join('_');

        await interaction.reply({ content: 'チケットチャンネルを作成しています...', flags: MessageFlags.Ephemeral });

        let customDesc = ticketMessages.get(key);
        if (customDesc === undefined) {
            // Bot再起動でメモリキャッシュが消えている場合はFirestoreから復元する
            const panel = await getTicketPanel(db, key);
            customDesc = panel?.panelDesc ?? null;
        }
        const panelDesc = customDesc != null ? customDesc : '発行ありがとうございます。担当者が来るのを今しばらくお待ちください。';

        await createTicketChannel(interaction, db, { adminRoleId, panelDesc });
        return;
    }

    // チケットを閉じる
    if (customId === 't_close') {
        await interaction.reply({ content: 'チケットを2秒後に削除します...', flags: MessageFlags.Ephemeral });
        sendLog(interaction.guild, new EmbedBuilder()
            .setTitle('🔒 チケット終了ログ')
            .addFields(
                { name: '使用者',     value: `${interaction.user}`,               inline: true },
                { name: '使用コマンド', value: 'チケットを閉じるボタン',          inline: true },
                { name: '日時',       value: `<t:${Math.floor(Date.now() / 1000)}:F>`, inline: false },
                { name: 'チャンネル', value: `**#${interaction.channel.name}**`, inline: false }
            )
            .setColor(0x607D8B)
            .setTimestamp(),
            db
        );
        setTimeout(() => { interaction.channel.delete().catch(() => {}); }, 2000);
        return;
    }

    // 通知解除
    if (customId === 'n_rem') {
        await db.collection('subscribers').doc(interaction.user.id).delete();
        await interaction.update({ content: '🗑️ 通知登録を解除しました。', components: [] });
        return;
    }

    // キャンセル
    if (customId === 'bulk_no') {
        await interaction.update({ content: '操作をキャンセルしました。', components: [] });
        return;
    }
}

// ─── モーダル送信 ──────────────────────────────────────────────

/**
 * モーダルサブミットインタラクションを処理する
 * @param {import('discord.js').ModalSubmitInteraction} interaction
 * @param {import('discord.js').Client} client
 * @param {import('firebase-admin').firestore.Firestore} db
 * @param {Map<string, string>} broadcastRoleMap
 */
async function handleModal(interaction, client, db, broadcastRoleMap) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    // /entry-message モーダル（入室時DMメッセージの設定）
    if (interaction.customId === 'entry_message_modal') {
        await handleEntryMessageModal(interaction, db);
        return;
    }

    // 名前変更パネルのモーダル
    if (interaction.customId.startsWith('cn_modal_')) {
        await handleChangeNameModal(interaction, db);
        return;
    }

    // /adjustment モーダル（日程調整パネルの作成）
    if (interaction.customId === 'adjustment_modal') {
        await handleAdjustmentModal(interaction, db);
        return;
    }

    // /request モーダル
    if (interaction.customId === 'req_modal') {
        const embed = new EmbedBuilder()
            .setTitle('📩 新規コマンド作成依頼')
            .addFields(
                { name: '依頼者',     value: interaction.fields.getTextInputValue('r_name') },
                { name: '希望コマンド', value: interaction.fields.getTextInputValue('r_cmd') },
                { name: '機能詳細',   value: interaction.fields.getTextInputValue('r_desc') }
            )
            .setColor(0xFFA500);
        try {
            const adminUser = await client.users.fetch(process.env.ADMIN_USER_ID);
            await adminUser.send({ embeds: [embed] });
            await interaction.editReply('✅ 開発者宛てに依頼を送信しました！');
        } catch {
            await interaction.editReply('❌ 送信に失敗しました。環境変数を確認してください。');
        }
        return;
    }

    // /notice モーダル
    if (interaction.customId === 'notice_modal') {
        const textContent = interaction.fields.getTextInputValue('dm_text');
        const subs = await db.collection('subscribers').get();
        let count = 0;
        for (const doc of subs.docs) {
            try {
                const u = await client.users.fetch(doc.id);
                await u.send(`📢 **重要なお知らせ**\n\n${textContent}`);
                count++;
            } catch {}
        }
        await interaction.editReply(`✅ 登録ユーザー ${count} 名にお知らせを送信しました。`);
        return;
    }

    // /broadcast モーダル
    if (interaction.customId === 'broadcast_modal') {
        const roleId = broadcastRoleMap.get(interaction.user.id);
        if (!roleId) {
            await interaction.editReply('❌ セッションが切れました。もう一度コマンドからやり直してください。');
            return;
        }
        broadcastRoleMap.delete(interaction.user.id);

        const speaker     = interaction.fields.getTextInputValue('dm_speaker');
        const textContent = interaction.fields.getTextInputValue('dm_text');
        const url         = interaction.fields.getTextInputValue('dm_url').trim();

        const dmEmbed = new EmbedBuilder()
            .setTitle('📢 お知らせ')
            .addFields(
                { name: '発言者', value: speaker },
                { name: '内容',   value: textContent }
            )
            .setColor(0xE67E22)
            .setTimestamp();

        if (url) dmEmbed.addFields({ name: 'URL', value: url });

        const members = (await interaction.guild.members.fetch())
            .filter(m => m.roles.cache.has(roleId) && !m.user.bot);
        let count = 0;
        for (const [, m] of members) {
            try {
                await m.send({ embeds: [dmEmbed] });
                count++;
                await new Promise(r => setTimeout(r, 800));
            } catch {}
        }
        await interaction.editReply(`✅ 指定ロールのメンバー ${count} 名にDMを送信しました。`);
        return;
    }
}

// ─── セレクトメニュー ──────────────────────────────────────────

/**
 * セレクトメニューインタラクションを処理する
 * @param {import('discord.js').StringSelectMenuInteraction} interaction
 */
async function handleSelectMenu(interaction, db) {
    // チケットのカテゴリー選択（/ticket panel でカテゴリーが登録されている場合）
    if (interaction.customId.startsWith('tkt_cat_')) {
        const parts          = interaction.customId.split('_');
        const defaultRoleId  = parts[2];
        const key            = parts.slice(3).join('_');
        const categoryName   = interaction.values[0];

        await interaction.reply({ content: 'チケットチャンネルを作成しています...', flags: MessageFlags.Ephemeral });

        const category = await getTicketCategory(db, interaction.guild.id, categoryName);
        const panel = await getTicketPanel(db, key);
        const fallbackDesc = panel?.panelDesc ?? null;

        await createTicketChannel(interaction, db, {
            adminRoleId: category?.adminRoleId ?? defaultRoleId,
            panelDesc: category?.panelDesc ?? fallbackDesc ?? '発行ありがとうございます。担当者が来るのを今しばらくお待ちください。',
            parentId: category?.parentId ?? null,
        });
        return;
    }

    if (interaction.customId !== 'help_select') return;

    const value = interaction.values[0];
    const helpTexts = {
        h_verify:    '**/verify**\nロール管理権限が必要です。パネル＋ボタン形式の認証パネルを設置します。ボタンを押すと指定したロールが付与されます。',
        h_verifies:  '**/verifies**\nロール管理権限が必要です。最大15ロール対応のリアクション式認証パネルを設置します。`role-1`〜`role-15` の順に固定の絵文字（1️⃣2️⃣…🇪）と同期し、リアクションを押すと対応ロールが付与されます。',
        h_ticket:    '**/ticket**\nチャンネル管理権限が必要です。\n・`panel`: チケットパネルを設置します。\n・`category-add` / `category-remove` / `category-list`: チケット作成時に選べるカテゴリー（対応ロールや作成先カテゴリーを個別に設定可）を管理します。カテゴリーが1件以上登録されている状態でパネルを設置すると、チケット作成時にセレクトメニューでカテゴリーを選べるようになります。',
        h_changename:'**/change-name**\nニックネームの管理権限が必要です。名前変更パネルを設置します。ボタンを押すとモーダルが表示され、入力した名前が押した本人のニックネームに自動で変更されます。',
        h_adjustment:'**/adjustment**\n「調整さん」風の日程調整パネルを作成します（最大4候補）。候補ごとの⭕🔺❌ボタンを押して回答し、作成者は🔒ボタンで締め切れます。',
        h_entrymessage:'**/entry-message**\nモーダルで入力した内容を、以降このサーバーに参加した新規メンバーへ自動でDM送信します。',
        h_log:       '**/log**\n管理者権限が必要です。認証や一括削除のアクションが行われた際に送信されるログチャンネルの指定・解除を行います。',
        h_role:      '**/role-confirmation**\nモデレーター権限が必要です。対象のユーザーが現在持っている全ロールの一覧を表示します。',
        h_export:    '**/export**\nメッセージ管理権限が必要です。指定したチャンネルのメッセージを.txtファイルにエクスポートします。\nオプション: `channel` `limit(1〜10000)` `before` `after`',
        h_earthquake:'**/earthquake-setup**\nチャンネル管理権限が必要です。地震情報をリアルタイムで通知するチャンネルを設定します。\n`channel` を省略すると設定を解除します。\nデータ元: 気象庁非公式JSON API\n通知される情報: 震度速報（震度3以上）・震源に関する情報・震源・震度情報（確定報）',
        h_eqtest:    '**/earthquake-test**\nチャンネル管理権限が必要です。設定済みの通知チャンネルに疑似地震通知を送信して表示を確認できます。\ntype:\n　・震源・震度情報（確定報）\n　・EEW形式\n　・震度速報→震源情報→確定報 の連続テスト\n　・津波警報・注意報\nlocation: 震源地プリセット（省略時はランダム）',
        h_nerv:      '**/weather-nerv**\n特務機関NERVの気象警報・注意報・地震情報などを都道府県名で検索し、最新の1件を表示します。\nprefecture: 都道府県名（例: 東京都、大阪府、福岡県、北海道）\nデータ元: 特務機関NERV (@UN_NERV) RSS',
    };

    const helpText = helpTexts[value] ?? '詳細情報が見つかりません。';
    await interaction.update({ content: `📜 **ヘルプ詳細**\n\n${helpText}`, components: [interaction.message.components[0]] });
}

module.exports = { handleButton, handleModal, handleSelectMenu };
