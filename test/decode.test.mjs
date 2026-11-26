import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { PNG } from 'pngjs';
import vm from 'node:vm';
import { readBarcodes, writeBarcode } from 'zxing-wasm';

const TARGET = 'FMPR1001860327';
const PARTIAL = 'FMPR10018603';
const ORDER_ID = 'OD338664795219939100';
const FALSE_EAN = '25511741';

const sandbox = { globalThis: {}, console };
vm.runInNewContext(readFileSync(new URL('../scanline.js', import.meta.url), 'utf8'), sandbox);
const dec = sandbox.globalThis.ScanlineDecoder;

function loadPng(path) {
    const png = PNG.sync.read(readFileSync(path));
    return { data: png.data, width: png.width, height: png.height };
}

function blurContrast(src, width, height, sigma, contrast) {
    const radius = Math.max(1, Math.ceil(sigma * 3));
    const kernel = [];
    let sum = 0;
    for (let i = -radius; i <= radius; i++) {
        const weight = Math.exp(-(i * i) / (2 * sigma * sigma));
        kernel.push(weight);
        sum += weight;
    }
    for (let i = 0; i < kernel.length; i++) kernel[i] /= sum;
    const gray = new Float32Array(width * height);
    for (let i = 0, p = 0; i < src.length; i += 4, p++) gray[p] = src[i];
    const tmp = new Float32Array(width * height);
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            let acc = 0;
            for (let i = -radius; i <= radius; i++) {
                const xx = Math.min(width - 1, Math.max(0, x + i));
                acc += gray[y * width + xx] * kernel[i + radius];
            }
            tmp[y * width + x] = acc;
        }
    }
    const out = new Uint8ClampedArray(src.length);
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            let acc = 0;
            for (let i = -radius; i <= radius; i++) {
                const yy = Math.min(height - 1, Math.max(0, y + i));
                acc += tmp[yy * width + x] * kernel[i + radius];
            }
            let value = Math.round(acc * contrast + (1 - contrast) * 140);
            if (value < 0) value = 0;
            if (value > 255) value = 255;
            const p = (y * width + x) * 4;
            out[p] = out[p + 1] = out[p + 2] = value;
            out[p + 3] = 255;
        }
    }
    return { data: out, width: width, height: height };
}

async function zxingTexts(image, options) {
    const results = await readBarcodes(
        { data: image.data, width: image.width, height: image.height },
        options
    );
    return (results || []).filter(result => result && result.text && !result.error).map(result => result.text);
}

// Same order as a still frame in script.js: one orientation at a time, then
// contrast and upscale, then the Code 128 scanline rescue if nothing was read.
async function sweep(image) {
    const found = new Map();
    const upright = dec.readerOptions(dec.ZXING_FORMATS);
    const hard = dec.readerOptions(dec.ZXING_HARD_FORMATS);
    const stages = [];
    async function take(stage, frame, options) {
        const texts = await zxingTexts(frame, options);
        stages.push(stage + (texts.length ? '=' + texts.join(',') : ''));
        texts.forEach(text => {
            if (!found.has(text)) found.set(text, stage);
        });
    }
    for (const quarter of dec.LIVE_QUARTERS) {
        const frame = quarter
            ? dec.rotateQuarter(image.data, image.width, image.height, quarter)
            : image;
        await take('rot' + quarter, frame, quarter ? hard : upright);
    }
    for (const quarter of [0, 1, 3]) {
        let prepared = dec.contrastStretch(image.data, image.width, image.height);
        const longSide = Math.max(prepared.width, prepared.height);
        if (longSide > 0 && longSide < 720) {
            prepared = dec.scaleImage(prepared.data, prepared.width, prepared.height, longSide < 360 ? 3 : 2);
        }
        if (quarter) prepared = dec.rotateQuarter(prepared.data, prepared.width, prepared.height, quarter);
        await take('prep' + quarter, prepared, hard);
    }
    let rescue = null;
    if (found.size === 0) {
        rescue = dec.readHardBarcode(image.data, image.width, image.height);
        if (rescue && rescue.text) found.set(rescue.text, 'rescue');
    }
    return { texts: Array.from(found.keys()), stages: found, rescue: rescue, log: stages };
}

async function code128(text) {
    const written = await writeBarcode(text, { format: 'Code128', scale: 3, withText: false });
    assert.equal(written.error || '', '');
    const bytes = Buffer.from(await written.image.arrayBuffer());
    const png = PNG.sync.read(bytes);
    return { data: png.data, width: png.width, height: png.height };
}

function assertExact(result, text) {
    assert.deepEqual(result.texts, [text], result.log.join(' | '));
    for (const wrong of [PARTIAL, ORDER_ID, FALSE_EAN]) {
        assert.equal(result.texts.includes(wrong), false);
    }
}

test('reader hints try harder, do not rotate internally, and drop short retail formats', () => {
    const upright = dec.readerOptions(dec.ZXING_FORMATS);
    const hard = dec.readerOptions(dec.ZXING_HARD_FORMATS);
    assert.equal(upright.tryHarder, true);
    assert.equal(upright.tryRotate, false);
    assert.equal(hard.tryHarder, true);
    assert.equal(hard.tryRotate, false);
    assert.equal(hard.formats.includes('EAN8'), false);
    assert.equal(hard.formats.includes('UPCE'), false);
    assert.equal(hard.formats.includes('Code128'), true);
    assert.equal(upright.formats.includes('EAN8'), true);
    assert.deepEqual(Array.from(dec.LIVE_QUARTERS), [0, 1, 3, 2]);
});

test('quarter-turn points map back onto the source', () => {
    const width = 30;
    const height = 50;
    const data = new Uint8ClampedArray(width * height * 4);
    for (const quarters of [1, 2, 3]) {
        const turned = dec.rotateQuarter(data, width, height, quarters);
        const x = 4;
        const y = 11;
        let px = x;
        let py = y;
        let w = width;
        let h = height;
        for (let turn = 0; turn < quarters; turn++) {
            const nx = h - 1 - py;
            const ny = px;
            px = nx;
            py = ny;
            const tmp = w;
            w = h;
            h = tmp;
        }
        const back = dec.unrotatePoint({ x: px, y: py }, turned.width, turned.height, quarters);
        assert.equal(back.x, x);
        assert.equal(back.y, y);
    }
});

test('attached Flipkart label decodes to FMPR1001860327', async () => {
    const photo = loadPng(new URL('./fixtures/flipkart-return.png', import.meta.url));
    const result = await sweep(photo);
    console.log('photo', result.texts.join(','), 'via', result.stages.get(TARGET), 'corr', result.rescue && result.rescue.corr);
    assertExact(result, TARGET);
    assert.equal(result.stages.get(TARGET), 'rescue');
});

test('clean Code 128 is read after an explicit quarter turn', async () => {
    const image = await code128(TARGET);
    const upright = await zxingTexts(image, dec.readerOptions(dec.ZXING_FORMATS));
    assert.deepEqual(upright, [TARGET]);

    for (const quarters of [1, 3]) {
        const turned = dec.rotateQuarter(image.data, image.width, image.height, quarters);
        const missed = await zxingTexts(turned, dec.readerOptions(dec.ZXING_HARD_FORMATS));
        assert.deepEqual(missed, [], 'tryRotate is off, so a sideways frame needs another pass');
        const result = await sweep(turned);
        console.log('rot' + quarters, result.texts.join(','), 'via', result.stages.get(TARGET));
        assertExact(result, TARGET);
        assert.match(result.stages.get(TARGET), /^rot/);
    }
});

test('rotated blurred low-contrast Code 128 decodes to FMPR1001860327', async () => {
    const image = await code128(TARGET);
    const degraded = blurContrast(image.data, image.width, image.height, 1.4, 0.45);
    const turned = dec.rotateQuarter(degraded.data, degraded.width, degraded.height, 1);
    const missed = await zxingTexts(turned, dec.readerOptions(dec.ZXING_HARD_FORMATS));
    assert.deepEqual(missed, []);
    const result = await sweep(turned);
    console.log('blurred', result.texts.join(','), 'via', result.stages.get(TARGET), 'corr', result.rescue && result.rescue.corr);
    assertExact(result, TARGET);
});

test('a different Code 128 is not reported as the Flipkart value', async () => {
    const image = await code128('AWB9988776655');
    const degraded = blurContrast(image.data, image.width, image.height, 1.2, 0.5);
    const turned = dec.rotateQuarter(degraded.data, degraded.width, degraded.height, 1);
    const result = await sweep(turned);
    console.log('other', result.texts.join(','));
    assert.deepEqual(result.texts, ['AWB9988776655']);
    assert.equal(result.texts.includes(TARGET), false);
});

function downscale(src, sw, sh, scale) {
    const dw = Math.max(1, Math.round(sw * scale));
    const dh = Math.max(1, Math.round(sh * scale));
    const out = new Uint8ClampedArray(dw * dh * 4);
    for (let y = 0; y < dh; y++) {
        const sy = Math.min(sh - 1, (y + 0.5) / scale - 0.5);
        const y0 = Math.max(0, Math.floor(sy));
        const y1 = Math.min(sh - 1, y0 + 1);
        const fy = Math.min(1, Math.max(0, sy - y0));
        for (let x = 0; x < dw; x++) {
            const sx = Math.min(sw - 1, (x + 0.5) / scale - 0.5);
            const x0 = Math.max(0, Math.floor(sx));
            const x1 = Math.min(sw - 1, x0 + 1);
            const fx = Math.min(1, Math.max(0, sx - x0));
            const d = (y * dw + x) * 4;
            for (let c = 0; c < 4; c++) {
                out[d + c] =
                    src[(y0 * sw + x0) * 4 + c] * (1 - fx) * (1 - fy) +
                    src[(y0 * sw + x1) * 4 + c] * fx * (1 - fy) +
                    src[(y1 * sw + x0) * 4 + c] * (1 - fx) * fy +
                    src[(y1 * sw + x1) * 4 + c] * fx * fy;
            }
        }
    }
    return { data: out, width: dw, height: dh };
}

function placeOnScreen(photo) {
    const width = 1920;
    const height = 1080;
    const data = new Uint8ClampedArray(width * height * 4);
    for (let i = 0; i < data.length; i += 4) {
        data[i] = data[i + 1] = data[i + 2] = 236;
        data[i + 3] = 255;
    }
    const ox = 160;
    const oy = 40;
    for (let y = 0; y < photo.height; y++) {
        for (let x = 0; x < photo.width; x++) {
            const s = (y * photo.width + x) * 4;
            const d = ((oy + y) * width + (ox + x)) * 4;
            data[d] = photo.data[s];
            data[d + 1] = photo.data[s + 1];
            data[d + 2] = photo.data[s + 2];
            data[d + 3] = 255;
        }
    }
    return { data, width, height, ox, oy, photo };
}

test('screen capture stays full resolution and a small region maps to capture pixels', () => {
    assert.equal(dec.screenScale(1920, 1080, false), 1);
    assert.equal(dec.screenScale(1920, 1080, true), 1);
    assert.equal(dec.screenScale(685, 310, true), 1);
    assert.equal(dec.screenScale(400, 180, true), 2);
    assert.equal(dec.screenScale(180, 120, true), 3);
    assert.ok(dec.screenScale(800, 600, false) >= 1);
    assert.ok(dec.screenScale(2560, 1440, true) >= 1);

    const full = dec.screenSourceRect(1920, 1080, null);
    assert.deepEqual([full.sx, full.sy, full.sw, full.sh, full.scale], [0, 0, 1920, 1080, 1]);

    // A box drawn on a CSS preview is stored as fractions. Those fractions
    // select the same capture pixels at 1x CSS size and at devicePixelRatio 2.
    const region = { x: 160 / 1920, y: 40 / 1080, w: 310 / 1920, h: 685 / 1080 };
    const crop = dec.screenSourceRect(1920, 1080, region);
    assert.ok(crop.scale >= 1);
    assert.ok(crop.sx <= 160 && crop.sy <= 40);
    assert.ok(crop.sx + crop.sw >= 160 + 310);
    assert.ok(crop.sy + crop.sh >= 40 + 685);
    assert.ok(crop.sw <= 1920 && crop.sh <= 1080);

    assert.equal(dec.shouldResetSweep(5, false, true, true), false);
    assert.equal(dec.shouldResetSweep(5, false, false, false), true);
    assert.equal(dec.shouldResetSweep(200, false, true, true), true);
    assert.equal(dec.shouldResetSweep(0, true, true, true), true);
});

test('a small sideways label on a 1920x1080 frame decodes at native size', () => {
    const photo = loadPng(new URL('./fixtures/flipkart-return.png', import.meta.url));
    const frame = placeOnScreen(photo);
    const hit = dec.readHardBarcode(frame.data, frame.width, frame.height);
    assert.equal(hit && hit.text, TARGET);

    const region = {
        x: frame.ox / frame.width,
        y: frame.oy / frame.height,
        w: photo.width / frame.width,
        h: photo.height / frame.height
    };
    const crop = dec.screenSourceRect(frame.width, frame.height, region);
    assert.equal(crop.scale, 1);
    const pixels = new Uint8ClampedArray(crop.sw * crop.sh * 4);
    for (let y = 0; y < crop.sh; y++) {
        for (let x = 0; x < crop.sw; x++) {
            const s = ((crop.sy + y) * frame.width + (crop.sx + x)) * 4;
            const d = (y * crop.sw + x) * 4;
            pixels[d] = frame.data[s];
            pixels[d + 1] = frame.data[s + 1];
            pixels[d + 2] = frame.data[s + 2];
            pixels[d + 3] = 255;
        }
    }
    const cropped = dec.readHardBarcode(pixels, crop.sw, crop.sh);
    assert.equal(cropped && cropped.text, TARGET);

    const shrunk = downscale(frame.data, frame.width, frame.height, 1200 / 1920);
    const missed = dec.readHardBarcode(shrunk.data, shrunk.width, shrunk.height);
    assert.equal(missed, null);
});

test('noise does not decode', () => {
    const width = 240;
    const height = 90;
    const data = new Uint8ClampedArray(width * height * 4);
    for (let i = 0; i < data.length; i += 4) {
        const value = (Math.imul(i, 1103515245) + 12345) & 255;
        data[i] = data[i + 1] = data[i + 2] = value;
        data[i + 3] = 255;
    }
    assert.equal(dec.readHardBarcode(data, width, height), null);
});
