'use strict';

/**
 * /change-name パネルの設定（モーダルのタイトルなど）をFirestoreに保存するユーティリティ
 */

const COLLECTION = 'change_name_panels';

/**
 * パネル設定を保存する
 * @param {import('firebase-admin').firestore.Firestore} db
 * @param {string} key
 * @param {{guildId: string, modalTitle: string, inputLabel: string}} data
 */
async function saveChangeNamePanel(db, key, data) {
    await db.collection(COLLECTION).doc(key).set({
        ...data,
        createdAt: Date.now(),
    });
}

/**
 * パネル設定を取得する
 * @param {import('firebase-admin').firestore.Firestore} db
 * @param {string} key
 */
async function getChangeNamePanel(db, key) {
    const doc = await db.collection(COLLECTION).doc(key).get();
    return doc.exists ? doc.data() : null;
}

module.exports = { saveChangeNamePanel, getChangeNamePanel };
