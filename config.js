'use strict';

// ─── コマンド分類 ──────────────────────────────────────────────

/** 誰でも使えるコマンド（権限チェック不要） */
const PUBLIC_COMMANDS = ['receive-notifications', 'request', 'help'];

/** モーダルを表示するコマンド（deferReply不可） */
const MODAL_COMMANDS = ['notice', 'broadcast', 'request'];

/** オーナー専用コマンド（grant-access / revoke-access / list-access） */
const OWNER_COMMANDS = ['grant-access', 'revoke-access', 'list-access'];

// ─── Bot アクティビティリスト ──────────────────────────────────

const ACTIVITIES = [
    "JYRAC公式Instは'2024nsfproject'で検索！",
    "JYRAC公式Instは'Jyrac_official'で検索！",
    "お問い合わせはDiscordID: pitayakun7 まで",
    "広告募集中",
];

module.exports = {
    PUBLIC_COMMANDS,
    MODAL_COMMANDS,
    OWNER_COMMANDS,
    ACTIVITIES,
};
