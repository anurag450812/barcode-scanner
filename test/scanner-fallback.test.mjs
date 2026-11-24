/**
 * Headless Chrome checks for the barcode scanner.
 *
 * 1. Deletes window.BarcodeDetector, feeds a Code128 y4m through
 *    --use-file-for-fake-video-capture, and asserts the ZXing fallback
 *    decodes it (AWB match, clipboard, beep, zoom, no support alert).
 * 2. Installs a BarcodeDetector stub and asserts the native path is used,
 *    keeps detecting past 6 reads, and re-inits after a detect error.
 * 3. If this Chrome build actually exposes BarcodeDetector (plain, or with
 *    the experimental web-platform flag), asserts the page constructs it
 *    and calls detect() instead of loading ZXing.
 *
 * Run from the repo root:
 *   node test/scanner-fallback.test.mjs
 *
 * puppeteer-core is loaded from /tmp/scanner-test if it is not installed
 * next to this repo. The script installs it there on first run.
 */

import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { mkdir, writeFile, mkdtemp } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import fs from 'node:fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '..');
const PAYLOAD = 'AWB123456789';
const EXPECTED_FORMATS = [
    'aztec', 'code_128', 'code_39', 'code_93', 'codabar',
    'data_matrix', 'ean_13', 'ean_8', 'itf', 'pdf417',
    'qr_code', 'upc_a', 'upc_e'
];
const CHROME = ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/local/bin/google-chrome']
    .find((p) => existsSync(p));

const passes = [];
const failures = [];

function ok(cond, message) {
    if (cond) {
        passes.push(message);
        console.log('  PASS', message);
    } else {
        failures.push(message);
        console.error('  FAIL', message);
    }
}

function run(cmd, args, opts = {}) {
    return new Promise((resolve, reject) => {
        const child = spawn(cmd, args, { stdio: 'inherit', ...opts });
        child.on('error', reject);
        child.on('exit', (code) => {
            if (code === 0) resolve();
            else reject(new Error(`${cmd} ${args.join(' ')} exited ${code}`));
        });
    });
}

async function loadPuppeteer() {
    const candidates = [
        path.join(REPO, 'node_modules', 'puppeteer-core'),
        '/tmp/scanner-test'
    ];
    for (const dir of candidates) {
        const pkg = path.join(dir, 'package.json');
        const nested = path.join(dir, 'node_modules', 'puppeteer-core', 'package.json');
        const base = existsSync(pkg) && dir.endsWith('puppeteer-core') ? dir : (existsSync(nested) ? path.join(dir, 'node_modules', 'puppeteer-core') : null);
        if (!base) continue;
        try {
            const require = createRequire(path.join(base, 'package.json'));
            return require('puppeteer-core');
        } catch (err) {
            /* try the next location */
        }
    }
    await mkdir('/tmp/scanner-test', { recursive: true });
    if (!existsSync('/tmp/scanner-test/package.json')) {
        await writeFile('/tmp/scanner-test/package.json', '{"name":"scanner-test","private":true}\n');
    }
    await run('npm', ['install', '--silent', 'puppeteer-core@24'], { cwd: '/tmp/scanner-test', stdio: 'inherit' });
    const require = createRequire('/tmp/scanner-test/node_modules/puppeteer-core/package.json');
    return require('puppeteer-core');
}

async function renderBarcodeVideo(y4mPath) {
    const dir = await mkdtemp(path.join(tmpdir(), 'barcode-src-'));
    const py = path.join(dir, 'render.py');
    await writeFile(py, `
from barcode import Code128
from barcode.writer import ImageWriter
from PIL import Image
payload = ${JSON.stringify(PAYLOAD)}
writer = ImageWriter()
options = {
    "module_width": 0.5,
    "module_height": 18.0,
    "quiet_zone": 8.0,
    "font_size": 0,
    "text_distance": 1.0,
    "write_text": False,
    "dpi": 300,
    "background": "white",
    "foreground": "black",
}
code = Code128(payload, writer=writer)
png = code.save(${JSON.stringify(path.join(dir, 'code128'))}, options=options)
im = Image.open(png).convert("RGB")
target_w = 1000
target_h = max(1, int(im.height * (target_w / im.width)))
if target_h > 500:
    target_h = 500
    target_w = max(1, int(im.width * (500 / im.height)))
resized = im.resize((target_w, target_h), Image.Resampling.NEAREST)
frame = Image.new("RGB", (1280, 720), "white")
frame.paste(resized, ((1280 - resized.width) // 2, (720 - resized.height) // 2))
frame.save(${JSON.stringify(path.join(dir, 'frame.png'))})
print("rendered", resized.size)
`);
    await run('python3', [py]);
    await run('ffmpeg', [
        '-y', '-loop', '1', '-i', path.join(dir, 'frame.png'),
        '-hide_banner', '-loglevel', 'error',
        '-t', '4', '-r', '10',
        '-pix_fmt', 'yuv420p',
        '-vf', 'scale=1280:720:flags=neighbor',
        y4mPath
    ]);
}

function startServer(root) {
    return new Promise((resolve) => {
        const server = http.createServer((req, res) => {
            const url = new URL(req.url, 'http://127.0.0.1');
            let rel = decodeURIComponent(url.pathname);
            if (rel === '/') rel = '/index.html';
            const filePath = path.normalize(path.join(root, rel));
            if (!filePath.startsWith(root)) {
                res.writeHead(403);
                res.end('no');
                return;
            }
            fs.readFile(filePath, (err, data) => {
                if (err) {
                    res.writeHead(404);
                    res.end('not found');
                    return;
                }
                const ext = path.extname(filePath);
                const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };
                res.writeHead(200, { 'Content-Type': types[ext] || 'application/octet-stream' });
                res.end(data);
            });
        });
        server.listen(0, '127.0.0.1', () => {
            const { port } = server.address();
            resolve({ server, port });
        });
    });
}

async function loadAwbList(page) {
    await page.waitForFunction(() => window.XLSX && document.getElementById('fileInput'));
    await page.evaluate((payload) => {
        const wb = XLSX.utils.book_new();
        const ws = XLSX.utils.json_to_sheet([
            { 'AWB Number': payload, Customer: 'Test Consignee', City: 'Delhi' }
        ]);
        XLSX.utils.book_append_sheet(wb, ws, 'Sheet1');
        const b64 = XLSX.write(wb, { bookType: 'xlsx', type: 'base64' });
        const bin = atob(b64);
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        const file = new File([bytes], 'awb.xlsx', {
            type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
        });
        const input = document.getElementById('fileInput');
        const dt = new DataTransfer();
        dt.items.add(file);
        input.files = dt.files;
        input.dispatchEvent(new Event('change', { bubbles: true }));
    }, PAYLOAD);
    await page.waitForFunction(() => document.getElementById('awbCount').textContent === '1');
}

async function dumpPage(page, label) {
    const dir = '/tmp/barcode-test';
    await mkdir(dir, { recursive: true });
    try {
        await page.screenshot({ path: path.join(dir, `${label}.png`) });
    } catch (err) {
        console.error('screenshot failed', err.message);
    }
    try {
        const info = await page.evaluate(() => {
            const video = document.getElementById('video');
            const canvas = document.getElementById('canvas');
            let sample = null;
            let frame = '';
            if (canvas && canvas.width && canvas.height) {
                const ctx = canvas.getContext('2d');
                const px = ctx.getImageData(Math.floor(canvas.width / 2), Math.floor(canvas.height / 2), 1, 1).data;
                sample = Array.from(px);
                frame = canvas.toDataURL('image/jpeg', 0.6);
            }
            return {
                result: document.getElementById('resultText') && document.getElementById('resultText').textContent,
                match: document.getElementById('matchHeader') && document.getElementById('matchHeader').textContent,
                video: video ? [video.videoWidth, video.videoHeight, video.readyState] : null,
                canvas: canvas ? [canvas.width, canvas.height] : null,
                sample,
                gum: window.__gum || null,
                scripts: Array.from(document.scripts).map((s) => s.src).filter(Boolean),
                frame
            };
        });
        if (info.frame && info.frame.startsWith('data:')) {
            const b64 = info.frame.split(',')[1];
            await writeFile(path.join(dir, `${label}-frame.jpg`), Buffer.from(b64, 'base64'));
        }
        delete info.frame;
        console.log('  dump', label, JSON.stringify(info));
    } catch (err) {
        console.error('dump failed', err.message);
    }
}

function trackDialogs(page) {
    const dialogs = [];
    page.on('dialog', async (dialog) => {
        dialogs.push(dialog.message());
        await dialog.dismiss();
    });
    return dialogs;
}

function trackConsole(page) {
    const lines = [];
    page.on('console', (msg) => {
        const line = `[${msg.type()}] ${msg.text()}`;
        lines.push(line);
        if (msg.type() === 'error') console.log('  console', line);
    });
    page.on('pageerror', (err) => {
        lines.push(`[pageerror] ${err.message}`);
        console.log('  pageerror', err.message);
    });
    return lines;
}

async function launchChrome(puppeteer, y4mPath, extraArgs = []) {
    return puppeteer.launch({
        executablePath: CHROME,
        headless: true,
        args: [
            '--no-sandbox',
            '--disable-dev-shm-usage',
            '--use-fake-ui-for-media-stream',
            '--use-fake-device-for-media-stream',
            `--use-file-for-fake-video-capture=${y4mPath}`,
            '--autoplay-policy=no-user-gesture-required',
            '--disable-background-timer-throttling',
            '--disable-backgrounding-occluded-windows',
            '--disable-renderer-backgrounding',
            '--disable-gpu',
            ...extraArgs
        ]
    });
}

async function openApp(browser, origin) {
    const context = browser.defaultBrowserContext();
    await context.overridePermissions(origin, ['camera', 'clipboard-read', 'clipboard-write']);
    const page = await browser.newPage();
    await page.setViewport({ width: 900, height: 900 });
    return page;
}

async function testFallbackDecode(puppeteer, origin, y4mPath) {
    console.log('\n== fallback decode (BarcodeDetector deleted, fake Code128 camera) ==');
    const browser = await launchChrome(puppeteer, y4mPath);
    try {
        const page = await openApp(browser, origin);
        const dialogs = trackDialogs(page);
        const logs = trackConsole(page);
        await page.evaluateOnNewDocument(() => {
            delete window.BarcodeDetector;
            try { delete Window.prototype.BarcodeDetector; } catch (e) { /* already absent */ }
            window.__bdPresent = 'BarcodeDetector' in window;
            window.__gum = [];
            window.__copied = [];
            window.__osc = 0;
            const media = navigator.mediaDevices;
            const orig = media.getUserMedia.bind(media);
            media.getUserMedia = async function (constraints) {
                let recorded = null;
                try { recorded = JSON.parse(JSON.stringify(constraints)); } catch (e) { recorded = String(constraints); }
                window.__gum.push(recorded);
                const facing = constraints && constraints.video && constraints.video.facingMode;
                if (facing) {
                    throw new DOMException('No rear camera', 'OverconstrainedError');
                }
                return orig(constraints);
            };
            const clip = navigator.clipboard;
            if (clip) {
                clip.writeText = async (text) => { window.__copied.push(String(text)); };
            }
            const AC = window.AudioContext || window.webkitAudioContext;
            if (AC) {
                const origOsc = AC.prototype.createOscillator;
                AC.prototype.createOscillator = function () {
                    window.__osc += 1;
                    return origOsc.apply(this, arguments);
                };
            }
        });
        await page.goto(`${origin}/index.html`, { waitUntil: 'networkidle0', timeout: 30000 });
        const bdPresent = await page.evaluate(() => window.__bdPresent);
        ok(bdPresent === false, 'BarcodeDetector is not on window');
        await loadAwbList(page);
        await page.click('#startBtn');
        try {
            await page.waitForFunction((payload) => {
                const text = document.getElementById('resultText').textContent || '';
                return text.includes(payload);
            }, { timeout: 20000 }, PAYLOAD);
        } catch (err) {
            await dumpPage(page, 'fallback-fail');
            ok(false, `fallback decoded ${PAYLOAD} (${err.message})`);
            console.log('  recent console:\n   ', logs.slice(-12).join('\n    '));
            return;
        }
        const state = await page.evaluate(() => ({
            result: document.getElementById('resultText').textContent,
            match: document.getElementById('matchHeader').textContent,
            details: document.getElementById('matchDetails').textContent,
            copied: window.__copied,
            osc: window.__osc,
            gum: window.__gum,
            scripts: Array.from(document.scripts).map((s) => s.src),
            zoomActive: document.getElementById('zoomControls').classList.contains('active'),
            startDisabled: document.getElementById('startBtn').disabled,
            stopDisabled: document.getElementById('stopBtn').disabled
        }));
        ok(state.result === `Scanned: ${PAYLOAD} (code_128)`, `result text is "${state.result}"`);
        ok(state.match === 'AWB FOUND', 'AWB match header shown');
        ok(state.details.includes('Test Consignee') && state.details.includes('Delhi'), 'AWB row details rendered');
        ok(Array.isArray(state.copied) && state.copied.includes(PAYLOAD), `clipboard received ${PAYLOAD}`);
        ok(state.osc >= 1, `beep/siren oscillators started (${state.osc})`);
        ok(state.scripts.some((src) => src.includes('@zxing/library@0.21.3')), 'ZXing loaded from the pinned CDN');
        ok(!state.scripts.some((src) => src.includes('unpkg.com/@zxing/library')), 'primary CDN succeeded (unpkg backup unused)');
        ok(state.zoomActive && state.startDisabled && !state.stopDisabled, 'scanner controls are in the running state');
        ok(dialogs.length === 0, `no alert while scanning (got ${JSON.stringify(dialogs)})`);
        ok(dialogs.every((d) => !/not supported/i.test(d)), 'unsupported-API alert was not shown');

        const gum = state.gum || [];
        ok(gum.length >= 2, `camera opened via fallback constraints (${gum.length} getUserMedia calls)`);
        const firstFacing = gum[0] && gum[0].video && gum[0].video.facingMode;
        ok(firstFacing && firstFacing.ideal === 'environment' && !firstFacing.exact,
            `first constraint prefers rear camera without requiring it (${JSON.stringify(firstFacing)})`);
        ok(gum[1] && gum[1].video === true, 'second constraint accepts any camera');

        await page.$eval('#zoomInBtn', (el) => el.click());
        const zoom = await page.evaluate(() => ({
            label: document.getElementById('zoomValue').textContent,
            transform: document.getElementById('video').style.transform
        }));
        ok(zoom.label === '2.0x' && zoom.transform === 'scale(2)', `digital zoom applied (${zoom.label}, ${zoom.transform})`);

        await page.$eval('#stopBtn', (el) => el.click());
        const stopped = await page.evaluate(() => ({
            result: document.getElementById('resultText').textContent,
            startDisabled: document.getElementById('startBtn').disabled,
            zoomActive: document.getElementById('zoomControls').classList.contains('active')
        }));
        ok(stopped.result === 'Scanner stopped' && !stopped.startDisabled && !stopped.zoomActive, 'stop ends the session');
    } finally {
        await browser.close();
    }
}

async function testNativeStub(puppeteer, origin, y4mPath) {
    console.log('\n== native path (BarcodeDetector stub) ==');
    const browser = await launchChrome(puppeteer, y4mPath);
    try {
        const page = await openApp(browser, origin);
        const dialogs = trackDialogs(page);
        trackConsole(page);
        await page.evaluateOnNewDocument((formats) => {
            window.__constructed = 0;
            window.__detectCalls = 0;
            window.__formats = null;
            window.__copied = [];
            window.__osc = 0;
            window.BarcodeDetector = class {
                constructor(opts) {
                    window.__constructed += 1;
                    window.__formats = opts && opts.formats ? opts.formats.slice() : null;
                }
                detect() {
                    window.__detectCalls += 1;
                    if (window.__detectCalls === 1) {
                        return Promise.reject(new Error('detector glitch'));
                    }
                    return Promise.resolve([{ rawValue: 'AWB123456789', format: 'code_128' }]);
                }
            };
            window.__expectedFormats = formats;
            const clip = navigator.clipboard;
            if (clip) clip.writeText = async (text) => { window.__copied.push(String(text)); };
            const AC = window.AudioContext || window.webkitAudioContext;
            if (AC) {
                const origOsc = AC.prototype.createOscillator;
                AC.prototype.createOscillator = function () {
                    window.__osc += 1;
                    return origOsc.apply(this, arguments);
                };
            }
        }, EXPECTED_FORMATS);
        await page.goto(`${origin}/index.html`, { waitUntil: 'networkidle0', timeout: 30000 });
        await loadAwbList(page);
        await page.click('#startBtn');
        try {
            await page.waitForFunction(() => (window.__detectCalls || 0) >= 8, { timeout: 10000 });
        } catch (err) {
            await dumpPage(page, 'native-fail');
            const partial = await page.evaluate(() => ({
                calls: window.__detectCalls,
                constructed: window.__constructed,
                result: document.getElementById('resultText').textContent
            }));
            ok(false, `native detect kept running (calls=${partial.calls}, constructed=${partial.constructed}, result=${partial.result})`);
            return;
        }
        const state = await page.evaluate(() => ({
            result: document.getElementById('resultText').textContent,
            match: document.getElementById('matchHeader').textContent,
            details: document.getElementById('matchDetails').textContent,
            copied: window.__copied,
            osc: window.__osc,
            constructed: window.__constructed,
            calls: window.__detectCalls,
            formats: window.__formats,
            scripts: Array.from(document.scripts).map((s) => s.src)
        }));
        ok(state.result === `Scanned: ${PAYLOAD} (code_128)`, `native result text is "${state.result}"`);
        ok(state.match === 'AWB FOUND' && state.details.includes('Test Consignee'), 'native scan still matches the AWB list');
        ok(state.copied.includes(PAYLOAD), 'native scan copies to the clipboard');
        ok(state.osc >= 1, `native scan plays a beep (${state.osc})`);
        ok(state.constructed >= 2, `detector was recreated after a detect error (${state.constructed} constructions)`);
        const earlyCalls = state.calls;
        await new Promise((r) => setTimeout(r, 500));
        const laterCalls = await page.evaluate(() => window.__detectCalls);
        ok(laterCalls > earlyCalls, `scan loop kept running after the first reads (${earlyCalls} -> ${laterCalls})`);
        ok(state.calls >= 8, `scan loop continued past 6 reads (${state.calls} detect calls)`);
        ok(JSON.stringify(state.formats) === JSON.stringify(EXPECTED_FORMATS), 'native formats list is unchanged');
        ok(!state.scripts.some((src) => src.includes('zxing')), 'ZXing was not loaded while BarcodeDetector works');
        ok(dialogs.length === 0, `no alert on the native path (got ${JSON.stringify(dialogs)})`);

        await page.$eval('#stopBtn', (el) => el.click());
        await new Promise((r) => setTimeout(r, 250));
        const mid = await page.evaluate(() => window.__detectCalls);
        await new Promise((r) => setTimeout(r, 400));
        const after = await page.evaluate(() => ({
            result: document.getElementById('resultText').textContent,
            calls: window.__detectCalls,
            startDisabled: document.getElementById('startBtn').disabled
        }));
        ok(after.result === 'Scanner stopped' && !after.startDisabled, 'native stop resets the controls');
        ok(after.calls === mid, `detect loop stopped (${mid} -> ${after.calls})`);
    } finally {
        await browser.close();
    }
}

async function testCameraFailure(puppeteer, origin, y4mPath) {
    console.log('\n== camera failure is the only alert ==');
    const browser = await launchChrome(puppeteer, y4mPath);
    try {
        const page = await openApp(browser, origin);
        const dialogs = trackDialogs(page);
        trackConsole(page);
        await page.evaluateOnNewDocument(() => {
            delete window.BarcodeDetector;
            const media = navigator.mediaDevices;
            media.getUserMedia = async () => {
                throw new DOMException('Permission denied', 'NotAllowedError');
            };
        });
        await page.goto(`${origin}/index.html`, { waitUntil: 'networkidle0', timeout: 30000 });
        await page.click('#startBtn');
        await page.waitForFunction(() => !document.getElementById('startBtn').disabled, { timeout: 20000 });
        // The decoder CDN load finishes before the camera alert. Give the dialog a moment.
        await new Promise((r) => setTimeout(r, 300));
        const result = await page.evaluate(() => document.getElementById('resultText').textContent);
        ok(dialogs.length === 1 && dialogs[0] === 'Unable to access camera. Please grant camera permissions.',
            `camera alert only (got ${JSON.stringify(dialogs)})`);
        ok(!/not supported/i.test(dialogs.join(' ')), 'missing BarcodeDetector does not raise the old alert');
        ok(result !== 'Scanning...' && !result.startsWith('Scanned:'), `scanner did not start (${result})`);
    } finally {
        await browser.close();
    }
}

async function testRealNative(puppeteer, origin, y4mPath, extraArgs, label) {
    console.log(`\n== real BarcodeDetector availability (${label}) ==`);
    const browser = await launchChrome(puppeteer, y4mPath, extraArgs);
    try {
        const probe = await browser.newPage();
        await probe.goto('about:blank');
        const available = await probe.evaluate(() => typeof window.BarcodeDetector === 'function');
        await probe.close();
        if (!available) {
            console.log(`  SKIP real BarcodeDetector is not present (${label})`);
            return { available: false };
        }
        const page = await openApp(browser, origin);
        trackDialogs(page);
        trackConsole(page);
        await page.evaluateOnNewDocument(() => {
            const Real = window.BarcodeDetector;
            window.__constructAttempts = 0;
            window.__constructed = 0;
            window.__detectCalls = 0;
            window.__detectError = null;
            window.__nativeHit = null;
            const Wrapped = class extends Real {
                constructor(opts) {
                    window.__constructAttempts += 1;
                    super(opts);
                    window.__constructed += 1;
                    window.__formats = opts && opts.formats ? opts.formats.slice() : null;
                }
                detect(source) {
                    window.__detectCalls += 1;
                    return super.detect(source).then((codes) => {
                        if (codes && codes.length && !window.__nativeHit) {
                            window.__nativeHit = codes[0].rawValue + ' (' + codes[0].format + ')';
                        }
                        return codes;
                    }).catch((err) => {
                        window.__detectError = String(err && err.message || err);
                        throw err;
                    });
                }
            };
            window.BarcodeDetector = Wrapped;
        });
        await page.goto(`${origin}/index.html`, { waitUntil: 'networkidle0', timeout: 30000 });
        await page.click('#startBtn');
        await page.waitForFunction(() => (window.__constructAttempts || 0) >= 1 || (window.__detectCalls || 0) >= 1, { timeout: 15000 }).catch(() => {});
        await new Promise((r) => setTimeout(r, 1500));
        const state = await page.evaluate(() => ({
            attempts: window.__constructAttempts || 0,
            constructed: window.__constructed || 0,
            calls: window.__detectCalls || 0,
            hit: window.__nativeHit,
            error: window.__detectError,
            result: document.getElementById('resultText').textContent,
            scripts: Array.from(document.scripts).map((s) => s.src)
        }));
        console.log('  real detector state', JSON.stringify(state));
        if (state.constructed >= 1) {
            ok(state.calls >= 1, `real BarcodeDetector.detect ran (${state.calls} calls, hit=${state.hit || 'none'})`);
            ok(!state.scripts.some((src) => src.includes('zxing')), 'page kept the native detector and did not load ZXing');
        } else {
            ok(state.attempts >= 1, 'page attempted to construct the real BarcodeDetector');
            ok(state.scripts.some((src) => src.includes('@zxing/library')), 'constructor failure fell through to ZXing');
        }
        return { available: true, state };
    } finally {
        await browser.close();
    }
}

async function main() {
    if (!CHROME) throw new Error('Google Chrome was not found');
    const script = fs.readFileSync(path.join(REPO, 'script.js'), 'utf8');
    ok(!script.includes('Barcode Detection API is not supported'), 'source no longer contains the unsupported-API alert');

    const y4mPath = '/tmp/barcode-test/code128.y4m';
    await mkdir('/tmp/barcode-test', { recursive: true });
    console.log('Rendering Code128', PAYLOAD, '->', y4mPath);
    await renderBarcodeVideo(y4mPath);

    const puppeteer = await loadPuppeteer();
    const { server, port } = await startServer(REPO);
    const origin = `http://127.0.0.1:${port}`;
    console.log('Serving', REPO, 'on', origin);
    try {
        await testFallbackDecode(puppeteer, origin, y4mPath);
        await testNativeStub(puppeteer, origin, y4mPath);
        await testCameraFailure(puppeteer, origin, y4mPath);
        await testRealNative(puppeteer, origin, y4mPath, [], 'default chrome');
        await testRealNative(puppeteer, origin, y4mPath, [
            '--enable-experimental-web-platform-features',
            '--enable-blink-features=BarcodeDetector,ShapeDetection'
        ], 'experimental web platform features');
    } finally {
        await new Promise((resolve) => server.close(resolve));
    }

    console.log(`\n${passes.length} passed, ${failures.length} failed`);
    if (failures.length) {
        console.error(failures.map((f) => '- ' + f).join('\n'));
        process.exit(1);
    }
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
