'use strict';

const { createCanvas } = require('canvas');
const fs = require('fs');
const path = require('path');

// 1. 事前に用意したGeoJSON（都道府県境データ）を読み込む
const geojsonPath = path.join(__dirname, 'japan.json');
let geojsonData = null;
if (fs.existsSync(geojsonPath)) {
    geojsonData = JSON.parse(fs.readFileSync(geojsonPath, 'utf8'));
} else {
    console.error('⚠️ [map.js] japan.json が見つかりません。地図の陸地が描画されません。');
}

/**
 * ISO6709形式の座標文字列をパースする
 * @returns {{ lat: number, lon: number, depthKm: number } | null}
 */
function parseISO6709(coordinate) {
    if (!coordinate) return null;
    const parts = coordinate.replace('/', '').split(/(?=[+-])/).filter(s => s !== '');
    if (parts.length < 2) return null;
    const lat = parseFloat(parts[0]);
    const lon = parseFloat(parts[1]);
    let depthKm = 0;
    if (parts.length >= 3) {
        const depthRaw = parseFloat(parts[2]);
        depthKm = Math.abs(depthRaw / 1000);
    }
    if (isNaN(lat) || isNaN(lon)) return null;
    return { lat, lon, depthKm };
}

// ─── 震度スケールを数値化（比較用） ─────────────────────────────
const INT_ORDER = ['1', '2', '3', '4', '5-', '5+', '6-', '6+', '7'];
function intRank(intStr) {
    const i = INT_ORDER.indexOf(intStr);
    return i === -1 ? -1 : i;
}

/**
 * 都道府県ごとに観測点を絞り込む（ユーザーオリジナルロジックを保持）
 */
function filterStationsByPrefecture(stations) {
    if (!Array.isArray(stations) || stations.length === 0) return [];

    const groups = new Map();
    for (const st of stations) {
        if (st.lat == null || st.lon == null) continue;
        const key = st.pref ?? `__nopref_${st.lat.toFixed(2)}_${st.lon.toFixed(2)}`;
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(st);
    }

    let maxRank = -1;
    for (const st of stations) {
        const r = intRank(st.int);
        if (r > maxRank) maxRank = r;
    }
    const isLarge = maxRank >= intRank('5-'); 

    const result = [];
    for (const list of groups.values()) {
        const sorted = [...list].sort((a, b) => intRank(b.int) - intRank(a.int));
        const topRank = intRank(sorted[0].int);
        const topStations = sorted.filter(s => intRank(s.int) === topRank);

        if (!isLarge || topStations.length === 1) {
            result.push(sorted[0]);
            continue;
        }

        let bestPair = [topStations[0], topStations[0]];
        let bestDist = -1;
        for (let i = 0; i < topStations.length; i++) {
            for (let j = i + 1; j < topStations.length; j++) {
                const dLat = topStations[i].lat - topStations[j].lat;
                const dLon = topStations[i].lon - topStations[j].lon;
                const dist = dLat * dLat + dLon * dLon;
                if (dist > bestDist) {
                    bestDist = dist;
                    bestPair = [topStations[i], topStations[j]];
                }
            }
        }
        if (bestDist <= 0) {
            result.push(topStations[0]);
        } else {
            result.push(bestPair[0], bestPair[1]);
        }
    }

    return result;
}

/**
 * 緯度経度をCanvasのXY座標に変換する
 */
function latLonToXY(lat, lon, mapRange, width, height) {
    const x = ((lon - mapRange.minLon) / (mapRange.maxLon - mapRange.minLon)) * width;
    const y = height - ((lat - mapRange.minLat) / (mapRange.maxLat - mapRange.minLat)) * height;
    return { x, y };
}

/**
 * 角丸の四角形を描画するヘルパー
 */
function drawRoundRect(ctx, x, y, width, height, radius) {
    ctx.beginPath();
    ctx.moveTo(x + radius, y);
    ctx.lineTo(x + width - radius, y);
    ctx.quadraticCurveTo(x + width, y, x + width, y + radius);
    ctx.lineTo(x + width, y + height - radius);
    ctx.quadraticCurveTo(x + width, y + height, x + width - radius, y + height);
    ctx.lineTo(x + radius, y + height);
    ctx.quadraticCurveTo(x, y + height, x, y + height - radius);
    ctx.lineTo(x, y + radius);
    ctx.quadraticCurveTo(x, y, x + radius, y);
    ctx.closePath();
}

/**
 * 震度スタンプをCanvasに描画する（SVGからCanvas描画に最適化）
 */
function drawScaleMarker(ctx, x, y, intStr) {
    const scaleMap = {
        '1':  { text: '1',  bg: '#f2f2ff', c: '#000000' },
        '2':  { text: '2',  bg: '#00aaff', c: '#000000' },
        '3':  { text: '3',  bg: '#0041ff', c: '#ffffff' },
        '4':  { text: '4',  bg: '#fae696', c: '#000000' },
        '5-': { text: '5-', bg: '#ffe600', c: '#000000' },
        '5+': { text: '5+', bg: '#ff9900', c: '#000000' },
        '6-': { text: '6-', bg: '#ff2800', c: '#ffffff' },
        '6+': { text: '6+', bg: '#a50021', c: '#ffffff' },
        '7':  { text: '7',  bg: '#b40068', c: '#ffffff' },
    };
    const s = scaleMap[intStr];
    if (!s) return;

    const size = 24;
    const radius = 4;
    const rx = x - size / 2;
    const ry = y - size / 2;

    // 背景と枠線
    ctx.fillStyle = s.bg;
    ctx.strokeStyle = '#555555';
    ctx.lineWidth = 1;
    drawRoundRect(ctx, rx, ry, size, size, radius);
    ctx.fill();
    ctx.stroke();

    // テキスト
    const fontSize = intStr.length > 1 ? 11 : 13;
    ctx.fillStyle = s.c;
    ctx.font = `bold ${fontSize}px sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    // Canvasの仕様上、少しYをズラすとど真ん中に来ます
    ctx.fillText(s.text, x, y + 1.5); 
}

/**
 * 震源地と各観測点を重ねた地図画像バッファを生成する
 * @param {number} centerLat
 * @param {number} centerLon
 * @param {{ lat: number, lon: number, int: string, pref?: string }[]} stations
 * @returns {Promise<Buffer|null>}
 */
async function buildJMAMapAttachment(centerLat, centerLon, stations = []) {
    if (centerLat == null || centerLon == null) return null;

    // オリジナルの賢いフィルター関数を通す
    const filteredStations = filterStationsByPrefecture(stations);

    const width = 600;
    const height = 600;
    const canvas = createCanvas(width, height);
    const ctx = canvas.getContext('2d');

    // ── 1. 描画範囲の動的決定（自動ズーム） ──
    let minLat = centerLat;
    let maxLat = centerLat;
    let minLon = centerLon;
    let maxLon = centerLon;

    for (const st of filteredStations) {
        if (st.lat < minLat) minLat = st.lat;
        if (st.lat > maxLat) maxLat = st.lat;
        if (st.lon < minLon) minLon = st.lon;
        if (st.lon > maxLon) maxLon = st.lon;
    }

    // 画面端の余白
    const margin = 0.8;
    minLat -= margin;
    maxLat += margin;
    minLon -= margin;
    maxLon += margin;

    // ズームしすぎ防止 (最低でも約4度分は表示する)
    const minRange = 4.0;
    let latDiff = maxLat - minLat;
    let lonDiff = maxLon - minLon;

    if (latDiff < minRange) {
        const latCenter = (maxLat + minLat) / 2;
        minLat = latCenter - minRange / 2;
        maxLat = latCenter + minRange / 2;
        latDiff = minRange;
    }
    if (lonDiff < minRange) {
        const lonCenter = (maxLon + minLon) / 2;
        minLon = lonCenter - minRange / 2;
        maxLon = lonCenter + minRange / 2;
        lonDiff = minRange;
    }

    // ── 2. 歪み補正（日本が横に伸びないようにする） ──
    const cosLat = Math.cos(((minLat + maxLat) / 2) * Math.PI / 180);
    const relativeLonDiff = lonDiff * cosLat;
    const maxRelDiff = Math.max(latDiff, relativeLonDiff);
    
    const finalLatCenter = (maxLat + minLat) / 2;
    const finalLonCenter = (maxLon + minLon) / 2;

    const mapRange = {
        minLat: finalLatCenter - maxRelDiff / 2,
        maxLat: finalLatCenter + maxRelDiff / 2,
        minLon: finalLonCenter - (maxRelDiff / cosLat) / 2,
        maxLon: finalLonCenter + (maxRelDiff / cosLat) / 2,
    };

    // ── 3. 海を塗る ──
    ctx.fillStyle = '#b3d1ff'; 
    ctx.fillRect(0, 0, width, height);

    // ── 4. 陸地（都道府県）を描画する ──
    if (geojsonData) {
        ctx.strokeStyle = '#777777';
        ctx.lineWidth = 1;

        for (const feature of geojsonData.features) {
            const geometry = feature.geometry;
            if (!geometry) continue;

            const listCoordinates = geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.coordinates;

            for (const polygons of listCoordinates) {
                for (const rings of polygons) {
                    ctx.beginPath();
                    let isFirst = true;

                    for (const coord of rings) {
                        const { x, y } = latLonToXY(coord[1], coord[0], mapRange, width, height);
                        if (isFirst) {
                            ctx.moveTo(x, y);
                            isFirst = false;
                        } else {
                            ctx.lineTo(x, y);
                        }
                    }
                    
                    ctx.fillStyle = '#ffffff';
                    ctx.fill();
                    ctx.stroke();
                }
            }
        }
    }

    // ── 5. 観測点（オリジナルの四角い震度スタンプ）を描画 ──
    for (const st of filteredStations) {
        const { x, y } = latLonToXY(st.lat, st.lon, mapRange, width, height);
        // 描画範囲外はスキップ
        if (x < 0 || x > width || y < 0 || y > height) continue;
        drawScaleMarker(ctx, x, y, st.int);
    }

    // ── 6. 震源地（オリジナルの白フチ赤×マーカー）を描画 ──
    const centerPos = latLonToXY(centerLat, centerLon, mapRange, width, height);
    const ARM = 16;
    const SW = 5;

    ctx.lineCap = 'round';
    // 白いフチ
    ctx.strokeStyle = 'white';
    ctx.lineWidth = SW + 4;
    ctx.beginPath();
    ctx.moveTo(centerPos.x - ARM, centerPos.y - ARM); ctx.lineTo(centerPos.x + ARM, centerPos.y + ARM);
    ctx.moveTo(centerPos.x + ARM, centerPos.y - ARM); ctx.lineTo(centerPos.x - ARM, centerPos.y + ARM);
    ctx.stroke();

    // 赤いバツ
    ctx.strokeStyle = '#EE0000';
    ctx.lineWidth = SW;
    ctx.beginPath();
    ctx.moveTo(centerPos.x - ARM, centerPos.y - ARM); ctx.lineTo(centerPos.x + ARM, centerPos.y + ARM);
    ctx.moveTo(centerPos.x + ARM, centerPos.y - ARM); ctx.lineTo(centerPos.x - ARM, centerPos.y + ARM);
    ctx.stroke();

    return canvas.toBuffer('image/png');
}

module.exports = {
    parseISO6709,
    buildJMAMapAttachment,
};
