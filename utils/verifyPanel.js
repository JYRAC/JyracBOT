'use strict';

/**
 * /verify コマンドの複数ロール（リアクション形式）認証パネルを扱うユーティリティ
 *
 * 入力フォーマット（roles オプション）:
 *   "😀:@Role1, 😆:<@&123456789012345678>, <:custom:987654321098765432>:@Role3"
 *   絵文字（Unicode / カスタム絵文字）と ロール（メンション or ID）を「:」区切りでペアにし、
 *   ペア同士は「,」または改行・空白で区切る。ロール数は無制限。
 */

const PAIR_REGEX =
    /(<a?:\w+:\d{17,20}>|\p{Extended_Pictographic}(?:\u200d\p{Extended_Pictographic})*)\s*[:：\-]?\s*(?:<@&(\d{17,20})>|(\d{17,20}))/gu;

/**
 * roles オプションの文字列から「絵文字 - ロールID」のペア一覧を抽出する
 * @param {string} input
 * @returns {{emoji: string, roleId: string, key: string}[]}
 */
function parseRoleEmojiPairs(input) {
    if (!input) return [];

    const pairs = [];
    const seenRoleIds = new Set();
    const seenKeys = new Set();

    for (const match of input.matchAll(PAIR_REGEX)) {
        const emojiToken = match[1];
        const roleId = match[2] ?? match[3];
        if (!roleId) continue;

        const customIdMatch = emojiToken.match(/:(\d{17,20})>$/);
        const key = customIdMatch ? customIdMatch[1] : emojiToken;

        // 同一ロール・同一絵文字の重複指定は無視する
        if (seenRoleIds.has(roleId) || seenKeys.has(key)) continue;

        seenRoleIds.add(roleId);
        seenKeys.add(key);
        pairs.push({ emoji: emojiToken, roleId, key });
    }

    return pairs;
}

/**
 * 認証パネル（リアクション形式）の絵文字→ロールIDのマッピングをFirestoreに保存する
 * @param {import('firebase-admin').firestore.Firestore} db
 * @param {string} messageId
 * @param {string} guildId
 * @param {string} channelId
 * @param {Record<string, string>} mapping key(絵文字 or カスタム絵文字ID) -> roleId
 */
async function saveVerifyPanel(db, messageId, guildId, channelId, mapping) {
    await db.collection('verify_panels').doc(messageId).set({
        guildId,
        channelId,
        roles: mapping,
        createdAt: Date.now(),
    });
}

/**
 * リアクションが押されたメッセージ・絵文字キーから付与対象のロールIDを取得する
 * @param {import('firebase-admin').firestore.Firestore} db
 * @param {string} messageId
 * @param {string} key
 * @returns {Promise<string|null>}
 */
async function getVerifyPanelRoleId(db, messageId, key) {
    try {
        const doc = await db.collection('verify_panels').doc(messageId).get();
        if (!doc.exists) return null;
        const roles = doc.data().roles ?? {};
        return roles[key] ?? null;
    } catch (e) {
        console.error('[verify_panels] 取得エラー:', e);
        return null;
    }
}

module.exports = { parseRoleEmojiPairs, saveVerifyPanel, getVerifyPanelRoleId };
