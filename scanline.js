// Reads a blurry or sideways Code 128 from a still frame when the normal
// decoder does not. The scanline is the median of the sharpest stripe band,
// checked in both directions. A read is kept only when the symbol checksum
// pattern and the stop pattern sit where the data symbols say they should.
(function (root) {
    const PATTERNS = [
        [2, 1, 2, 2, 2, 3], [2, 2, 2, 1, 2, 3], [2, 2, 2, 2, 2, 2], [1, 2, 1, 2, 2, 3], [1, 2, 1, 3, 2, 2],
        [1, 3, 1, 2, 2, 2], [1, 2, 2, 2, 1, 3], [1, 2, 2, 3, 1, 2], [1, 3, 2, 2, 1, 2], [2, 2, 1, 2, 1, 3],
        [2, 2, 1, 3, 1, 2], [2, 3, 1, 2, 1, 2], [1, 1, 2, 2, 3, 2], [1, 2, 2, 1, 3, 2], [1, 2, 2, 2, 3, 1],
        [1, 1, 3, 2, 2, 2], [1, 2, 3, 1, 2, 2], [1, 2, 3, 2, 2, 1], [2, 2, 3, 2, 1, 1], [2, 2, 1, 1, 3, 2],
        [2, 2, 1, 2, 3, 1], [2, 1, 3, 2, 1, 2], [2, 2, 3, 1, 1, 2], [3, 1, 2, 1, 3, 1], [3, 1, 1, 2, 2, 2],
        [3, 2, 1, 1, 2, 2], [3, 2, 1, 2, 2, 1], [3, 1, 2, 2, 1, 2], [3, 2, 2, 1, 1, 2], [3, 2, 2, 2, 1, 1],
        [2, 1, 2, 1, 2, 3], [2, 1, 2, 3, 2, 1], [2, 3, 2, 1, 2, 1], [1, 1, 1, 3, 2, 3], [1, 3, 1, 1, 2, 3],
        [1, 3, 1, 3, 2, 1], [1, 1, 2, 3, 1, 3], [1, 3, 2, 1, 1, 3], [1, 3, 2, 3, 1, 1], [2, 1, 1, 3, 1, 3],
        [2, 3, 1, 1, 1, 3], [2, 3, 1, 3, 1, 1], [1, 1, 2, 1, 3, 3], [1, 1, 2, 3, 3, 1], [1, 3, 2, 1, 3, 1],
        [1, 1, 3, 1, 2, 3], [1, 1, 3, 3, 2, 1], [1, 3, 3, 1, 2, 1], [3, 1, 3, 1, 2, 1], [2, 1, 1, 3, 3, 1],
        [2, 3, 1, 1, 3, 1], [2, 1, 3, 1, 1, 3], [2, 1, 3, 3, 1, 1], [2, 1, 3, 1, 3, 1], [3, 1, 1, 1, 2, 3],
        [3, 1, 1, 3, 2, 1], [3, 3, 1, 1, 2, 1], [3, 1, 2, 1, 1, 3], [3, 1, 2, 3, 1, 1], [3, 3, 2, 1, 1, 1],
        [3, 1, 4, 1, 1, 1], [2, 2, 1, 4, 1, 1], [4, 3, 1, 1, 1, 1], [1, 1, 1, 2, 2, 4], [1, 1, 1, 4, 2, 2],
        [1, 2, 1, 1, 2, 4], [1, 2, 1, 4, 2, 1], [1, 4, 1, 1, 2, 2], [1, 4, 1, 2, 2, 1], [1, 1, 2, 2, 1, 4],
        [1, 1, 2, 4, 1, 2], [1, 2, 2, 1, 1, 4], [1, 2, 2, 4, 1, 1], [1, 4, 2, 1, 1, 2], [1, 4, 2, 2, 1, 1],
        [2, 4, 1, 2, 1, 1], [2, 2, 1, 1, 1, 4], [4, 1, 3, 1, 1, 1], [2, 4, 1, 1, 1, 2], [1, 3, 4, 1, 1, 1],
        [1, 1, 1, 2, 4, 2], [1, 2, 1, 1, 4, 2], [1, 2, 1, 2, 4, 1], [1, 1, 4, 2, 1, 2], [1, 2, 4, 1, 1, 2],
        [1, 2, 4, 2, 1, 1], [4, 1, 1, 2, 1, 2], [4, 2, 1, 1, 1, 2], [4, 2, 1, 2, 1, 1], [2, 1, 2, 1, 4, 1],
        [2, 1, 4, 1, 2, 1], [4, 1, 2, 1, 2, 1], [1, 1, 1, 1, 4, 3], [1, 1, 1, 3, 4, 1], [1, 3, 1, 1, 4, 1],
        [1, 1, 4, 1, 1, 3], [1, 1, 4, 3, 1, 1], [4, 1, 1, 1, 1, 3], [4, 1, 1, 3, 1, 1], [1, 1, 3, 1, 4, 1],
        [1, 1, 4, 1, 3, 1], [3, 1, 1, 1, 4, 1], [4, 1, 1, 1, 3, 1], [2, 1, 1, 4, 1, 2], [2, 1, 1, 2, 1, 4],
        [2, 1, 1, 2, 3, 2]
    ];
    const STOP = [2, 3, 3, 1, 1, 1, 2];
    const STARTS = { 103: 'A', 104: 'B', 105: 'C' };
    // One orientation per camera frame. 180 is included because an upside-down
    // label is as common as a sideways one and costs a single pass.
    const LIVE_QUARTERS = [0, 1, 3, 2];

    function patternError(widths, pattern, modules) {
        let total = 0;
        for (let i = 0; i < widths.length; i++) total += widths[i];
        if (total <= 0) return 99;
        let err = 0;
        for (let i = 0; i < pattern.length; i++) {
            err += Math.abs(widths[i] * modules / total - pattern[i]);
        }
        return err;
    }

    function bestSymbol(widths) {
        let best = null;
        for (let i = 0; i < PATTERNS.length; i++) {
            const err = patternError(widths, PATTERNS[i], 11);
            if (!best || err < best.err) best = { err: err, value: i };
        }
        return best;
    }

    function checksum(start, values) {
        let sum = start;
        for (let i = 0; i < values.length; i++) sum += (i + 1) * values[i];
        return sum % 103;
    }

    function decodeText(start, values) {
        let code = STARTS[start];
        if (!code) return '';
        let text = '';
        for (let i = 0; i < values.length; i++) {
            const value = values[i];
            if ((code === 'A' || code === 'B') && value === 99) {
                code = 'C';
                continue;
            }
            if (code === 'B' && value === 100) {
                code = 'A';
                continue;
            }
            if (code === 'A' && value === 101) {
                code = 'B';
                continue;
            }
            if (code === 'C' && value === 100) {
                code = 'B';
                continue;
            }
            if (code === 'C' && value === 101) {
                code = 'A';
                continue;
            }
            if (code === 'B' && value === 98) {
                code = 'A';
                continue;
            }
            if (value === 102) continue;
            if (code === 'C') {
                if (value < 0 || value > 99) return '';
                text += value < 10 ? '0' + value : String(value);
            } else if (code === 'B' && value >= 0 && value < 95) {
                text += String.fromCharCode(value + 32);
            } else if (code === 'A' && value >= 0 && value < 64) {
                text += value < 32 ? '' : String.fromCharCode(value + 32);
            } else {
                return '';
            }
        }
        return text;
    }

    function runsFrom(signal, threshold) {
        const runs = [];
        let bar = signal[0] < threshold;
        let width = 1;
        let at = 0;
        for (let i = 1; i < signal.length; i++) {
            const next = signal[i] < threshold;
            if (next === bar) {
                width += 1;
            } else {
                runs.push({ bar: bar, w: width, at: at });
                bar = next;
                width = 1;
                at = i;
            }
        }
        runs.push({ bar: bar, w: width, at: at });
        if (runs.length && !runs[0].bar) runs.shift();
        if (runs.length && !runs[runs.length - 1].bar) runs.pop();
        return runs;
    }

    function stretch(line) {
        const sample = [];
        const step = Math.max(1, Math.floor(line.length / 400));
        for (let i = 0; i < line.length; i += step) sample.push(line[i]);
        sample.sort(function (a, b) { return a - b; });
        const lo = sample[Math.floor(sample.length * 0.05)] || 0;
        const hi = sample[Math.min(sample.length - 1, Math.floor(sample.length * 0.95))] || 1;
        const span = Math.max(1, hi - lo);
        const out = new Float32Array(line.length);
        for (let i = 0; i < line.length; i++) {
            const v = (line[i] - lo) / span;
            out[i] = v < 0 ? 0 : v > 1 ? 1 : v;
        }
        return out;
    }

    function greedy(runs) {
        let startAt = -1;
        let start = null;
        for (let i = 0; i <= Math.min(8, runs.length - 6); i++) {
            if (!polarity(runs, i, 6)) continue;
            const hit = bestSymbol(widths(runs, i, 6));
            if (hit && STARTS[hit.value] && hit.err <= 2.2 && (!start || hit.err < start.err)) {
                start = { err: hit.err, value: hit.value };
                startAt = i;
            }
        }
        if (!start) return null;
        const symbols = [{ value: start.value, err: start.err, run: startAt }];
        let i = startAt + 6;
        while (i + 6 <= runs.length && symbols.length < 24) {
            if (!polarity(runs, i, 6)) break;
            const hit = bestSymbol(widths(runs, i, 6));
            if (!hit || hit.err > 3.15) break;
            symbols.push({ value: hit.value, err: hit.err, run: i });
            i += 6;
        }
        return symbols;
    }

    function polarity(runs, index, count) {
        for (let k = 0; k < count; k++) {
            if (!runs[index + k] || runs[index + k].bar !== (k % 2 === 0)) return false;
        }
        return true;
    }

    function widths(runs, index, count) {
        const out = [];
        for (let k = 0; k < count; k++) out.push(runs[index + k].w);
        return out;
    }

    function waveform(modules) {
        const out = [];
        let bar = 1;
        for (let i = 0; i < modules.length; i++) {
            const level = bar ? 1 : -1;
            for (let k = 0; k < modules[i]; k++) out.push(level);
            bar = 1 - bar;
        }
        return out;
    }

    function pearson(signal, at, sampled) {
        const n = sampled.length;
        let meanA = 0;
        let meanB = 0;
        for (let i = 0; i < n; i++) {
            meanA += signal[at + i];
            meanB += sampled[i];
        }
        meanA /= n;
        meanB /= n;
        let num = 0;
        let da = 0;
        let db = 0;
        for (let i = 0; i < n; i++) {
            const xa = signal[at + i] - meanA;
            const xb = sampled[i] - meanB;
            num += xa * xb;
            da += xa * xa;
            db += xb * xb;
        }
        return num / (Math.sqrt(da * db) + 1e-9);
    }

    function sampleWave(wave, length) {
        const out = new Float32Array(length);
        const last = wave.length - 1;
        for (let i = 0; i < length; i++) {
            const x = (i + 0.5) * wave.length / length;
            const i0 = Math.min(last, Math.floor(x));
            const i1 = Math.min(last, i0 + 1);
            const f = Math.min(1, x - i0);
            out[i] = wave[i0] * (1 - f) + wave[i1] * f;
        }
        return out;
    }

    // Dark ink is positive. `signal` is stretched 0..1 with 0 = dark.
    function confirmTail(signal, at, checkValue) {
        const modules = PATTERNS[checkValue].concat(STOP);
        const wave = waveform(modules);
        let best = -1;
        for (let mod = 2; mod <= 8; mod += 0.25) {
            const length = Math.round(wave.length * mod);
            if (length < 24) continue;
            const sampled = sampleWave(wave, length);
            for (let shift = -12; shift <= 12; shift += 1) {
                const start = at + shift;
                if (start < 0 || start + length >= signal.length) continue;
                const score = pearson(signal, start, sampled);
                if (score > best) best = score;
            }
        }
        return best;
    }

    function confirmSymbols(signal, runs, symbols) {
        if (!symbols || symbols.length < 5) return null;
        const start = symbols[0].value;
        const data = symbols.slice(1);
        let best = null;
        for (let len = data.length; len >= 4; len--) {
            const payload = data.slice(0, len);
            let errSum = symbols[0].err;
            let worst = 0;
            for (let i = 0; i < payload.length; i++) {
                errSum += payload[i].err;
                if (payload[i].err > worst) worst = payload[i].err;
            }
            const mean = errSum / (payload.length + 1);
            if (mean > 1.45 || worst > 2.5) continue;
            const values = [];
            for (let i = 0; i < payload.length; i++) values.push(payload[i].value);
            const check = checksum(start, values);
            const runIndex = payload[payload.length - 1].run + 6;
            if (runIndex < 0 || runIndex >= runs.length) continue;
            const ink = new Float32Array(signal.length);
            for (let i = 0; i < signal.length; i++) ink[i] = 1 - signal[i];
            const corr = confirmTail(ink, runs[runIndex].at, check);
            if (corr < 0.78) continue;
            const text = decodeText(start, values).trim();
            if (!/^[A-Z0-9]{8,}$/.test(text)) continue;
            if (!best || corr > best.corr + 0.03 || (len > best.len && corr >= best.corr - 0.02)) {
                best = { text: text, corr: corr, len: len, mean: mean };
            }
        }
        return best;
    }

    function decodeLine(line) {
        const signal = stretch(line);
        const thresholds = [0.5, 0.56, 0.6, 0.62, 0.64, 0.68];
        let best = null;
        for (let t = 0; t < thresholds.length; t++) {
            const runs = runsFrom(signal, thresholds[t]);
            if (runs.length < 30) continue;
            const symbols = greedy(runs);
            const hit = confirmSymbols(signal, runs, symbols);
            if (!hit) continue;
            if (!best || hit.corr > best.corr + 0.03 || (hit.text.length > best.text.length && hit.corr >= best.corr - 0.02)) {
                best = hit;
            }
        }
        return best;
    }

    function luminance(data, width, height) {
        const gray = new Float32Array(width * height);
        for (let i = 0, p = 0; i < data.length; i += 4, p++) {
            gray[p] = data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114;
        }
        return gray;
    }

    function stripeEnergy(gray, width, height, alongY) {
        const length = alongY ? width : height;
        const energy = new Float32Array(length);
        if (alongY) {
            for (let x = 0; x < width; x++) {
                let sum = 0;
                for (let y = 1; y < height; y++) {
                    sum += Math.abs(gray[y * width + x] - gray[(y - 1) * width + x]);
                }
                energy[x] = sum;
            }
        } else {
            for (let y = 0; y < height; y++) {
                let sum = 0;
                const row = y * width;
                for (let x = 1; x < width; x++) sum += Math.abs(gray[row + x] - gray[row + x - 1]);
                energy[y] = sum;
            }
        }
        return energy;
    }

    function peakBands(energy) {
        const work = Float32Array.from(energy);
        const bands = [];
        for (let n = 0; n < 2; n++) {
            let max = 0;
            let at = 0;
            for (let i = 0; i < work.length; i++) {
                if (work[i] > max) {
                    max = work[i];
                    at = i;
                }
            }
            if (max <= 0) break;
            if (bands.length && max < bands[0].max * 0.55) break;
            const half = 22;
            const start = Math.max(0, at - half);
            const end = Math.min(work.length, at + half);
            if (end - start >= 8) bands.push({ start: start, end: end, max: max });
            for (let i = Math.max(0, at - half * 2); i < Math.min(work.length, at + half * 2); i++) work[i] = 0;
        }
        return bands;
    }

    function medianLine(gray, width, height, alongY, band) {
        const length = alongY ? height : width;
        const line = new Float32Array(length);
        const inset = Math.max(0, Math.floor((band.end - band.start) * 0.15));
        const from = band.start + inset;
        const to = Math.max(from + 1, band.end - inset);
        const cols = to - from;
        const values = new Float32Array(cols);
        for (let i = 0; i < length; i++) {
            for (let k = 0; k < cols; k++) {
                const pos = from + k;
                values[k] = alongY ? gray[i * width + pos] : gray[pos * width + i];
            }
            // Partial sort is enough for the median of a few dozen samples.
            const copy = Array.from(values);
            copy.sort(function (a, b) { return a - b; });
            line[i] = copy[copy.length >> 1];
        }
        return line;
    }

    function reversed(line) {
        const out = new Float32Array(line.length);
        for (let i = 0; i < line.length; i++) out[i] = line[line.length - 1 - i];
        return out;
    }

    function readHardBarcode(data, width, height) {
        if (!data || width < 24 || height < 24) return null;
        const gray = luminance(data, width, height);
        const candidates = [];
        const axes = [true, false];
        for (let a = 0; a < axes.length; a++) {
            const alongY = axes[a];
            const energy = stripeEnergy(gray, width, height, alongY);
            const bands = peakBands(energy);
            for (let b = 0; b < bands.length; b++) {
                const line = medianLine(gray, width, height, alongY, bands[b]);
                const forward = decodeLine(line);
                const backward = decodeLine(reversed(line));
                if (forward) candidates.push(forward);
                if (backward) candidates.push(backward);
            }
        }
        if (!candidates.length) return null;
        candidates.sort(function (a, b) {
            if (Math.abs(b.corr - a.corr) > 0.03) return b.corr - a.corr;
            return b.text.length - a.text.length;
        });
        const top = candidates[0];
        for (let i = 1; i < candidates.length; i++) {
            if (candidates[i].text !== top.text && candidates[i].corr > top.corr - 0.06) return null;
        }
        return { text: top.text, format: 'Code128', corr: top.corr };
    }

    // One turn is 90 degrees clockwise. Quarters 1, 2 and 3 are 90, 180 and 270.
    function rotateQuarter(data, width, height, quarters) {
        let current = { data: data, width: width, height: height };
        const turns = ((quarters % 4) + 4) % 4;
        for (let q = 0; q < turns; q++) {
            const w = current.width;
            const h = current.height;
            const src = current.data;
            const out = new Uint8ClampedArray(w * h * 4);
            for (let y = 0; y < h; y++) {
                for (let x = 0; x < w; x++) {
                    const s = (y * w + x) * 4;
                    const nx = h - 1 - y;
                    const ny = x;
                    const d = (ny * h + nx) * 4;
                    out[d] = src[s];
                    out[d + 1] = src[s + 1];
                    out[d + 2] = src[s + 2];
                    out[d + 3] = src[s + 3];
                }
            }
            current = { data: out, width: h, height: w };
        }
        return current;
    }

    function contrastStretch(data, width, height) {
        const gray = luminance(data, width, height);
        const sample = [];
        const step = Math.max(1, Math.floor(gray.length / 5000));
        for (let i = 0; i < gray.length; i += step) sample.push(gray[i]);
        sample.sort(function (a, b) { return a - b; });
        const lo = sample[Math.floor(sample.length * 0.02)];
        const hi = sample[Math.min(sample.length - 1, Math.floor(sample.length * 0.98))];
        const span = Math.max(1, hi - lo);
        const out = new Uint8ClampedArray(width * height * 4);
        for (let i = 0, p = 0; i < gray.length; i++, p += 4) {
            let v = Math.round((gray[i] - lo) * 255 / span);
            if (v < 0) v = 0;
            if (v > 255) v = 255;
            out[p] = out[p + 1] = out[p + 2] = v;
            out[p + 3] = 255;
        }
        return { data: out, width: width, height: height };
    }

    function scaleImage(data, width, height, factor) {
        const scale = factor <= 1 ? 1 : factor;
        const w2 = Math.max(1, Math.round(width * scale));
        const h2 = Math.max(1, Math.round(height * scale));
        if (w2 === width && h2 === height) return { data: data, width: width, height: height };
        const out = new Uint8ClampedArray(w2 * h2 * 4);
        for (let y = 0; y < h2; y++) {
            const sy = Math.min(height - 1, (y + 0.5) / scale - 0.5);
            const y0 = Math.max(0, Math.floor(sy));
            const y1 = Math.min(height - 1, y0 + 1);
            const fy = sy - y0;
            for (let x = 0; x < w2; x++) {
                const sx = Math.min(width - 1, (x + 0.5) / scale - 0.5);
                const x0 = Math.max(0, Math.floor(sx));
                const x1 = Math.min(width - 1, x0 + 1);
                const fx = sx - x0;
                const d = (y * w2 + x) * 4;
                for (let c = 0; c < 4; c++) {
                    const v =
                        data[(y0 * width + x0) * 4 + c] * (1 - fx) * (1 - fy) +
                        data[(y0 * width + x1) * 4 + c] * fx * (1 - fy) +
                        data[(y1 * width + x0) * 4 + c] * (1 - fx) * fy +
                        data[(y1 * width + x1) * 4 + c] * fx * fy;
                    out[d + c] = v;
                }
            }
        }
        return { data: out, width: w2, height: h2 };
    }

    // Map a point in a quarter-turned image back onto the source.
    // Quarters match rotateQuarter (each turn is 90 degrees clockwise).
    function unrotatePoint(point, width, height, quarters) {
        if (!point) return null;
        let x = point.x;
        let y = point.y;
        let w = width;
        let h = height;
        const turns = ((quarters % 4) + 4) % 4;
        for (let q = 0; q < turns; q++) {
            const nx = y;
            const ny = w - 1 - x;
            x = nx;
            y = ny;
            const tmp = w;
            w = h;
            h = tmp;
        }
        return { x: x, y: y };
    }

    const ZXING_FORMATS = [
        'Code128', 'Code39', 'Code93', 'Codabar', 'ITF',
        'QRCode', 'EAN13', 'EAN8', 'UPCA', 'UPCE',
        'PDF417', 'DataMatrix', 'Aztec'
    ];
    // Short retail symbols are left out of the rotated and cleaned-up passes.
    // A blurry Code 128 is otherwise easy to report as an EAN-8 or UPC-E.
    const ZXING_HARD_FORMATS = [
        'Code128', 'Code39', 'Code93', 'Codabar', 'ITF',
        'QRCode', 'EAN13', 'UPCA',
        'PDF417', 'DataMatrix', 'Aztec'
    ];

    function readerOptions(formats, extra) {
        return Object.assign({
            tryHarder: true,
            tryRotate: false,
            tryInvert: false,
            tryDenoise: false,
            tryDownscale: false,
            maxNumberOfSymbols: 32,
            textMode: 'Plain',
            formats: formats
        }, extra || {});
    }

    root.ScanlineDecoder = {
        ZXING_FORMATS: ZXING_FORMATS,
        ZXING_HARD_FORMATS: ZXING_HARD_FORMATS,
        readerOptions: readerOptions,
        PATTERNS: PATTERNS,
        STOP: STOP,
        LIVE_QUARTERS: LIVE_QUARTERS,
        decodeText: decodeText,
        checksum: checksum,
        readHardBarcode: readHardBarcode,
        rotateQuarter: rotateQuarter,
        contrastStretch: contrastStretch,
        scaleImage: scaleImage,
        unrotatePoint: unrotatePoint
    };
})(typeof globalThis !== 'undefined' ? globalThis : this);
