let video;
let canvas;
let context;
let scanning = false;
let barcodeDetector;
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

let lastScannedValue = '';
let lastScanTime = 0;
let detectorReinitTimer = null;
let scanLoopStarted = false;
let scanArmTimer = null;
let startInProgress = false;

// Native BarcodeDetector when the browser has it; ZXing from a CDN otherwise.
let usingNativeDetector = false;
let zxingReader = null;
let zxingReaderHard = null;
let zxingMissCount = 0;
let zxingLoadPromise = null;
let decodeCanvas = null;
let decodeContext = null;
let rotateCanvasEl = null;
let rotateContext = null;

const NATIVE_FORMATS = [
    'aztec', 'code_128', 'code_39', 'code_93', 'codabar',
    'data_matrix', 'ean_13', 'ean_8', 'itf', 'pdf417',
    'qr_code', 'upc_a', 'upc_e'
];

const ZXING_CDN_URLS = [
    'https://cdn.jsdelivr.net/npm/@zxing/library@0.21.3/umd/index.min.js',
    'https://unpkg.com/@zxing/library@0.21.3/umd/index.min.js'
];

// Cap the fallback decode size so a 4K webcam does not stall the page.
const DECODE_MAX_WIDTH = 1280;
// Yield between JS decodes so the camera preview keeps painting.
const FALLBACK_SCAN_INTERVAL_MS = 80;

let audioContext = null;

function getAudioContext() {
    if (audioContext) return audioContext;
    const AudioCtor = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtor) return null;
    try {
        audioContext = new AudioCtor();
    } catch (err) {
        console.error('Audio unavailable:', err);
        return null;
    }
    return audioContext;
}

function resumeAudio() {
    const ctx = getAudioContext();
    if (ctx && ctx.state === 'suspended') {
        ctx.resume().catch(() => {});
    }
}

function playBeep() {
    try {
        const ctx = getAudioContext();
        if (!ctx) return;
        resumeAudio();
        const oscillator = ctx.createOscillator();
        const gainNode = ctx.createGain();
        oscillator.connect(gainNode);
        gainNode.connect(ctx.destination);
        oscillator.frequency.value = 800;
        oscillator.type = 'sine';
        gainNode.gain.setValueAtTime(0.3, ctx.currentTime);
        gainNode.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.2);
        oscillator.start(ctx.currentTime);
        oscillator.stop(ctx.currentTime + 0.2);
    } catch (err) {
        console.error('Beep failed:', err);
    }
}

function playSiren() {
    try {
        const ctx = getAudioContext();
        if (!ctx) return;
        resumeAudio();
        const now = ctx.currentTime;
        for (let i = 0; i < 3; i++) {
            const osc = ctx.createOscillator();
            const gain = ctx.createGain();
            osc.connect(gain);
            gain.connect(ctx.destination);
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

function createNativeDetector() {
    return new BarcodeDetector({ formats: NATIVE_FORMATS });
}

function loadScript(src, timeoutMs) {
    return new Promise((resolve, reject) => {
        const script = document.createElement('script');
        script.src = src;
        script.async = true;
        let settled = false;
        const timer = setTimeout(() => {
            if (settled) return;
            settled = true;
            script.onload = null;
            script.onerror = null;
            reject(new Error('Timed out loading barcode decoder'));
        }, timeoutMs);
        script.onload = () => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            resolve();
        };
        script.onerror = () => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            reject(new Error('Failed to load barcode decoder'));
        };
        document.head.appendChild(script);
    });
}

function loadZxing() {
    if (window.ZXing && window.ZXing.MultiFormatReader) return Promise.resolve();
    if (zxingLoadPromise) return zxingLoadPromise;
    zxingLoadPromise = (async () => {
        let lastErr = null;
        for (const src of ZXING_CDN_URLS) {
            try {
                await loadScript(src, 15000);
                if (window.ZXing && window.ZXing.MultiFormatReader) return;
            } catch (err) {
                lastErr = err;
            }
        }
        zxingLoadPromise = null;
        throw lastErr || new Error('Barcode decoder failed to load');
    })();
    return zxingLoadPromise;
}

function zxingFormats() {
    const Z = window.ZXing;
    return [
        Z.BarcodeFormat.AZTEC,
        Z.BarcodeFormat.CODABAR,
        Z.BarcodeFormat.CODE_39,
        Z.BarcodeFormat.CODE_93,
        Z.BarcodeFormat.CODE_128,
        Z.BarcodeFormat.DATA_MATRIX,
        Z.BarcodeFormat.EAN_8,
        Z.BarcodeFormat.EAN_13,
        Z.BarcodeFormat.ITF,
        Z.BarcodeFormat.PDF_417,
        Z.BarcodeFormat.QR_CODE,
        Z.BarcodeFormat.UPC_A,
        Z.BarcodeFormat.UPC_E
    ];
}

function createZxingReader(tryHarder) {
    const Z = window.ZXing;
    const hints = new Map();
    hints.set(Z.DecodeHintType.POSSIBLE_FORMATS, zxingFormats());
    if (tryHarder) hints.set(Z.DecodeHintType.TRY_HARDER, true);
    const reader = new Z.MultiFormatReader();
    reader.setHints(hints);
    return reader;
}

function zxingFormatName(format) {
    const Z = window.ZXing;
    const names = {
        [Z.BarcodeFormat.AZTEC]: 'aztec',
        [Z.BarcodeFormat.CODABAR]: 'codabar',
        [Z.BarcodeFormat.CODE_39]: 'code_39',
        [Z.BarcodeFormat.CODE_93]: 'code_93',
        [Z.BarcodeFormat.CODE_128]: 'code_128',
        [Z.BarcodeFormat.DATA_MATRIX]: 'data_matrix',
        [Z.BarcodeFormat.EAN_8]: 'ean_8',
        [Z.BarcodeFormat.EAN_13]: 'ean_13',
        [Z.BarcodeFormat.ITF]: 'itf',
        [Z.BarcodeFormat.PDF_417]: 'pdf417',
        [Z.BarcodeFormat.QR_CODE]: 'qr_code',
        [Z.BarcodeFormat.UPC_A]: 'upc_a',
        [Z.BarcodeFormat.UPC_E]: 'upc_e'
    };
    return names[format] || 'unknown';
}

function isZxingMiss(err) {
    const Z = window.ZXing;
    if (!err || !Z) return false;
    if ((Z.NotFoundException && err instanceof Z.NotFoundException)
        || (Z.ChecksumException && err instanceof Z.ChecksumException)
        || (Z.FormatException && err instanceof Z.FormatException)) {
        return true;
    }
    const kind = typeof err.getKind === 'function' ? err.getKind() : err.name;
    return kind === 'NotFoundException' || kind === 'ChecksumException' || kind === 'FormatException';
}

async function initZxingReader() {
    const resultText = document.getElementById('resultText');
    if (resultText) resultText.textContent = 'Starting scanner...';
    await loadZxing();
    zxingReader = createZxingReader(false);
    zxingReaderHard = createZxingReader(true);
    zxingMissCount = 0;
    usingNativeDetector = false;
}

async function initBarcodeDetector() {
    if ('BarcodeDetector' in window) {
        try {
            barcodeDetector = createNativeDetector();
            usingNativeDetector = true;
            return true;
        } catch (err) {
            console.error('Error creating BarcodeDetector:', err);
        }
    }
    try {
        await initZxingReader();
        return true;
    } catch (err) {
        console.error('Error loading barcode decoder:', err);
        const resultText = document.getElementById('resultText');
        if (resultText) {
            resultText.textContent = 'Unable to load the barcode scanner. Check your connection and try again.';
        }
        return false;
    }
}

function isRecoverableCameraError(err) {
    const name = err && err.name;
    return name === 'OverconstrainedError'
        || name === 'ConstraintNotSatisfiedError'
        || name === 'NotFoundError'
        || name === 'DevicesNotFoundError';
}

async function startCamera() {
    // Prefer the rear camera, but accept whatever the device actually has.
    const attempts = [
        { video: { facingMode: { ideal: 'environment' } } },
        { video: true }
    ];
    let lastError = null;
    stream = null;
    for (let i = 0; i < attempts.length; i++) {
        try {
            stream = await navigator.mediaDevices.getUserMedia(attempts[i]);
            lastError = null;
            break;
        } catch (err) {
            lastError = err;
            stream = null;
            if (!isRecoverableCameraError(err)) break;
        }
    }
    if (!stream) {
        console.error('Error accessing camera:', lastError);
        alert('Unable to access camera. Please grant camera permissions.');
        return false;
    }
    videoTrack = stream.getVideoTracks()[0];
    initZoom();
    video.muted = true;
    video.playsInline = true;
    video.srcObject = stream;
    try {
        await video.play();
    } catch (err) {
        // autoplay / playsinline still starts the preview on most browsers
    }
    return true;
}

function stopCamera() {
    if (stream) {
        stream.getTracks().forEach(track => track.stop());
        stream = null;
        videoTrack = null;
    }
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
    video.style.transform = '';
    updateZoomUI();
}

function showMatch(row) {
    const matchEl = document.getElementById('matchResult');
    const headerEl = document.getElementById('matchHeader');
    const detailsEl = document.getElementById('matchDetails');

    headerEl.textContent = 'AWB FOUND';
    headerEl.className = 'match-header match-found';

    let html = '';
    Object.entries(row).forEach(([key, value]) => {
        if (key !== 'awbNumber') {
            html += `<div class="match-row"><span class="match-key">${key}:</span> <span class="match-value">${value}</span></div>`;
        }
    });
    detailsEl.innerHTML = html;
    matchEl.style.display = 'block';

    playSiren();
    vibrateLong();
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
    } else {
        context.drawImage(video, 0, 0, canvas.width, canvas.height);
    }
}

function scaleCanvasForDecode(source) {
    if (!source.width || source.width <= DECODE_MAX_WIDTH) return source;
    if (!decodeCanvas) {
        decodeCanvas = document.createElement('canvas');
        decodeContext = decodeCanvas.getContext('2d', { willReadFrequently: true });
    }
    const dw = DECODE_MAX_WIDTH;
    const dh = Math.max(1, Math.round(source.height * (DECODE_MAX_WIDTH / source.width)));
    if (decodeCanvas.width !== dw || decodeCanvas.height !== dh) {
        decodeCanvas.width = dw;
        decodeCanvas.height = dh;
    }
    decodeContext.imageSmoothingEnabled = false;
    decodeContext.drawImage(source, 0, 0, dw, dh);
    return decodeCanvas;
}

function rotateCanvas90(source) {
    if (!rotateCanvasEl) {
        rotateCanvasEl = document.createElement('canvas');
        rotateContext = rotateCanvasEl.getContext('2d', { willReadFrequently: true });
    }
    const dw = source.height;
    const dh = source.width;
    if (!dw || !dh) return source;
    if (rotateCanvasEl.width !== dw || rotateCanvasEl.height !== dh) {
        rotateCanvasEl.width = dw;
        rotateCanvasEl.height = dh;
    }
    rotateContext.setTransform(1, 0, 0, 1, 0, 0);
    rotateContext.clearRect(0, 0, dw, dh);
    rotateContext.translate(dw, 0);
    rotateContext.rotate(Math.PI / 2);
    rotateContext.imageSmoothingEnabled = false;
    rotateContext.drawImage(source, 0, 0);
    rotateContext.setTransform(1, 0, 0, 1, 0, 0);
    return rotateCanvasEl;
}

function readZxing(targetCanvas, reader, Binarizer) {
    try {
        const source = new window.ZXing.HTMLCanvasElementLuminanceSource(targetCanvas);
        const bitmap = new window.ZXing.BinaryBitmap(new Binarizer(source));
        const result = reader.decodeWithState(bitmap);
        const text = result.getText();
        if (!text) return null;
        return {
            rawValue: text,
            format: zxingFormatName(result.getBarcodeFormat())
        };
    } catch (err) {
        if (!isZxingMiss(err)) console.error('Error detecting barcode:', err);
        return null;
    } finally {
        try { reader.reset(); } catch (e) { /* keep scanning */ }
    }
}

function detectWithZxing(sourceCanvas) {
    if (!zxingReader || !sourceCanvas.width || !sourceCanvas.height) return [];
    const target = scaleCanvasForDecode(sourceCanvas);
    const Z = window.ZXing;
    let hit = readZxing(target, zxingReader, Z.HybridBinarizer);
    if (!hit) hit = readZxing(target, zxingReader, Z.GlobalHistogramBinarizer);
    if (hit) {
        zxingMissCount = 0;
        return [hit];
    }
    zxingMissCount++;
    // Vertical barcodes and faint frames: occasional extra attempts, not every frame.
    if (zxingMissCount % 4 === 0) {
        hit = readZxing(rotateCanvas90(target), zxingReader, Z.HybridBinarizer);
        if (hit) {
            zxingMissCount = 0;
            return [hit];
        }
    }
    if (zxingMissCount % 8 === 0 && zxingReaderHard) {
        hit = readZxing(target, zxingReaderHard, Z.HybridBinarizer);
        if (hit) {
            zxingMissCount = 0;
            return [hit];
        }
    }
    return [];
}

async function detectBarcodes() {
    if (usingNativeDetector) return barcodeDetector.detect(canvas);
    return detectWithZxing(canvas);
}

async function scanBarcode() {
    if (!scanning) return;
    drawVideoFrame();
    try {
        const barcodes = await detectBarcodes();
        if (!scanning) return;
        if (barcodes.length > 0) {
            const barcode = barcodes[0];
            const barcodeValue = barcode.rawValue;
            const now = Date.now();

            // Debounce: skip if same barcode scanned within 2 seconds
            if (barcodeValue !== lastScannedValue || now - lastScanTime > 2000) {
                lastScannedValue = barcodeValue;
                lastScanTime = now;

                // Fire-and-forget clipboard copy
                copyToClipboard(barcodeValue);

                playBeep();
                vibrate();
                document.getElementById('resultText').textContent =
                    `Scanned: ${barcodeValue} (${barcode.format})`;

                if (Object.keys(awbMap).length > 0) {
                    const found = awbMap[barcodeValue.trim()];
                    if (found) {
                        showMatch(found);
                    }
                }
            }
        }
    } catch (err) {
        console.error('Error detecting barcode:', err);
        if (usingNativeDetector) reinitDetector();
    }
    if (!scanning) return;
    // Native detector stays on requestAnimationFrame so it cannot stall after a few hits.
    // The JS decoder is throttled so a slow frame does not freeze the preview.
    if (usingNativeDetector) {
        requestAnimationFrame(scanBarcode);
    } else {
        setTimeout(() => {
            if (scanning) requestAnimationFrame(scanBarcode);
        }, FALLBACK_SCAN_INTERVAL_MS);
    }
}

function reinitDetector() {
    if (!usingNativeDetector || !('BarcodeDetector' in window)) return;
    try {
        barcodeDetector = createNativeDetector();
    } catch (e) { /* ignore */ }
}

function startDetectorRefresh() {
    stopDetectorRefresh();
    detectorReinitTimer = setInterval(() => {
        if (scanning) reinitDetector();
    }, 30000);
}

function stopDetectorRefresh() {
    if (detectorReinitTimer) {
        clearInterval(detectorReinitTimer);
        detectorReinitTimer = null;
    }
}

function beginScanLoop() {
    if (!scanning || scanLoopStarted) return;
    const vw = video.videoWidth;
    const vh = video.videoHeight;
    if (!vw || !vh) return;
    scanLoopStarted = true;
    if (scanArmTimer) {
        clearInterval(scanArmTimer);
        scanArmTimer = null;
    }
    canvas.width = vw;
    canvas.height = vh;
    scanBarcode();
}

function disarmScanLoop() {
    if (scanArmTimer) {
        clearInterval(scanArmTimer);
        scanArmTimer = null;
    }
    if (!video) return;
    video.onloadedmetadata = null;
    video.onloadeddata = null;
    video.onresize = null;
}

function armScanLoop() {
    disarmScanLoop();
    scanLoopStarted = false;
    const tryStart = () => {
        if (scanning) beginScanLoop();
    };
    video.onloadedmetadata = tryStart;
    video.onloadeddata = tryStart;
    video.onresize = tryStart;
}

function watchScanStart() {
    if (scanArmTimer) clearInterval(scanArmTimer);
    let tries = 0;
    scanArmTimer = setInterval(() => {
        if (!scanning || scanLoopStarted || tries++ > 40) {
            clearInterval(scanArmTimer);
            scanArmTimer = null;
            return;
        }
        beginScanLoop();
    }, 100);
}

async function startScanning() {
    if (scanning || startInProgress) return;
    startInProgress = true;
    const startBtn = document.getElementById('startBtn');
    startBtn.disabled = true;
    // Create/resume audio inside the click so iOS Safari will play beeps.
    resumeAudio();
    try {
        const detectorReady = await initBarcodeDetector();
        if (!detectorReady) {
            startBtn.disabled = false;
            return;
        }
        armScanLoop();
        const cameraReady = await startCamera();
        if (!cameraReady) {
            disarmScanLoop();
            startBtn.disabled = false;
            return;
        }

        scanning = true;
        lastScannedValue = '';
        lastScanTime = 0;
        document.getElementById('stopBtn').disabled = false;
        document.getElementById('resultText').textContent = 'Scanning...';
        document.getElementById('zoomControls').classList.add('active');
        if (usingNativeDetector) startDetectorRefresh();
        beginScanLoop();
        watchScanStart();
    } finally {
        startInProgress = false;
    }
}

function stopScanning() {
    scanning = false;
    scanLoopStarted = false;
    disarmScanLoop();
    stopCamera();
    stopDetectorRefresh();
    resetZoom();
    document.getElementById('zoomControls').classList.remove('active');
    document.getElementById('startBtn').disabled = false;
    document.getElementById('stopBtn').disabled = true;
    document.getElementById('resultText').textContent = 'Scanner stopped';
}

// Initialize
window.addEventListener('DOMContentLoaded', async () => {
    video = document.getElementById('video');
    canvas = document.getElementById('canvas');
    context = canvas.getContext('2d', { willReadFrequently: true });

    document.getElementById('startBtn').addEventListener('click', startScanning);
    document.getElementById('stopBtn').addEventListener('click', stopScanning);

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
        document.getElementById('fileInput').click();
    });

    document.getElementById('fileInput').addEventListener('change', async (e) => {
        const file = e.target.files[0];
        if (!file) return;
        try {
            const data = await parseExcel(file);
            buildAWBMap(data);
            await saveAWBToDB(data);
            updateAWBStatus();
        } catch (err) {
            alert('Error reading Excel file: ' + err.message);
        }
    });

    // Clear data
    document.getElementById('clearDataBtn').addEventListener('click', async () => {
        awbData = [];
        awbMap = {};
        await clearAWBFromDB();
        updateAWBStatus();
        document.getElementById('matchResult').style.display = 'none';
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
        if (file) {
            try {
                const data = await parseExcel(file);
                buildAWBMap(data);
                await saveAWBToDB(data);
                updateAWBStatus();
            } catch (err) {
                alert('Error reading Excel file: ' + err.message);
            }
        }
    });
});
