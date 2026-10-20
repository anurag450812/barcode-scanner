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

const audioContext = new (window.AudioContext || window.webkitAudioContext)();

function playBeep() {
    const oscillator = audioContext.createOscillator();
    const gainNode = audioContext.createGain();
    oscillator.connect(gainNode);
    gainNode.connect(audioContext.destination);
    oscillator.frequency.value = 800;
    oscillator.type = 'sine';
    gainNode.gain.setValueAtTime(0.3, audioContext.currentTime);
    gainNode.gain.exponentialRampToValueAtTime(0.01, audioContext.currentTime + 0.2);
    oscillator.start(audioContext.currentTime);
    oscillator.stop(audioContext.currentTime + 0.2);
}

function playSiren() {
    const now = audioContext.currentTime;
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

async function initBarcodeDetector() {
    if (!('BarcodeDetector' in window)) {
        alert('Barcode Detection API is not supported in this browser. Please use Chrome on Android or a compatible browser.');
        return false;
    }
    try {
        barcodeDetector = new BarcodeDetector({
            formats: [
                'aztec', 'code_128', 'code_39', 'code_93', 'codabar',
                'data_matrix', 'ean_13', 'ean_8', 'itf', 'pdf417',
                'qr_code', 'upc_a', 'upc_e'
            ]
        });
        return true;
    } catch (err) {
        console.error('Error creating BarcodeDetector:', err);
        return false;
    }
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

async function scanBarcode() {
    if (!scanning) return;
    drawVideoFrame();
    try {
        const barcodes = await barcodeDetector.detect(canvas);
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
        reinitDetector();
    }
    requestAnimationFrame(scanBarcode);
}

function reinitDetector() {
    if (!('BarcodeDetector' in window)) return;
    try {
        barcodeDetector = new BarcodeDetector({
            formats: [
                'aztec', 'code_128', 'code_39', 'code_93', 'codabar',
                'data_matrix', 'ean_13', 'ean_8', 'itf', 'pdf417',
                'qr_code', 'upc_a', 'upc_e'
            ]
        });
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

async function startScanning() {
    if (scanning) return;
    const detectorReady = await initBarcodeDetector();
    if (!detectorReady) return;
    const cameraReady = await startCamera();
    if (!cameraReady) return;

    scanning = true;
    lastScannedValue = '';
    lastScanTime = 0;
    document.getElementById('startBtn').disabled = true;
    document.getElementById('stopBtn').disabled = false;
    document.getElementById('resultText').textContent = 'Scanning...';
    document.getElementById('zoomControls').classList.add('active');
    startDetectorRefresh();

    video.onloadedmetadata = () => {
        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;
        scanBarcode();
    };
}

function stopScanning() {
    scanning = false;
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
    context = canvas.getContext('2d');

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
