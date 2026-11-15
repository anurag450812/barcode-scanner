let video;
let canvas;
let context;
let scanning = false;
let scanMode = null;
let barcodeDetector;
let nativeFormats = null;
let decoderKind = null;
let decoderPromise = null;
let zxingScriptPromise = null;
let thoroughTick = 0;
let stream;

let videoTrack = null;
let zoomLevel = 1;
let zoomMin = 1;
let zoomMax = 6;
let zoomStep = 0;
let hardwareZoom = false;
let zoomApplyChain = Promise.resolve();

let awbData = [];
let awbMap = {};

let detectorReinitTimer = null;
let codeState = new Map();
let frameMap = null;
let cameraLoopRunning = false;
let screenLoopToken = 0;
let screenMissStreak = 0;
let nativeFailureCount = 0;

let screenRegion = null;
let awaitingRegion = false;
let regionDrag = null;
let regionRestored = false;

let audioContext = null;

const DUPLICATE_WINDOW_MS = 2000;
const CODE_VISIBLE_MS = 1600;
const HIGHLIGHT_VISIBLE_MS = 700;
const SCREEN_SCAN_INTERVAL_MS = 120;
const REGION_STORAGE_KEY = 'barcodeScreenRegion';
const ZXING_READER_SRC = 'https://cdn.jsdelivr.net/npm/zxing-wasm@3.1.7/dist/iife/reader/index.js';

const NATIVE_FORMATS = [
    'aztec', 'code_128', 'code_39', 'code_93', 'codabar',
    'data_matrix', 'ean_13', 'ean_8', 'itf', 'pdf417',
    'qr_code', 'upc_a', 'upc_e'
];

// Courier AWBs are usually Code 128. QR is included because labels often carry one.
// Names are the zxing-wasm canonical format names.
const ZXING_READER_OPTIONS = {
    tryHarder: true,
    tryRotate: true,
    tryInvert: true,
    // The crop is scaled before it gets here. Extra downscaling smears thin bars.
    tryDownscale: false,
    maxNumberOfSymbols: 32,
    textMode: 'Plain',
    formats: [
        'Code128', 'Code39', 'Code93', 'Codabar', 'ITF',
        'QRCode', 'EAN13', 'EAN8', 'UPCA', 'UPCE',
        'PDF417', 'DataMatrix', 'Aztec'
    ]
};

function resumeAudio() {
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtx) return;
    if (!audioContext) audioContext = new AudioCtx();
    // Always resume from the click. A suspended context stays silent, and
    // resume() is a no-op when the context is already running.
    audioContext.resume();
}

function playBeep(offsetSec) {
    if (!audioContext) return;
    try {
        if (audioContext.state === 'suspended') audioContext.resume();
        const oscillator = audioContext.createOscillator();
        const gainNode = audioContext.createGain();
        oscillator.connect(gainNode);
        gainNode.connect(audioContext.destination);
        oscillator.frequency.value = 800;
        oscillator.type = 'sine';
        const t = audioContext.currentTime + (offsetSec || 0);
        gainNode.gain.setValueAtTime(0.3, t);
        gainNode.gain.exponentialRampToValueAtTime(0.01, t + 0.2);
        oscillator.start(t);
        oscillator.stop(t + 0.2);
    } catch (err) {
        console.error('Beep failed:', err);
    }
}

function playSiren(offsetSec) {
    if (!audioContext) return;
    try {
        if (audioContext.state === 'suspended') audioContext.resume();
        const now = audioContext.currentTime + (offsetSec || 0);
        for (let i = 0; i < 3; i++) {
            const osc = audioContext.createOscillator();
            const gain = audioContext.createGain();
            osc.connect(gain);
            gain.connect(audioContext.destination);
            osc.type = 'sine';
            osc.frequency.setValueAtTime(600, now + i * 0.3);
            osc.frequency.linearRampToValueAtTime(1200, now + i * 0.3 + 0.15);
            osc.frequency.linearRampToValueAtTime(600, now + i * 0.3 + 0.3);
            gain.gain.setValueAtTime(0.4, now + i * 0.3);
            gain.gain.exponentialRampToValueAtTime(0.01, now + i * 0.3 + 0.3);
            osc.start(now + i * 0.3);
            osc.stop(now + i * 0.3 + 0.3);
        }
    } catch (err) {
        console.error('Siren failed:', err);
    }
}

function vibrate() {
    if ('vibrate' in navigator) navigator.vibrate(200);
}

function vibrateLong() {
    if ('vibrate' in navigator) navigator.vibrate([200, 100, 200, 100, 200]);
}

async function copyToClipboard(text) {
    try {
        await navigator.clipboard.writeText(text);
        return true;
    } catch (err) {
        console.error('Failed to copy:', err);
        return false;
    }
}

function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// IndexedDB helpers
function openDB() {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open('BarcodeScannerDB', 1);
        request.onupgradeneeded = (e) => {
            const db = e.target.result;
            if (!db.objectStoreNames.contains('awbData')) {
                db.createObjectStore('awbData', { keyPath: 'key' });
            }
        };
        request.onsuccess = (e) => resolve(e.target.result);
        request.onerror = (e) => reject(e.target.error);
    });
}

async function saveAWBToDB(data) {
    const db = await openDB();
    const tx = db.transaction('awbData', 'readwrite');
    tx.objectStore('awbData').put({ key: 'awbList', value: data });
    return new Promise((resolve, reject) => {
        tx.oncomplete = resolve;
        tx.onerror = reject;
    });
}

async function loadAWBFromDB() {
    const db = await openDB();
    const tx = db.transaction('awbData', 'readonly');
    const request = tx.objectStore('awbData').get('awbList');
    return new Promise((resolve, reject) => {
        request.onsuccess = () => resolve(request.result ? request.result.value : null);
        request.onerror = reject;
    });
}

async function clearAWBFromDB() {
    const db = await openDB();
    const tx = db.transaction('awbData', 'readwrite');
    tx.objectStore('awbData').delete('awbList');
    return new Promise((resolve, reject) => {
        tx.oncomplete = resolve;
        tx.onerror = reject;
    });
}

function buildAWBMap(data) {
    awbData = data;
    awbMap = {};
    data.forEach(row => {
        const awb = String(row.awbNumber || row.AWB || '').trim();
        if (awb) awbMap[awb] = row;
    });
}

function updateAWBStatus() {
    const statusEl = document.getElementById('awbStatus');
    const uploadEl = document.getElementById('uploadArea');
    const countEl = document.getElementById('awbCount');

    if (awbData.length > 0) {
        countEl.textContent = awbData.length;
        statusEl.style.display = 'flex';
        uploadEl.style.display = 'none';
    } else {
        statusEl.style.display = 'none';
        uploadEl.style.display = 'flex';
    }
}

function parseExcel(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = (e) => {
            try {
                const data = new Uint8Array(e.target.result);
                const workbook = XLSX.read(data, { type: 'array' });
                const sheetName = workbook.SheetNames[0];
                const sheet = workbook.Sheets[sheetName];
                const json = XLSX.utils.sheet_to_json(sheet);

                if (json.length === 0) {
                    reject(new Error('Excel file is empty'));
                    return;
                }

                const headers = Object.keys(json[0]);
                const awbHeader = headers.find(h =>
                    h.toLowerCase().includes('awb') || h.toLowerCase().includes('awb number')
                ) || headers[0];

                const result = json.map(row => ({
                    ...row,
                    awbNumber: String(row[awbHeader] || '').trim()
                }));

                resolve(result);
            } catch (err) {
                reject(err);
            }
        };
        reader.onerror = reject;
        reader.readAsArrayBuffer(file);
    });
}

// Desktop Chrome and Edge on Windows/Linux expose BarcodeDetector, but
// getSupportedFormats() comes back empty because there is no platform decoder.
// Android Chrome (and macOS / ChromeOS) report real formats and keep using it.
async function tryNativeDetector() {
    if (typeof window.BarcodeDetector !== 'function') return false;
    try {
        let formats = NATIVE_FORMATS.slice();
        if (typeof BarcodeDetector.getSupportedFormats === 'function') {
            const supported = await BarcodeDetector.getSupportedFormats();
            if (!supported || supported.indexOf('code_128') === -1 || supported.indexOf('qr_code') === -1) {
                return false;
            }
            formats = NATIVE_FORMATS.filter(format => supported.indexOf(format) !== -1);
        }
        barcodeDetector = new BarcodeDetector({ formats });
        nativeFormats = formats;
        return true;
    } catch (err) {
        console.warn('Native BarcodeDetector unavailable:', err);
        return false;
    }
}

function loadZXingScript() {
    if (window.ZXingWASM && typeof window.ZXingWASM.readBarcodes === 'function') {
        return Promise.resolve();
    }
    if (!zxingScriptPromise) {
        zxingScriptPromise = new Promise((resolve, reject) => {
            const script = document.createElement('script');
            script.src = ZXING_READER_SRC;
            script.async = true;
            script.onload = () => {
                if (window.ZXingWASM && typeof window.ZXingWASM.readBarcodes === 'function') resolve();
                else reject(new Error('Barcode decoder loaded but did not start'));
            };
            script.onerror = () => reject(new Error('Could not load the barcode decoder from the CDN'));
            document.head.appendChild(script);
        }).catch(err => {
            zxingScriptPromise = null;
            throw err;
        });
    }
    return zxingScriptPromise;
}

async function loadZXingDecoder() {
    await loadZXingScript();
    // First call fetches and compiles the wasm module.
    await window.ZXingWASM.readBarcodes(new ImageData(8, 8), {
        formats: ['QRCode'],
        tryHarder: false,
        tryRotate: false,
        tryInvert: false,
        tryDownscale: false,
        maxNumberOfSymbols: 1
    });
}

function ensureDecoder() {
    if (decoderKind) return Promise.resolve(true);
    if (!decoderPromise) {
        decoderPromise = (async () => {
            if (await tryNativeDetector()) {
                decoderKind = 'native';
                console.info('Barcode decoder: native BarcodeDetector');
                return true;
            }
            await loadZXingDecoder();
            decoderKind = 'zxing';
            console.info('Barcode decoder: zxing-wasm fallback');
            return true;
        })().catch(err => {
            decoderPromise = null;
            decoderKind = null;
            console.error(err);
            return false;
        });
    }
    return decoderPromise;
}

function reinitDetector() {
    if (decoderKind !== 'native' || !nativeFormats) return;
    try {
        barcodeDetector = new BarcodeDetector({ formats: nativeFormats });
    } catch (e) { /* ignore */ }
}

function zxingOptionsForFrame() {
    thoroughTick += 1;
    // Sideways and inverted codes are checked every few frames. The frames in
    // between stay fast, which matters for a live screen share.
    if (thoroughTick % 4 === 1) return ZXING_READER_OPTIONS;
    return {
        ...ZXING_READER_OPTIONS,
        tryRotate: false
    };
}

async function detectFromCanvas() {
    if (!decoderKind) return [];
    if (decoderKind === 'native') {
        try {
            const barcodes = await barcodeDetector.detect(canvas);
            nativeFailureCount = 0;
            return barcodes.map(barcode => ({
                value: barcode.rawValue || '',
                format: barcode.format || '',
                rect: rectFromNativeBarcode(barcode)
            }));
        } catch (err) {
            nativeFailureCount += 1;
            if (nativeFailureCount >= 3) {
                console.warn('Native detector failed, switching to ZXing');
                await loadZXingDecoder();
                decoderKind = 'zxing';
                nativeFailureCount = 0;
                return detectFromCanvas();
            }
            throw err;
        }
    }

    if (!canvas.width || !canvas.height) return [];
    const imageData = context.getImageData(0, 0, canvas.width, canvas.height);
    const results = await window.ZXingWASM.readBarcodes(imageData, zxingOptionsForFrame());
    return (results || [])
        .filter(result => result && result.text && !result.error)
        .map(result => ({
            value: result.text,
            format: result.format || result.symbology || 'barcode',
            rect: rectFromZxingPosition(result.position)
        }));
}

function rectFromNativeBarcode(barcode) {
    if (barcode.boundingBox) {
        const box = barcode.boundingBox;
        return normRectFromImageBox(box.x, box.y, box.width, box.height);
    }
    if (barcode.cornerPoints) return rectFromImagePoints(barcode.cornerPoints);
    return null;
}

function rectFromZxingPosition(position) {
    if (!position) return null;
    return rectFromImagePoints([
        position.topLeft,
        position.topRight,
        position.bottomRight,
        position.bottomLeft
    ]);
}

function rectFromImagePoints(points) {
    const pts = (points || []).filter(point => point && typeof point.x === 'number' && typeof point.y === 'number');
    if (pts.length < 2) return null;
    let minX = pts[0].x;
    let minY = pts[0].y;
    let maxX = pts[0].x;
    let maxY = pts[0].y;
    pts.forEach(point => {
        if (point.x < minX) minX = point.x;
        if (point.y < minY) minY = point.y;
        if (point.x > maxX) maxX = point.x;
        if (point.y > maxY) maxY = point.y;
    });
    return normRectFromImageBox(minX, minY, maxX - minX, maxY - minY);
}

// Detection coordinates are in the scaled crop. Map them onto the preview,
// which is the full shared frame in screen mode and the scanned crop on camera.
function normRectFromImageBox(x, y, w, h) {
    const map = frameMap;
    if (!map || !map.dw || !map.dh || !map.sw || !map.sh || !map.vw || !map.vh) return null;
    const vx1 = map.sx + (x / map.dw) * map.sw;
    const vy1 = map.sy + (y / map.dh) * map.sh;
    const vx2 = map.sx + ((x + w) / map.dw) * map.sw;
    const vy2 = map.sy + ((y + h) / map.dh) * map.sh;
    const nx1 = vx1 / map.vw;
    const ny1 = vy1 / map.vh;
    const nx2 = vx2 / map.vw;
    const ny2 = vy2 / map.vh;
    const nx = Math.min(nx1, nx2);
    const ny = Math.min(ny1, ny2);
    return { x: nx, y: ny, w: Math.abs(nx2 - nx1), h: Math.abs(ny2 - ny1) };
}

function resetScanSession() {
    codeState = new Map();
    const list = document.getElementById('codeList');
    if (list) list.replaceChildren();
    const matches = document.getElementById('matchList');
    if (matches) matches.replaceChildren();
    clearHighlights();
}

function handleCodes(codes) {
    const now = Date.now();
    const fresh = [];
    const seenThisFrame = new Set();
    (codes || []).forEach(code => {
        const value = String(code.value || '').trim();
        if (!value || seenThisFrame.has(value)) return;
        seenThisFrame.add(value);
        let state = codeState.get(value);
        const isNew = !state || now - state.lastAnnounced > DUPLICATE_WINDOW_MS;
        if (!state) {
            state = { value: value, format: code.format || '', lastSeen: now, lastAnnounced: 0, rect: null };
            codeState.set(value, state);
        }
        state.format = code.format || state.format;
        state.lastSeen = now;
        if (code.rect) state.rect = code.rect;
        if (isNew) {
            state.lastAnnounced = now;
            fresh.push(state);
        }
    });
    codeState.forEach((state, key) => {
        if (now - state.lastSeen > 10000) codeState.delete(key);
    });
    renderCodeList(now);
    renderHighlights(now);
    if (!fresh.length) return;

    copyToClipboard(fresh.map(state => state.value).join('\n'));
    let beepIndex = 0;
    let sirenIndex = 0;
    let anyMatch = false;
    fresh.forEach(state => {
        const row = awbMap[state.value];
        if (row) {
            anyMatch = true;
            addMatchCard(row);
            playSiren(sirenIndex * 0.4);
            sirenIndex += 1;
        } else {
            playBeep(beepIndex * 0.14);
            beepIndex += 1;
        }
    });
    if (anyMatch) vibrateLong();
    else vibrate();
}

function renderCodeList(now) {
    const list = document.getElementById('codeList');
    const status = document.getElementById('resultText');
    if (!list || !status) return;
    const visible = [];
    codeState.forEach(state => {
        if (now - state.lastSeen <= CODE_VISIBLE_MS) visible.push(state);
    });
    visible.sort((a, b) => (a.value < b.value ? -1 : a.value > b.value ? 1 : 0));
    if (!visible.length) {
        list.replaceChildren();
        if (status.textContent.indexOf('code') !== -1 && status.textContent.indexOf('in view') !== -1) {
            status.textContent = scanMode ? 'Scanning...' : status.textContent;
        }
        return;
    }
    status.textContent = visible.length === 1 ? '1 code in view' : visible.length + ' codes in view';
    list.replaceChildren();
    visible.forEach(state => {
        const item = document.createElement('li');
        const matched = !!awbMap[state.value];
        item.className = matched ? 'code-item code-match' : 'code-item';
        const value = document.createElement('span');
        value.className = 'code-value';
        value.textContent = state.value;
        const format = document.createElement('span');
        format.className = 'code-format';
        format.textContent = state.format || '';
        item.append(value, format);
        if (matched) {
            const tag = document.createElement('span');
            tag.className = 'code-tag';
            tag.textContent = 'AWB';
            item.appendChild(tag);
        }
        list.appendChild(item);
    });
}

function renderHighlights(now) {
    const layer = document.getElementById('codeHighlights');
    if (!layer) return;
    layer.replaceChildren();
    if (scanMode !== 'screen' && scanMode !== 'camera') return;
    const content = highlightFrame();
    const overlay = layer.getBoundingClientRect();
    if (!content.width || !content.height) return;
    const z = content.zoom || 1;
    codeState.forEach(state => {
        if (!state.rect || now - state.lastSeen > HIGHLIGHT_VISIBLE_MS) return;
        const mark = document.createElement('div');
        mark.className = awbMap[state.value] ? 'code-highlight match' : 'code-highlight';
        const nx = 0.5 + (state.rect.x - 0.5) * z;
        const ny = 0.5 + (state.rect.y - 0.5) * z;
        mark.style.left = (content.left - overlay.left + nx * content.width) + 'px';
        mark.style.top = (content.top - overlay.top + ny * content.height) + 'px';
        mark.style.width = Math.max(0, state.rect.w * z * content.width) + 'px';
        mark.style.height = Math.max(0, state.rect.h * z * content.height) + 'px';
        const label = document.createElement('span');
        label.textContent = state.value;
        mark.appendChild(label);
        layer.appendChild(mark);
    });
}

function highlightFrame() {
    if (scanMode === 'camera' && !hardwareZoom && zoomLevel > 1) {
        const rect = video.getBoundingClientRect();
        const z = zoomLevel;
        const width = rect.width / z;
        const height = rect.height / z;
        return {
            left: rect.left + (rect.width - width) / 2,
            top: rect.top + (rect.height - height) / 2,
            width: width,
            height: height,
            zoom: z
        };
    }
    const content = videoContentRect();
    content.zoom = 1;
    return content;
}

function clearHighlights() {
    const layer = document.getElementById('codeHighlights');
    if (layer) layer.replaceChildren();
}

function addMatchCard(row) {
    const awb = String(row.awbNumber || '').trim();
    const list = document.getElementById('matchList');
    if (!list || !awb) return;
    const existing = Array.from(list.children).some(card => card.dataset.awb === awb);
    if (existing) return;
    const card = document.createElement('div');
    card.className = 'match-result';
    card.dataset.awb = awb;
    const header = document.createElement('div');
    header.className = 'match-header match-found';
    header.textContent = 'AWB FOUND';
    const details = document.createElement('div');
    details.className = 'match-details';
    Object.entries(row).forEach(([key, value]) => {
        if (key === 'awbNumber') return;
        const line = document.createElement('div');
        line.className = 'match-row';
        const keyEl = document.createElement('span');
        keyEl.className = 'match-key';
        keyEl.textContent = key + ': ';
        const valueEl = document.createElement('span');
        valueEl.className = 'match-value';
        valueEl.textContent = value == null ? '' : String(value);
        line.append(keyEl, valueEl);
        details.appendChild(line);
    });
    card.append(header, details);
    list.prepend(card);
    try {
        card.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    } catch (err) { /* ignore */ }
}

async function startCamera() {
    try {
        stream = await navigator.mediaDevices.getUserMedia({
            video: { facingMode: 'environment' }
        });
        videoTrack = stream.getVideoTracks()[0];
        initZoom();
        video.srcObject = stream;
        return true;
    } catch (err) {
        console.error('Error accessing camera:', err);
        alert('Unable to access camera. Please grant camera permissions.');
        return false;
    }
}

function stopStream() {
    if (!stream) return;
    stream.getTracks().forEach(track => track.stop());
    stream = null;
    videoTrack = null;
}

async function requestDisplayStream() {
    // Hints only. Chrome still offers Entire screen, Window, and Chrome tab.
    // displaySurface "window" pre-selects the Window pane (WhatsApp Desktop
    // lives there, not under Chrome tab) and does not remove the other panes.
    // selfBrowserSurface "include" keeps this tab in the Chrome tab list too.
    // monitorTypeSurfaces "include" keeps Entire screen, which is the fallback
    // when an app window is missing from the Window list.
    // No cursor or frameRate max: those are applied after a choice and must
    // not be able to fail the capture of a particular window.
    const attempts = [
        {
            video: { displaySurface: 'window' },
            audio: false,
            preferCurrentTab: false,
            selfBrowserSurface: 'include',
            surfaceSwitching: 'include',
            monitorTypeSurfaces: 'include'
        },
        {
            video: true,
            audio: false,
            preferCurrentTab: false,
            selfBrowserSurface: 'include',
            surfaceSwitching: 'include',
            monitorTypeSurfaces: 'include'
        },
        { video: true, audio: false }
    ];
    let lastError = null;
    for (let i = 0; i < attempts.length; i++) {
        try {
            return await navigator.mediaDevices.getDisplayMedia(attempts[i]);
        } catch (err) {
            lastError = err;
            // The picker was shown and dismissed. Do not open it again.
            if (err && (err.name === 'NotAllowedError' || err.name === 'AbortError')) throw err;
        }
    }
    throw lastError || new Error('Could not start screen sharing');
}

// Zoom support: uses native camera zoom when available, digital zoom otherwise
function initZoom() {
    zoomMin = 1;
    zoomMax = 6;
    zoomStep = 0;
    hardwareZoom = false;
    zoomLevel = 1;
    try {
        const caps = (videoTrack && videoTrack.getCapabilities) ? videoTrack.getCapabilities() : {};
        if (caps && typeof caps.zoom === 'object' && caps.zoom && typeof caps.zoom.max === 'number') {
            hardwareZoom = true;
            zoomMin = typeof caps.zoom.min === 'number' ? caps.zoom.min : 1;
            zoomMax = typeof caps.zoom.max === 'number' ? caps.zoom.max : zoomMin;
            if (typeof caps.zoom.step === 'number' && caps.zoom.step > 0) {
                zoomStep = caps.zoom.step;
            }
            const current = (videoTrack.getSettings) ? videoTrack.getSettings().zoom : null;
            if (typeof current === 'number' && current >= zoomMin && current <= zoomMax) {
                zoomLevel = snapZoom(current);
            } else {
                zoomLevel = zoomMin;
            }
        }
    } catch (err) {
        hardwareZoom = false;
    }
    video.style.transform = '';
    applyZoom();
    updateZoomUI();
}

function snapZoom(value) {
    if (!zoomStep || zoomStep <= 0) return value;
    const snapped = zoomMin + Math.round((value - zoomMin) / zoomStep) * zoomStep;
    return Math.round(snapped * 1000) / 1000;
}

function setZoom(value) {
    let clamped = Math.min(zoomMax, Math.max(zoomMin, value));
    if (hardwareZoom) clamped = snapZoom(clamped);
    if (clamped === zoomLevel) return;
    zoomLevel = clamped;
    applyZoom();
    updateZoomUI();
}

function applyZoom() {
    if (hardwareZoom && videoTrack) {
        const target = zoomLevel;
        zoomApplyChain = zoomApplyChain.then(() =>
            videoTrack.applyConstraints({ advanced: [{ zoom: target }] })
                .catch(() => {
                    // Native zoom rejected on this device, fall back to digital zoom
                    hardwareZoom = false;
                    zoomStep = 0;
                    zoomMin = 1;
                    zoomMax = Math.min(zoomMax, 6);
                    zoomLevel = Math.min(zoomLevel, zoomMax);
                    video.style.transform = zoomLevel > 1 ? `scale(${zoomLevel})` : '';
                    updateZoomUI();
                })
        );
    } else {
        video.style.transform = zoomLevel > 1 ? `scale(${zoomLevel})` : '';
    }
}

function updateZoomUI() {
    const slider = document.getElementById('zoomSlider');
    if (!slider) return;
    slider.min = zoomMin;
    slider.max = zoomMax;
    slider.step = (hardwareZoom && zoomStep > 0) ? zoomStep : 0.1;
    slider.value = zoomLevel;
    const decimals = (hardwareZoom && zoomStep > 0 && zoomStep < 0.1) ? 2 : 1;
    document.getElementById('zoomValue').textContent = zoomLevel.toFixed(decimals) + 'x';
    document.getElementById('zoomOutBtn').disabled = zoomLevel <= zoomMin + 0.001;
    document.getElementById('zoomInBtn').disabled = zoomLevel >= zoomMax - 0.001;
}

function resetZoom() {
    zoomLevel = 1;
    zoomMin = 1;
    zoomMax = 6;
    zoomStep = 0;
    hardwareZoom = false;
    if (video) video.style.transform = '';
    updateZoomUI();
}

function drawVideoFrame() {
    const vw = video.videoWidth;
    const vh = video.videoHeight;
    if (!hardwareZoom && zoomLevel > 1 && vw > 0 && vh > 0) {
        // Digital zoom: send only the centered crop to the detector
        const sw = vw / zoomLevel;
        const sh = vh / zoomLevel;
        const sx = (vw - sw) / 2;
        const sy = (vh - sh) / 2;
        context.drawImage(video, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);
        frameMap = { sx: sx, sy: sy, sw: sw, sh: sh, dw: canvas.width, dh: canvas.height, vw: vw, vh: vh };
    } else {
        context.drawImage(video, 0, 0, canvas.width, canvas.height);
        frameMap = { sx: 0, sy: 0, sw: vw, sh: vh, dw: canvas.width, dh: canvas.height, vw: vw, vh: vh };
    }
}

// Integer upscales keep Code 128 bars aligned. A tight crop of a small
// on-screen barcode is enlarged; a full desktop frame is capped so each
// pass stays fast enough to repeat.
function chooseScale(sourceWidth, sourceHeight, hasRegion) {
    const longSide = Math.max(sourceWidth, sourceHeight);
    const cap = hasRegion ? 1800 : 1400;
    if (longSide > cap) return cap / longSide;
    if (longSide >= 900) return 1;
    if (longSide >= 450) return 2;
    return 3;
}

let lastPaintScale = 1;

function paintScreenCanvas(smooth) {
    const vw = video.videoWidth;
    const vh = video.videoHeight;
    if (!vw || !vh) return false;

    let sx = 0;
    let sy = 0;
    let sw = vw;
    let sh = vh;
    const hasRegion = !!(screenRegion && !awaitingRegion);
    if (hasRegion) {
        sx = Math.round(screenRegion.x * vw);
        sy = Math.round(screenRegion.y * vh);
        sw = Math.round(screenRegion.w * vw);
        sh = Math.round(screenRegion.h * vh);
        // Pad a little so a tight box still leaves the barcode its quiet zone.
        const padX = Math.round(sw * 0.08);
        const padY = Math.round(sh * 0.1);
        sx = Math.max(0, sx - padX);
        sy = Math.max(0, sy - padY);
        sw = Math.min(vw - sx, sw + padX * 2);
        sh = Math.min(vh - sy, sh + padY * 2);
    }
    if (sw < 8 || sh < 8) return false;

    const scale = chooseScale(sw, sh, hasRegion);
    lastPaintScale = scale;
    const dw = Math.max(1, Math.round(sw * scale));
    const dh = Math.max(1, Math.round(sh * scale));
    if (canvas.width !== dw || canvas.height !== dh) {
        canvas.width = dw;
        canvas.height = dh;
    }
    // Screen captures are antialiased. A high-quality upscale rebuilds thin
    // Code 128 bars; nearest-neighbor just enlarges the blur and misses.
    // Downscales also stay smooth so a large frame doesn't sparkle.
    context.imageSmoothingEnabled = smooth || scale < 1;
    context.imageSmoothingQuality = 'high';
    context.drawImage(video, sx, sy, sw, sh, 0, 0, dw, dh);
    frameMap = { sx: sx, sy: sy, sw: sw, sh: sh, dw: dw, dh: dh, vw: vw, vh: vh };
    return true;
}

async function scanBarcode() {
    if (scanMode !== 'camera') {
        cameraLoopRunning = false;
        return;
    }
    drawVideoFrame();
    try {
        const codes = await detectFromCanvas();
        if (scanMode !== 'camera') {
            cameraLoopRunning = false;
            return;
        }
        handleCodes(codes);
    } catch (err) {
        console.error('Error detecting barcode:', err);
        if (decoderKind === 'native') reinitDetector();
    }
    if (scanMode === 'camera') requestAnimationFrame(scanBarcode);
    else cameraLoopRunning = false;
}

async function screenScanLoop(token) {
    while (scanMode === 'screen' && token === screenLoopToken) {
        const started = performance.now();
        const shareLive = stream && stream.getVideoTracks().some(item => item.readyState === 'live');
        if (!shareLive) {
            if (scanMode === 'screen') stopActiveScan();
            return;
        }
        if (!regionDrag && !awaitingRegion && video.readyState >= 2) {
            try {
                let codes = [];
                let painted = false;
                if (paintScreenCanvas(true)) {
                    painted = true;
                    codes = await detectFromCanvas();
                    if (scanMode !== 'screen' || token !== screenLoopToken) return;
                }
                // A crisp, pixel-aligned barcode prefers nearest-neighbor.
                // Try that only after a complete miss, and not on every idle frame.
                if (painted && (!codes || !codes.length) && lastPaintScale > 1) {
                    screenMissStreak += 1;
                    if (screenMissStreak % 3 === 1 && paintScreenCanvas(false)) {
                        codes = await detectFromCanvas();
                        if (scanMode !== 'screen' || token !== screenLoopToken) return;
                    }
                } else {
                    screenMissStreak = 0;
                }
                handleCodes(codes);
            } catch (err) {
                console.error('Screen scan error:', err);
            }
        }
        const wait = Math.max(0, SCREEN_SCAN_INTERVAL_MS - (performance.now() - started));
        await delay(wait);
    }
}

function startDetectorRefresh() {
    stopDetectorRefresh();
    if (decoderKind !== 'native') return;
    detectorReinitTimer = setInterval(() => {
        if (scanMode === 'camera') reinitDetector();
    }, 30000);
}

function stopDetectorRefresh() {
    if (detectorReinitTimer) {
        clearInterval(detectorReinitTimer);
        detectorReinitTimer = null;
    }
}

function setControls(state) {
    document.getElementById('startBtn').disabled = !state.camera;
    document.getElementById('screenBtn').disabled = !state.screen;
    document.getElementById('stopBtn').disabled = !state.stop;
}

function startCameraLoop() {
    if (scanMode !== 'camera' || cameraLoopRunning) return;
    if (!video.videoWidth || !video.videoHeight) return;
    cameraLoopRunning = true;
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    scanBarcode();
}

async function startScanning() {
    if (scanMode) return;
    resumeAudio();
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        alert('Camera access is not available in this browser.');
        return;
    }

    setControls({ camera: false, screen: false, stop: false });
    const cameraReady = await startCamera();
    if (!cameraReady) {
        setControls({ camera: true, screen: true, stop: false });
        return;
    }

    scanMode = 'camera';
    scanning = true;
    resetScanSession();
    document.getElementById('stopBtn').textContent = 'Stop Scanner';
    setControls({ camera: false, screen: false, stop: true });
    document.getElementById('resultText').textContent = 'Scanning...';
    document.getElementById('zoomControls').classList.add('active');
    video.onloadedmetadata = () => {
        if (scanMode === 'camera' && decoderKind) startCameraLoop();
    };

    const decoderReady = await ensureDecoder();
    if (scanMode !== 'camera') return;
    if (!decoderReady) {
        stopActiveScan('Barcode scanning is not available in this browser.');
        alert('Barcode scanning is not available in this browser. Use Chrome or Edge. Desktop Windows needs a network connection so the ZXing fallback can load.');
        return;
    }
    startDetectorRefresh();
    startCameraLoop();
}

function loadSavedRegion() {
    try {
        const raw = localStorage.getItem(REGION_STORAGE_KEY);
        if (!raw) return null;
        const parsed = JSON.parse(raw);
        if (!isStoredRegion(parsed)) return null;
        return clampRegion(parsed);
    } catch (err) {
        return null;
    }
}

function isStoredRegion(value) {
    if (!value || typeof value !== 'object') return false;
    const nums = [value.x, value.y, value.w, value.h];
    if (!nums.every(n => typeof n === 'number' && isFinite(n))) return false;
    return value.w >= 0.02 && value.h >= 0.02 && value.x >= -0.01 && value.y >= -0.01
        && value.x + value.w <= 1.05 && value.y + value.h <= 1.05;
}

function clampRegion(region) {
    const x = Math.min(1, Math.max(0, region.x));
    const y = Math.min(1, Math.max(0, region.y));
    const w = Math.min(1 - x, Math.max(0, region.w));
    const h = Math.min(1 - y, Math.max(0, region.h));
    return { x, y, w, h };
}

function persistRegion(region) {
    try {
        if (!region) {
            localStorage.removeItem(REGION_STORAGE_KEY);
            return;
        }
        localStorage.setItem(REGION_STORAGE_KEY, JSON.stringify({
            x: Math.round(region.x * 10000) / 10000,
            y: Math.round(region.y * 10000) / 10000,
            w: Math.round(region.w * 10000) / 10000,
            h: Math.round(region.h * 10000) / 10000
        }));
    } catch (err) {
        // Storage can be blocked. The selection still works for this session.
    }
}

function videoContentRect() {
    const rect = video.getBoundingClientRect();
    const vw = video.videoWidth;
    const vh = video.videoHeight;
    if (!vw || !vh || !rect.width || !rect.height) {
        return { left: rect.left, top: rect.top, width: rect.width, height: rect.height };
    }
    const elementRatio = rect.width / rect.height;
    const videoRatio = vw / vh;
    if (!isFinite(elementRatio) || Math.abs(elementRatio - videoRatio) < 0.02) {
        return { left: rect.left, top: rect.top, width: rect.width, height: rect.height };
    }
    if (elementRatio > videoRatio) {
        const height = rect.height;
        const width = height * videoRatio;
        return { left: rect.left + (rect.width - width) / 2, top: rect.top, width, height };
    }
    const width = rect.width;
    const height = width / videoRatio;
    return { left: rect.left, top: rect.top + (rect.height - height) / 2, width, height };
}

function normFromEvent(event) {
    const content = videoContentRect();
    const width = content.width || 1;
    const height = content.height || 1;
    return {
        x: Math.min(1, Math.max(0, (event.clientX - content.left) / width)),
        y: Math.min(1, Math.max(0, (event.clientY - content.top) / height))
    };
}

function rectFromPoints(x0, y0, x1, y1) {
    const x = Math.min(x0, x1);
    const y = Math.min(y0, y1);
    return {
        x,
        y,
        w: Math.abs(x1 - x0),
        h: Math.abs(y1 - y0)
    };
}

function placeRegionBox(region) {
    const box = document.getElementById('regionBox');
    if (!region) {
        box.classList.remove('visible');
        return;
    }
    const content = videoContentRect();
    const overlayRect = document.getElementById('regionLayer').getBoundingClientRect();
    box.style.left = (content.left - overlayRect.left + region.x * content.width) + 'px';
    box.style.top = (content.top - overlayRect.top + region.y * content.height) + 'px';
    box.style.width = Math.max(0, region.w * content.width) + 'px';
    box.style.height = Math.max(0, region.h * content.height) + 'px';
    box.classList.add('visible');
}

function updateScreenHint() {
    const hint = document.getElementById('screenHint');
    const prompt = document.getElementById('regionPrompt');
    const windowHint = ' If a window isn\'t listed, share Entire screen and drag over it.';
    if (awaitingRegion) {
        hint.textContent = 'Drag a rectangle on the preview. Only that area is scanned.' + windowHint;
        prompt.textContent = regionRestored ? 'Drag a new rectangle' : 'Drag to select the barcode area';
        prompt.classList.add('active');
    } else if (screenRegion) {
        hint.textContent = (regionRestored
            ? 'Scanning your last selection. Drag to adjust it, or use Full frame.'
            : 'Scanning the selected area. Drag to adjust it, or use Full frame.') + windowHint;
        prompt.classList.remove('active');
    } else {
        hint.textContent = 'Scanning the whole shared screen. Drag a rectangle to limit it.' + windowHint;
        prompt.classList.remove('active');
    }

    const scanningFullFrame = scanMode === 'screen' && !screenRegion && !awaitingRegion && !regionDrag;
    document.getElementById('scannerContainer').classList.toggle('full-frame', scanningFullFrame);
    document.getElementById('fullFrameBtn').disabled = scanningFullFrame;
    document.getElementById('reselectBtn').disabled = awaitingRegion && !screenRegion;
}

function renderRegionOverlay() {
    const draft = regionDrag
        ? rectFromPoints(regionDrag.x0, regionDrag.y0, regionDrag.x1, regionDrag.y1)
        : null;
    placeRegionBox(draft && (draft.w > 0 || draft.h > 0) ? draft : screenRegion);
    updateScreenHint();
}

function showScreenChrome() {
    document.body.classList.add('screen-active');
    document.getElementById('scannerContainer').classList.add('screen-mode');
    document.getElementById('screenTools').classList.add('active');
    document.getElementById('regionLayer').classList.add('active');
    document.getElementById('zoomControls').classList.remove('active');
    renderRegionOverlay();
}

function dragIsLargeEnough(rect) {
    const content = videoContentRect();
    return rect.w >= 0.02 && rect.h >= 0.02
        && rect.w * content.width >= 16
        && rect.h * content.height >= 16;
}

function onRegionPointerDown(event) {
    if (scanMode !== 'screen') return;
    if (event.button !== undefined && event.button !== 0) return;
    event.preventDefault();
    const layer = document.getElementById('regionLayer');
    try { layer.setPointerCapture(event.pointerId); } catch (err) { /* ignore */ }
    const point = normFromEvent(event);
    regionDrag = { pointerId: event.pointerId, x0: point.x, y0: point.y, x1: point.x, y1: point.y };
    awaitingRegion = true;
    renderRegionOverlay();
}

function onRegionPointerMove(event) {
    if (!regionDrag || regionDrag.pointerId !== event.pointerId) return;
    const point = normFromEvent(event);
    regionDrag.x1 = point.x;
    regionDrag.y1 = point.y;
    renderRegionOverlay();
}

function onRegionPointerUp(event) {
    if (!regionDrag || (event && regionDrag.pointerId !== event.pointerId)) return;
    const rect = rectFromPoints(regionDrag.x0, regionDrag.y0, regionDrag.x1, regionDrag.y1);
    regionDrag = null;
    if (!dragIsLargeEnough(rect)) {
        awaitingRegion = !screenRegion;
        renderRegionOverlay();
        return;
    }
    screenRegion = clampRegion(rect);
    awaitingRegion = false;
    regionRestored = false;
    persistRegion(screenRegion);
    renderRegionOverlay();
    document.getElementById('resultText').textContent = 'Scanning the selected area...';
}

function useFullFrame() {
    if (scanMode !== 'screen') return;
    resumeAudio();
    screenRegion = null;
    awaitingRegion = false;
    regionDrag = null;
    regionRestored = false;
    persistRegion(null);
    renderRegionOverlay();
    document.getElementById('resultText').textContent = 'Scanning the whole shared screen...';
}

function beginReselect() {
    if (scanMode !== 'screen') return;
    resumeAudio();
    screenRegion = null;
    awaitingRegion = true;
    regionDrag = null;
    regionRestored = false;
    persistRegion(null);
    renderRegionOverlay();
    document.getElementById('resultText').textContent = 'Drag a new rectangle to choose what to scan';
}

async function startScreenScan() {
    if (scanMode) return;
    resumeAudio();
    if (!navigator.mediaDevices || !navigator.mediaDevices.getDisplayMedia) {
        alert('Screen sharing is not available in this browser. Open this page in desktop Chrome or Edge, or use Start Scanner with the camera.');
        return;
    }

    setControls({ camera: false, screen: false, stop: false });
    document.getElementById('resultText').textContent = 'Choose a screen, window, or tab to share...';

    let displayStream;
    try {
        displayStream = await requestDisplayStream();
    } catch (err) {
        console.error('Screen share failed:', err);
        setControls({ camera: true, screen: true, stop: false });
        if (err && (err.name === 'NotAllowedError' || err.name === 'AbortError')) {
            document.getElementById('resultText').textContent = 'Screen share cancelled';
            return;
        }
        document.getElementById('resultText').textContent = 'Waiting for scan...';
        alert('Unable to share the screen. ' + (err && err.message ? err.message : 'Please try again.'));
        return;
    }

    const track = displayStream.getVideoTracks()[0];
    if (!track) {
        displayStream.getTracks().forEach(item => item.stop());
        setControls({ camera: true, screen: true, stop: false });
        alert('The shared screen did not include video.');
        return;
    }

    scanMode = 'screen';
    scanning = true;
    stream = displayStream;
    videoTrack = null;
    resetScanSession();
    regionDrag = null;
    const saved = loadSavedRegion();
    if (saved) {
        screenRegion = saved;
        awaitingRegion = false;
        regionRestored = true;
    } else {
        screenRegion = null;
        awaitingRegion = true;
        regionRestored = false;
    }

    const onShareEnded = () => {
        if (scanMode === 'screen') stopActiveScan();
    };
    // The browser's "Stop sharing" bar ends the track. `inactive` covers
    // the stream going dead without a separate ended event.
    track.addEventListener('ended', onShareEnded);
    displayStream.addEventListener('inactive', onShareEnded);

    video.srcObject = displayStream;
    video.muted = true;
    try { await video.play(); } catch (err) { /* autoplay can reject; frames may still arrive */ }

    document.getElementById('stopBtn').textContent = 'Stop Sharing';
    setControls({ camera: false, screen: false, stop: true });
    showScreenChrome();
    document.getElementById('resultText').textContent = 'Preparing scanner...';

    if (track.readyState === 'ended') {
        stopActiveScan();
        return;
    }

    const decoderReady = await ensureDecoder();
    if (scanMode !== 'screen') return;
    if (!decoderReady) {
        stopActiveScan('Barcode scanning is not available in this browser.');
        alert('Barcode scanning is not available in this browser. Use Chrome or Edge. Desktop Windows needs a network connection so the ZXing fallback can load.');
        return;
    }

    renderRegionOverlay();
    if (awaitingRegion) {
        document.getElementById('resultText').textContent = 'Drag a rectangle on the preview to choose what to scan';
    } else if (screenRegion) {
        document.getElementById('resultText').textContent = 'Scanning your last selection...';
    } else {
        document.getElementById('resultText').textContent = 'Scanning the whole shared screen...';
    }

    screenLoopToken += 1;
    screenScanLoop(screenLoopToken);
}

function stopActiveScan(message) {
    if (!scanMode) return;
    const mode = scanMode;
    scanMode = null;
    scanning = false;
    cameraLoopRunning = false;
    screenLoopToken += 1;
    regionDrag = null;
    awaitingRegion = false;
    stopDetectorRefresh();
    stopStream();
    if (video) {
        video.onloadedmetadata = null;
        try { video.pause(); } catch (err) { /* ignore */ }
        video.srcObject = null;
    }
    resetZoom();
    document.getElementById('zoomControls').classList.remove('active');
    document.body.classList.remove('screen-active');
    const container = document.getElementById('scannerContainer');
    container.classList.remove('screen-mode', 'full-frame');
    document.getElementById('screenTools').classList.remove('active');
    document.getElementById('regionLayer').classList.remove('active');
    document.getElementById('regionBox').classList.remove('visible');
    document.getElementById('regionPrompt').classList.remove('active');
    clearHighlights();
    document.getElementById('stopBtn').textContent = 'Stop Scanner';
    setControls({ camera: true, screen: true, stop: false });
    document.getElementById('resultText').textContent = message
        || (mode === 'screen' ? 'Screen sharing stopped' : 'Scanner stopped');
}

function stopScanning() {
    stopActiveScan();
}

async function handleExcelFile(file) {
    if (!file) return;
    try {
        const data = await parseExcel(file);
        buildAWBMap(data);
        await saveAWBToDB(data);
        updateAWBStatus();
    } catch (err) {
        alert('Error reading Excel file: ' + err.message);
    }
}

// Initialize
window.addEventListener('DOMContentLoaded', async () => {
    video = document.getElementById('video');
    canvas = document.getElementById('canvas');
    context = canvas.getContext('2d', { willReadFrequently: true });

    document.getElementById('startBtn').addEventListener('click', startScanning);
    document.getElementById('screenBtn').addEventListener('click', startScreenScan);
    document.getElementById('stopBtn').addEventListener('click', stopScanning);
    document.getElementById('fullFrameBtn').addEventListener('click', useFullFrame);
    document.getElementById('reselectBtn').addEventListener('click', beginReselect);

    const regionLayer = document.getElementById('regionLayer');
    regionLayer.addEventListener('pointerdown', onRegionPointerDown);
    regionLayer.addEventListener('pointermove', onRegionPointerMove);
    regionLayer.addEventListener('pointerup', onRegionPointerUp);
    regionLayer.addEventListener('pointercancel', onRegionPointerUp);

    if (typeof ResizeObserver === 'function') {
        const observer = new ResizeObserver(() => {
            if (scanMode === 'screen') renderRegionOverlay();
            renderHighlights(Date.now());
        });
        observer.observe(video);
    } else {
        window.addEventListener('resize', () => {
            if (scanMode === 'screen') renderRegionOverlay();
            renderHighlights(Date.now());
        });
    }

    // Zoom controls
    document.getElementById('zoomInBtn').addEventListener('click', () => setZoom(zoomLevel + 1));
    document.getElementById('zoomOutBtn').addEventListener('click', () => setZoom(zoomLevel - 1));
    document.getElementById('zoomSlider').addEventListener('input', (e) => {
        setZoom(parseFloat(e.target.value));
    });

    // Load saved data
    const saved = await loadAWBFromDB();
    if (saved && saved.length > 0) {
        buildAWBMap(saved);
    }
    updateAWBStatus();

    // File upload handler
    document.getElementById('uploadBtn').addEventListener('click', () => {
        resumeAudio();
        document.getElementById('fileInput').click();
    });

    document.getElementById('fileInput').addEventListener('change', async (e) => {
        const file = e.target.files[0];
        await handleExcelFile(file);
        e.target.value = '';
    });

    // Clear data
    document.getElementById('clearDataBtn').addEventListener('click', async () => {
        awbData = [];
        awbMap = {};
        await clearAWBFromDB();
        updateAWBStatus();
        const matches = document.getElementById('matchList');
        if (matches) matches.replaceChildren();
        codeState.forEach(state => { state.lastSeen = 0; });
        renderCodeList(Date.now());
    });

    // Upload area drag & drop
    const uploadArea = document.getElementById('uploadArea');
    uploadArea.addEventListener('dragover', (e) => {
        e.preventDefault();
        uploadArea.classList.add('dragover');
    });
    uploadArea.addEventListener('dragleave', () => {
        uploadArea.classList.remove('dragover');
    });
    uploadArea.addEventListener('drop', async (e) => {
        e.preventDefault();
        uploadArea.classList.remove('dragover');
        const file = e.dataTransfer.files[0];
        await handleExcelFile(file);
    });
});
