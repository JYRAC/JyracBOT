'use strict';

const {
    EmbedBuilder,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    StringSelectMenuBuilder,
    MessageFlags,
    PermissionsBitField,
} = require('discord.js');
const { sendCommandLog, sendLog, checkBotPermissionsOrReply } = require('../utils/permissions');
const { saveVerifyPanel } = require('../utils/verifyPanel');
const {
    addTicketCategory,
    removeTicketCategory,
    listTicketCategories,
} = require('../utils/ticketCategory');
const { saveTicketPanel } = require('../utils/ticketPanel');

/** /verifies で使用する固定の絵文字プリセット（最大15個・1番目から順にロールと同期する） */
const VERIFIES_EMOJIS = ['1️⃣', '2️⃣', '3️⃣', '4️⃣', '5️⃣', '6️⃣', '7️⃣', '8️⃣', '9️⃣', '🔟', '🇦', '🇧', '🇨', '🇩', '🇪'];

/**
 * モデレーション系コマンドを処理する
 * /log /verify /unverify /delete /ticket /give-role /remove-role /role-confirmation
 * @param {import('discord.js').ChatInputCommandInteraction} interaction
 * @param {import('firebase-admin').firestore.Firestore} db
 * @param {Map<string, string|null>} ticketMessages
 * @returns {Promise<boolean>}
 */
async function handleModerationCommand(interaction, db, ticketMessages) {
    const { commandName, options } = interaction;

    // ── /log ──────────────────────────────────────────────────
    if (commandName === 'log') {
        const channel = options.getChannel('channel');
        try {
            const logDoc = await db.collection('log_settings').doc(interaction.guild.id).get();

            if (channel) {
                await db.collection('log_settings').doc(interaction.guild.id).set({
                    channelId: channel.id,
                    guildName: interaction.guild.name
                });
                const isUpdate = logDoc.exists && logDoc.data().channelId !== channel.id;
                const replyMsg = isUpdate
                    ? `🔄 以前の設定を解除し、ログ送信先を ${channel} に更新しました。`
                    : `✅ ログ送信先を ${channel} に設定しました。`;
                await interaction.editReply(replyMsg);
                sendCommandLog(interaction, commandName, db);
            } else {
                if (!logDoc.exists) return void await interaction.editReply('❌ 現在、ログ設定は登録されていません。');
                await db.collection('log_settings').doc(interaction.guild.id).delete();
                await interaction.editReply('🗑️ ログの設定を解除しました。');
            }
        } catch {
            await interaction.editReply('エラーが発生しました。');
        }
        return true;
    }

    // ── /verify ───────────────────────────────────────────────
    // /ticket と同じ形式：パネル＋ボタンを設置し、ボタンを押したユーザーに指定ロールを付与する
    if (commandName === 'verify') {
        if (await checkBotPermissionsOrReply(interaction, [
            PermissionsBitField.Flags.ManageRoles,
            PermissionsBitField.Flags.SendMessages,
        ])) return true;

        const role  = options.getRole('role');
        const title = options.getString('title') ?? '認証パネル';
        const desc  = options.getString('description') ?? '以下のボタンを押して認証を完了してください。';

        const embed = new EmbedBuilder()
            .setTitle(title)
            .setDescription(desc)
            .setColor(0x3498DB);

        const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setCustomId(`v_role_${role.id}`)
                .setLabel('✅ 認証')
                .setStyle(ButtonStyle.Success)
        );

        // 公開メッセージとしてチャンネルに送信
        await interaction.channel.send({ embeds: [embed], components: [row] });
        // コマンド実行者への確認（ephemeral）
        await interaction.editReply({ content: '✅ 認証パネルを設置しました。' });
        sendCommandLog(interaction, commandName, db);
        return true;
    }

    // ── /unverify ─────────────────────────────────────────────
    // パネルはチャンネル全体に表示する（ephemeral不可）ため、
    // deferReply 済みの場合は followUp で公開送信し、自分への返信はその旨だけにする
    if (commandName === 'unverify') {
        if (await checkBotPermissionsOrReply(interaction, [
            PermissionsBitField.Flags.ManageRoles,
            PermissionsBitField.Flags.SendMessages,
        ])) return true;

        const role  = options.getRole('role');
        const title = options.getString('title') ?? 'ロール解除パネル';
        const desc  = options.getString('description') ?? '以下のボタンを押すとロールが解除されます。';

        const embed = new EmbedBuilder()
            .setTitle(title)
            .setDescription(desc)
            .setColor(0xE74C3C);

        const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setCustomId(`uv_role_${role.id}`)
                .setLabel('🚫 解除')
                .setStyle(ButtonStyle.Danger)
        );

        // 公開メッセージとしてチャンネルに送信
        await interaction.channel.send({ embeds: [embed], components: [row] });
        // コマンド実行者への確認（ephemeral）
        await interaction.editReply({ content: '✅ ロール解除パネルを設置しました。' });
        sendCommandLog(interaction, commandName, db);
        return true;
    }
  
    // ── /verifies ─────────────────────────────────────────────
    // 最大15個のリアクション式認証パネル。role-1〜role-15 の指定順に固定絵文字が同期し、
    // パネル設置後にリアクションを押したメンバーへ対応するロールを自動付与する。
    if (commandName === 'verifies') {
        if (await checkBotPermissionsOrReply(interaction, [
            PermissionsBitField.Flags.ManageRoles,
            PermissionsBitField.Flags.SendMessages,
            PermissionsBitField.Flags.AddReactions,
        ])) return true;

        const title = options.getString('title') ?? '認証パネル（複数ロール）';
        const desc  = options.getString('description') ?? '取得したいロールに対応するリアクションを押してください。';

        const pairs = [];
        for (let i = 1; i <= VERIFIES_EMOJIS.length; i++) {
            const role = options.getRole(`role-${i}`);
            if (role) pairs.push({ emoji: VERIFIES_EMOJIS[i - 1], roleId: role.id });
        }

        if (pairs.length === 0) {
            await interaction.editReply({ content: '❌ `role-1` 〜 `role-15` のいずれかに、少なくとも1つロールを指定してください。' });
            return true;
        }

        const roleList = pairs.map(p => `${p.emoji} → <@&${p.roleId}>`).join('\n');
        const embed = new EmbedBuilder()
            .setTitle(title)
            .setDescription(`${desc}\n\n${roleList}`)
            .setColor(0x3498DB);

        // 公開メッセージとしてチャンネルに送信
        const sentMessage = await interaction.channel.send({ embeds: [embed] });

        // 絵文字リアクションを順番に付与（レート制限回避のため少し間隔を空ける）
        const mapping = {};
        for (const pair of pairs) {
            try {
                await sentMessage.react(pair.emoji);
                mapping[pair.emoji] = pair.roleId;
                await new Promise(r => setTimeout(r, 300));
            } catch (e) {
                console.error('[verifies] リアクション付与失敗:', pair.emoji, e);
            }
        }

        if (Object.keys(mapping).length === 0) {
            await sentMessage.delete().catch(() => {});
            await interaction.editReply({ content: '❌ リアクションの付与にすべて失敗したため、パネルの設置を中止しました。' });
            return true;
        }

        await saveVerifyPanel(db, sentMessage.id, interaction.guild.id, interaction.channel.id, mapping);

        await interaction.editReply({ content: `✅ 複数ロール対応の認証パネル（リアクション形式・${Object.keys(mapping).length}ロール）を設置しました。` });
        sendCommandLog(interaction, commandName, db);
        return true;
    }

    // ── /delete ───────────────────────────────────────────────
    if (commandName === 'delete') {
        if (await checkBotPermissionsOrReply(interaction, [
            PermissionsBitField.Flags.ManageMessages,
        ])) return true;

        const amount = options.getInteger('amount');
        const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId(`bulk_yes_${amount}`).setLabel('削除').setStyle(ButtonStyle.Danger),
            new ButtonBuilder().setCustomId('bulk_no').setLabel('中止').setStyle(ButtonStyle.Secondary)
        );
        await interaction.editReply({ content: `${amount}件のメッセージを削除しますか？`, components: [row] });
        sendCommandLog(interaction, commandName, db);
        return true;
    }

    // ── /ticket ───────────────────────────────────────────────
    // /ticket panel          … チケットパネルを設置する（カテゴリー未登録時は従来通り1ボタン形式）
    // /ticket category-add   … チケット作成時に選ばせるカテゴリーを登録する
    // /ticket category-remove/list … カテゴリーの削除・一覧
    if (commandName === 'ticket') {
        const sub = options.getSubcommand();

        // ── /ticket category-add ────────────────────────────
        if (sub === 'category-add') {
            const name       = options.getString('name');
            const emoji      = options.getString('emoji');
            const adminRole  = options.getRole('admin-role');
            const parent     = options.getChannel('parent');
            const panelDesc  = options.getString('panel-desc');

            await addTicketCategory(db, interaction.guild.id, {
                name,
                emoji,
                adminRoleId: adminRole?.id ?? null,
                parentId: parent?.id ?? null,
                panelDesc: panelDesc ?? null,
            });

            await interaction.editReply({ content: `✅ チケットカテゴリー **${emoji} ${name}** を登録しました。` });
            sendCommandLog(interaction, commandName, db);
            return true;
        }

        // ── /ticket category-remove ─────────────────────────
        if (sub === 'category-remove') {
            const name = options.getString('name');
            const removed = await removeTicketCategory(db, interaction.guild.id, name);
            await interaction.editReply({
                content: removed
                    ? `🗑️ チケットカテゴリー **${name}** を削除しました。`
                    : `❌ カテゴリー **${name}** が見つかりませんでした。`
            });
            return true;
        }

        // ── /ticket category-list ───────────────────────────
        if (sub === 'category-list') {
            const categories = await listTicketCategories(db, interaction.guild.id);
            if (categories.length === 0) {
                await interaction.editReply({ content: '📋 登録されているチケットカテゴリーはありません。' });
                return true;
            }
            const lines = categories.map(c =>
                `・${c.emoji} **${c.name}**${c.adminRoleId ? ` (対応ロール: <@&${c.adminRoleId}>)` : ''}${c.parentId ? ` (作成先: <#${c.parentId}>)` : ''}`
            );
            const embed = new EmbedBuilder()
                .setTitle('📋 チケットカテゴリー一覧')
                .setDescription(lines.join('\n'))
                .setColor(0x9B59B6);
            await interaction.editReply({ embeds: [embed] });
            return true;
        }

        // ── /ticket panel ────────────────────────────────────
        if (sub === 'panel') {
            if (await checkBotPermissionsOrReply(interaction, [
                PermissionsBitField.Flags.ManageChannels,
                PermissionsBitField.Flags.SendMessages,
            ])) return true;

            const adminRole = options.getRole('admin-role');
            const key = `t_${Date.now()}`;
            await saveTicketPanel(db, key, {
                guildId: interaction.guild.id,
                adminRoleId: adminRole.id,
                panelDesc: options.getString('panel-desc') ?? null,
            });
            ticketMessages.set(key, options.getString('panel-desc') ?? null); // フォールバック（メモリキャッシュ）

            const embed = new EmbedBuilder()
                .setTitle(options.getString('title') ?? 'サポートチケット')
                .setDescription(options.getString('description') ?? 'チケットを作成するには下のボタンを押してください。')
                .setColor(0x9B59B6);

            const categories = await listTicketCategories(db, interaction.guild.id);

            let components;
            if (categories.length > 0) {
                // カテゴリーが登録されている場合はセレクトメニューで選ばせる
                const select = new StringSelectMenuBuilder()
                    .setCustomId(`tkt_cat_${adminRole.id}_${key}`)
                    .setPlaceholder('チケットのカテゴリーを選択してください')
                    .addOptions(categories.slice(0, 25).map(c => ({
                        label: c.name,
                        value: c.name,
                        emoji: c.emoji,
                    })));
                components = [new ActionRowBuilder().addComponents(select)];
            } else {
                components = [new ActionRowBuilder().addComponents(
                    new ButtonBuilder()
                        .setCustomId(`tkt_${adminRole.id}_${key}`)
                        .setLabel('🎫 チケットを作成')
                        .setStyle(ButtonStyle.Primary)
                )];
            }

            // 公開メッセージとしてチャンネルに送信
            await interaction.channel.send({ embeds: [embed], components });
            // コマンド実行者への確認（ephemeral）
            await interaction.editReply({ content: '✅ チケットパネルを設置しました。' });
            sendCommandLog(interaction, commandName, db);
            return true;
        }

        return false;
    }

    // ── /give-role / /remove-role ─────────────────────────────
    if (['give-role', 'remove-role'].includes(commandName)) {
        if (await checkBotPermissionsOrReply(interaction, [
            PermissionsBitField.Flags.ManageRoles,
        ])) return true;

        const member = options.getMember('target');
        const role   = options.getRole('role');
        try {
            if (commandName === 'give-role') {
                await member.roles.add(role);
                await interaction.editReply({ content: `✅ ${member} にロール **${role.name}** を付与しました。` });
            } else {
                await member.roles.remove(role);
                await interaction.editReply({ content: `✅ ${member} からロール **${role.name}** を剥奪しました。` });
            }
            sendCommandLog(interaction, commandName, db);
        } catch {
            await interaction.editReply({ content: '❌ 権限不足などの理由により操作に失敗しました。' });
        }
        return true;
    }

    // ── /role-confirmation ────────────────────────────────────
    if (commandName === 'role-confirmation') {
        const member = options.getMember('target');
        if (!member) return void await interaction.editReply({ content: '❌ ユーザーが見つかりませんでした。' });

        const roles = member.roles.cache
            .filter(r => r.name !== '@everyone')
            .map(r => r.toString())
            .join(', ') || 'なし';

        const embed = new EmbedBuilder()
            .setTitle(`👤 ${member.user.username} のロール確認`)
            .setDescription(`所持しているロール一覧:\n${roles}`)
            .setColor(0x00AE86);

        await interaction.editReply({ embeds: [embed] });
        sendCommandLog(interaction, commandName, db);
        return true;
    }

    return false;
}

module.exports = { handleModerationCommand };
