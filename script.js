let video;
let canvas;
let context;
let scanning = false;
let barcodeDetector;
let stream;

// Audio context for beep sound
const audioContext = new (window.AudioContext || window.webkitAudioContext)();

// Play a beep sound
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

// Vibrate the device
function vibrate() {
    if ('vibrate' in navigator) {
        navigator.vibrate(200);
    }
}

// Copy text to clipboard
async function copyToClipboard(text) {
    try {
        await navigator.clipboard.writeText(text);
        return true;
    } catch (err) {
        console.error('Failed to copy:', err);
        return false;
    }
}

// Initialize the barcode detector
async function initBarcodeDetector() {
    if (!('BarcodeDetector' in window)) {
        alert('Barcode Detection API is not supported in this browser. Please use Chrome on Android or a compatible browser.');
        return false;
    }
    
    try {
        barcodeDetector = new BarcodeDetector({
            formats: [
                'aztec',
                'code_128',
                'code_39',
                'code_93',
                'codabar',
                'data_matrix',
                'ean_13',
                'ean_8',
                'itf',
                'pdf417',
                'qr_code',
                'upc_a',
                'upc_e'
            ]
        });
        return true;
    } catch (err) {
        console.error('Error creating BarcodeDetector:', err);
        return false;
    }
}

// Start the camera
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

// Stop the camera
function stopCamera() {
    if (stream) {
        stream.getTracks().forEach(track => track.stop());
        stream = null;
    }
}

// Scan for barcodes
async function scanBarcode() {
    if (!scanning) return;
    
    // Draw video frame to canvas
    context.drawImage(video, 0, 0, canvas.width, canvas.height);
    
    try {
        const barcodes = await barcodeDetector.detect(canvas);
        
        if (barcodes.length > 0) {
            const barcode = barcodes[0];
            const barcodeValue = barcode.rawValue;
            
            // Copy to clipboard
            const copied = await copyToClipboard(barcodeValue);
            
            if (copied) {
                // Play sound and vibrate
                playBeep();
                vibrate();
                
                // Update result
                document.getElementById('resultText').textContent = 
                    `Copied: ${barcodeValue} (${barcode.format})`;
                
                // Continue scanning after a brief pause
                setTimeout(() => {
                    if (scanning) {
                        requestAnimationFrame(scanBarcode);
                    }
                }, 1000);
                return;
            }
        }
    } catch (err) {
        console.error('Error detecting barcode:', err);
    }
    
    // Continue scanning
    requestAnimationFrame(scanBarcode);
}

// Start scanning
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
    
    // Wait for video to be ready
    video.onloadedmetadata = () => {
        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;
        scanBarcode();
    };
}

// Stop scanning
function stopScanning() {
    scanning = false;
    stopCamera();
    document.getElementById('startBtn').disabled = false;
    document.getElementById('stopBtn').disabled = true;
    document.getElementById('resultText').textContent = 'Scanner stopped';
}

// Initialize on page load
window.addEventListener('DOMContentLoaded', () => {
    video = document.getElementById('video');
    canvas = document.getElementById('canvas');
    context = canvas.getContext('2d');
    
    document.getElementById('startBtn').addEventListener('click', startScanning);
    document.getElementById('stopBtn').addEventListener('click', stopScanning);
});
