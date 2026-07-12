let video;
let canvas;
let context;
let scanning = false;
let barcodeDetector;
let stream;

let awbData = [];
let awbMap = {};

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

function isMobile() {
    return /Android|iPhone|iPad|iPod|webOS|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent)
        || (window.innerWidth <= 768);
}

function updateAWBStatus() {
    const statusEl = document.getElementById('awbStatus');
    const uploadEl = document.getElementById('uploadArea');
    const qrEl = document.getElementById('qrSection');
    const mobileEl = document.getElementById('mobileConnectSection');
    const countEl = document.getElementById('awbCount');

    const hasData = awbData.length > 0;

    if (hasData) {
        countEl.textContent = awbData.length;
        statusEl.style.display = 'flex';
        uploadEl.style.display = 'none';
        if (isMobile()) {
            qrEl.style.display = 'none';
            mobileEl.style.display = 'none';
        } else {
            qrEl.style.display = 'flex';
            mobileEl.style.display = 'none';
            generateQRCode();
        }
    } else {
        statusEl.style.display = 'none';
        qrEl.style.display = 'none';
        if (isMobile()) {
            uploadEl.style.display = 'none';
            mobileEl.style.display = 'flex';
        } else {
            uploadEl.style.display = 'flex';
            mobileEl.style.display = 'none';
        }
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

// QR Code generation
let qrInstance = null;

function generateQRCode() {
    const compressed = LZString.compressToEncodedURIComponent(JSON.stringify(awbData));
    const qrContainer = document.getElementById('qrCode');
    qrContainer.innerHTML = '';

    // QR codes max ~4296 alphanumeric chars; use larger error correction
    // For safety, warn if data is large
    if (compressed.length > 3000) {
        qrContainer.innerHTML = '<p class="qr-warning">Data too large for single QR code. Showing first portion.</p>';
    }

    qrInstance = new QRCode(qrContainer, {
        text: compressed.substring(0, 3000),
        width: 200,
        height: 200,
        colorDark: '#000000',
        colorLight: '#ffffff',
        correctLevel: QRCode.CorrectLevel.M
    });
}

// QR Code scanning (for mobile)
let qrScanStream = null;
let qrScanDetector = null;

async function startQRScan() {
    try {
        const detector = new BarcodeDetector({ formats: ['qr_code'] });
        const mediaStream = await navigator.mediaDevices.getUserMedia({
            video: { facingMode: 'environment' }
        });

        const tempVideo = document.createElement('video');
        tempVideo.srcObject = mediaStream;
        tempVideo.autoplay = true;
        tempVideo.playsinline = true;
        tempVideo.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;z-index:9999;object-fit:cover;background:#000;';

        const overlay = document.createElement('div');
        overlay.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;z-index:10000;display:flex;flex-direction:column;align-items:center;justify-content:center;pointer-events:none;';

        const instruction = document.createElement('div');
        instruction.textContent = 'Point camera at QR code on PC screen';
        instruction.style.cssText = 'color:white;font-size:18px;font-weight:600;text-shadow:0 2px 8px rgba(0,0,0,0.8);padding:16px 24px;background:rgba(0,0,0,0.6);border-radius:12px;margin-bottom:20px;pointer-events:auto;text-align:center;';

        const cancelBtn = document.createElement('button');
        cancelBtn.textContent = 'Cancel';
        cancelBtn.style.cssText = 'color:white;font-size:16px;font-weight:600;padding:12px 32px;background:rgba(239,83,80,0.9);border:none;border-radius:10px;cursor:pointer;pointer-events:auto;margin-top:10px;';
        cancelBtn.onclick = () => stopQRScan(mediaStream, tempVideo, overlay);

        overlay.appendChild(instruction);
        overlay.appendChild(cancelBtn);
        document.body.appendChild(tempVideo);
        document.body.appendChild(overlay);

        await tempVideo.play();

        const tempCanvas = document.createElement('canvas');
        const tempCtx = tempCanvas.getContext('2d');

        async function scanLoop() {
            if (!tempVideo.videoWidth) {
                requestAnimationFrame(scanLoop);
                return;
            }
            tempCanvas.width = tempVideo.videoWidth;
            tempCanvas.height = tempVideo.videoHeight;
            tempCtx.drawImage(tempVideo, 0, 0);

            try {
                const barcodes = await detector.detect(tempCanvas);
                if (barcodes.length > 0) {
                    const qrData = barcodes[0].rawValue;
                    if (qrData && qrData.length > 10) {
                        try {
                            const json = JSON.parse(LZString.decompressFromEncodedURIComponent(qrData));
                            if (Array.isArray(json) && json.length > 0) {
                                stopQRScan(mediaStream, tempVideo, overlay);
                                await saveAWBToDB(json);
                                buildAWBMap(json);
                                updateAWBStatus();
                                playBeep();
                                vibrate();
                                return;
                            }
                        } catch (e) {
                            // Not valid QR data, keep scanning
                        }
                    }
                }
            } catch (e) { /* ignore detection errors */ }

            requestAnimationFrame(scanLoop);
        }
        scanLoop();
    } catch (err) {
        alert('Unable to access camera for QR scanning: ' + err.message);
    }
}

function stopQRScan(mediaStream, videoEl, overlayEl) {
    mediaStream.getTracks().forEach(t => t.stop());
    videoEl.remove();
    overlayEl.remove();
}

// Barcode detection
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
    }
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

function showNoMatch(barcodeValue) {
    const matchEl = document.getElementById('matchResult');
    const headerEl = document.getElementById('matchHeader');
    const detailsEl = document.getElementById('matchDetails');

    headerEl.textContent = 'AWB NOT FOUND';
    headerEl.className = 'match-header match-not-found';
    detailsEl.innerHTML = `<div class="match-row"><span class="match-value">${barcodeValue} is not in the uploaded list</span></div>`;
    matchEl.style.display = 'block';
}

async function scanBarcode() {
    if (!scanning) return;
    context.drawImage(video, 0, 0, canvas.width, canvas.height);
    try {
        const barcodes = await barcodeDetector.detect(canvas);
        if (barcodes.length > 0) {
            const barcode = barcodes[0];
            const barcodeValue = barcode.rawValue;
            const copied = await copyToClipboard(barcodeValue);

            if (copied) {
                playBeep();
                vibrate();
                document.getElementById('resultText').textContent =
                    `Scanned: ${barcodeValue} (${barcode.format})`;

                if (Object.keys(awbMap).length > 0) {
                    const found = awbMap[barcodeValue.trim()];
                    if (found) {
                        showMatch(found);
                    } else {
                        showNoMatch(barcodeValue);
                    }
                } else {
                    document.getElementById('matchResult').style.display = 'none';
                }

                setTimeout(() => {
                    if (scanning) requestAnimationFrame(scanBarcode);
                }, 1500);
                return;
            }
        }
    } catch (err) {
        console.error('Error detecting barcode:', err);
    }
    requestAnimationFrame(scanBarcode);
}

async function startScanning() {
    if (scanning) return;
    const detectorReady = await initBarcodeDetector();
    if (!detectorReady) return;
    const cameraReady = await startCamera();
    if (!cameraReady) return;

    scanning = true;
    document.getElementById('startBtn').disabled = true;
    document.getElementById('stopBtn').disabled = false;
    document.getElementById('resultText').textContent = 'Scanning...';

    video.onloadedmetadata = () => {
        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;
        scanBarcode();
    };
}

function stopScanning() {
    scanning = false;
    stopCamera();
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

    // QR scan button (mobile)
    document.getElementById('scanQRBtn').addEventListener('click', () => {
        startQRScan();
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
