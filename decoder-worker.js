// Decodes barcodes off the UI thread. The page paints and rotates the crop;
// this worker only runs zxing-wasm. Loaded for the desktop fallback. Android
// keeps the native detector and never starts this file.
let readerReady = false;

self.onmessage = async (event) => {
    const data = event.data || {};
    try {
        if (!readerReady) {
            self.window = self;
            importScripts('https://cdn.jsdelivr.net/npm/zxing-wasm@3.1.7/dist/iife/reader/index.js');
            if (!self.ZXingWASM || typeof self.ZXingWASM.readBarcodes !== 'function') {
                throw new Error('Barcode decoder did not start');
            }
            await self.ZXingWASM.readBarcodes(new ImageData(8, 8), {
                formats: ['QRCode'],
                tryHarder: false,
                tryRotate: false,
                tryInvert: false,
                tryDownscale: false,
                maxNumberOfSymbols: 1
            });
            readerReady = true;
        }
        if (data.type === 'warmup') {
            self.postMessage({ id: data.id, ok: true, codes: [], ms: 0 });
            return;
        }
        const pixels = new Uint8ClampedArray(data.buffer);
        const image = new ImageData(pixels, data.width, data.height);
        const started = performance.now();
        const results = await self.ZXingWASM.readBarcodes(image, data.options || {});
        const codes = [];
        (results || []).forEach(result => {
            if (!result || !result.text || result.error) return;
            const position = result.position || null;
            codes.push({
                text: result.text,
                format: result.format || result.symbology || '',
                points: position ? [
                    position.topLeft,
                    position.topRight,
                    position.bottomRight,
                    position.bottomLeft
                ] : null
            });
        });
        self.postMessage({
            id: data.id,
            ok: true,
            ms: performance.now() - started,
            codes: codes
        });
    } catch (err) {
        self.postMessage({
            id: data.id,
            ok: false,
            error: String(err && err.message ? err.message : err)
        });
    }
};
