// Drives the real Scan Screen loop with a fake getDisplayMedia stream:
// a 1920x1080 canvas, the Flipkart photo drawn small and sideways on it.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { dirname, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import puppeteer from 'puppeteer-core';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const TARGET = 'FMPR1001860327';
const TYPES = {
    '.html': 'text/html',
    '.js': 'text/javascript',
    '.css': 'text/css',
    '.png': 'image/png',
    '.json': 'application/json'
};

function startServer() {
    const server = createServer((req, res) => {
        const url = new URL(req.url, 'http://127.0.0.1');
        const rel = decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname);
        const file = join(ROOT, rel);
        if (!file.startsWith(ROOT)) {
            res.writeHead(403);
            res.end();
            return;
        }
        try {
            const body = readFileSync(file);
            res.writeHead(200, { 'content-type': TYPES[extname(file)] || 'application/octet-stream' });
            res.end(body);
        } catch (err) {
            res.writeHead(404);
            res.end();
        }
    });
    return new Promise(resolve => {
        server.listen(0, '127.0.0.1', () => resolve(server));
    });
}

async function scanScreen(page, mode) {
    await page.evaluate(async (which) => {
        const img = new Image();
        img.src = '/test/fixtures/flipkart-return.png';
        await img.decode();
        const board = document.createElement('canvas');
        board.width = 1920;
        board.height = 1080;
        const ctx = board.getContext('2d');
        ctx.fillStyle = '#ececec';
        ctx.fillRect(0, 0, board.width, board.height);
        const ox = 160;
        const oy = 40;
        ctx.drawImage(img, ox, oy);
        const stream = board.captureStream(8);
        navigator.mediaDevices.getDisplayMedia = async () => stream;
        window.__label = {
            x: ox / board.width,
            y: oy / board.height,
            w: img.naturalWidth / board.width,
            h: img.naturalHeight / board.height
        };
        document.getElementById(which === 'region' ? 'screenBtn' : 'screenBtn').click();
    }, mode);

    await page.waitForFunction(() => {
        const video = document.getElementById('video');
        return video && video.videoWidth === 1920 && video.videoHeight === 1080;
    }, { timeout: 15000 });

    if (mode === 'full') {
        await page.click('#fullFrameBtn');
    } else {
        await page.evaluate(() => {
            const video = document.getElementById('video');
            const rect = video.getBoundingClientRect();
            const vw = video.videoWidth;
            const vh = video.videoHeight;
            const elementRatio = rect.width / rect.height;
            const videoRatio = vw / vh;
            let left = rect.left;
            let top = rect.top;
            let width = rect.width;
            let height = rect.height;
            if (Math.abs(elementRatio - videoRatio) >= 0.02) {
                if (elementRatio > videoRatio) {
                    width = height * videoRatio;
                    left += (rect.width - width) / 2;
                } else {
                    height = width / videoRatio;
                    top += (rect.height - height) / 2;
                }
            }
            const label = window.__label;
            const x0 = left + label.x * width;
            const y0 = top + label.y * height;
            const x1 = left + (label.x + label.w) * width;
            const y1 = top + (label.y + label.h) * height;
            const layer = document.getElementById('regionLayer');
            const down = { bubbles: true, button: 0, pointerId: 1, clientX: x0, clientY: y0 };
            const move = { bubbles: true, button: 0, pointerId: 1, clientX: x1, clientY: y1 };
            layer.dispatchEvent(new PointerEvent('pointerdown', down));
            layer.dispatchEvent(new PointerEvent('pointermove', move));
            layer.dispatchEvent(new PointerEvent('pointerup', move));
        });
    }

    await page.waitForFunction(target => {
        const values = Array.from(document.querySelectorAll('.code-value')).map(node => node.textContent);
        return values.indexOf(target) !== -1;
    }, { timeout: 45000 }, TARGET);

    const values = await page.$$eval('.code-value', nodes => nodes.map(node => node.textContent));
    assert.deepEqual(values, [TARGET]);
    const size = await page.evaluate(() => {
        const video = document.getElementById('video');
        return { videoWidth: video.videoWidth, videoHeight: video.videoHeight };
    });
    assert.deepEqual(size, { videoWidth: 1920, videoHeight: 1080 });
}

test('Scan Screen reads a small sideways label from a fake display stream', async () => {
    const server = await startServer();
    const port = server.address().port;
    const browser = await puppeteer.launch({
        executablePath: '/usr/bin/google-chrome-stable',
        headless: true,
        args: [
            '--no-sandbox',
            '--disable-dev-shm-usage',
            '--autoplay-policy=no-user-gesture-required',
            '--use-fake-ui-for-media-stream'
        ]
    });
    try {
        for (const mode of ['full', 'region']) {
            const page = await browser.newPage();
            page.setDefaultTimeout(20000);
            await page.setViewport({ width: 1280, height: 800, deviceScaleFactor: 2 });
            page.on('pageerror', err => console.log('pageerror', mode, err.message));
            page.on('console', msg => {
                if (msg.type() === 'error') console.log('console', mode, msg.text());
            });
            await page.goto('http://127.0.0.1:' + port + '/', { waitUntil: 'domcontentloaded' });
            await scanScreen(page, mode);
            console.log('screen', mode, 'decoded', TARGET, 'at devicePixelRatio 2');
            await page.close();
        }
    } finally {
        await browser.close();
        await new Promise(resolve => server.close(resolve));
    }
});
