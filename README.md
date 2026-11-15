# Barcode Scanner

A static single-page scanner for return AWBs. Upload an Excel file of airway bill numbers, then scan barcodes with the phone camera or from a desktop screen share. A matching AWB is copied to the clipboard, and the row's other columns are shown on a green card.

No build step and no backend. Open `index.html`, or use the site deployed from `master`:

https://returnsbarcodecopy.netlify.app

## Excel AWB matching

1. Choose an `.xlsx` or `.xls` file, or drop it on the upload area.
2. The first sheet is read in the browser with SheetJS. The AWB column is the header whose name contains "awb", otherwise the first column.
3. The rows are stored in IndexedDB on this device, so they are still there after a refresh. **Clear Data** removes them.
4. Every successful scan is copied to the clipboard, with a short beep and a vibration on phones.
5. If the scanned text exactly matches a loaded AWB, a green **AWB FOUND** card lists that row's other columns and a siren plays. A scan that is not in the list keeps scanning quietly: no siren and no error card.
6. The same value is not announced again for 2 seconds.

## Camera mode

**Start Scanner** opens the rear camera through `getUserMedia`.

- Pinch-level zoom uses the camera's own zoom when the phone supports it, and a digital crop otherwise.
- **Stop Scanner** releases the camera.
- On Android Chrome this uses the built-in Barcode Detection API.

## Screen mode

**Scan Screen** is for doing the whole job in desktop Chrome or Edge: upload the Excel there, share the screen the labels are on, and let the page read them.

1. Click **Scan Screen** and pick a whole screen, a window, or a browser tab. The current tab is hidden from the picker so the preview does not recurse.
2. Drag a rectangle on the live preview around the barcode. Only that region is scanned. Draw the box tightly around the code; small codes on a large desktop are much more reliable that way.
3. Drag again to replace the rectangle. **Reselect** clears it, forgets the saved rectangle, and waits for a new one (scanning pauses until you draw). **Full frame** scans the entire shared image and forgets the rectangle.
4. The last rectangle is remembered in this browser, as fractions of the frame, and applied the next time you share.
5. **Stop Sharing** ends the capture. Ending it from the browser's own "Stop sharing" bar does the same thing and returns the page to idle.

Detected codes follow the camera rules: clipboard, beep, green AWB card and siren on a match, quiet continue otherwise, and the same 2 second duplicate window.

## Sounds

Beeps and the siren use the Web Audio API. Browsers start that context suspended, so it is resumed on the click that starts the camera or screen share. If a click produced no sound, start the scanner again with another click after the tab has been in the background.

## Barcode formats

Code 128 (typical courier AWBs), Code 39, Code 93, Codabar, ITF, QR Code, EAN-13, EAN-8, UPC-A, UPC-E, PDF417, Data Matrix, and Aztec.

## Browser support

| Browser | Camera | Screen share |
| --- | --- | --- |
| Chrome on Android | Yes, native Barcode Detection | Not the intended path |
| Chrome and Edge on Windows and Linux desktops | Yes, via the ZXing fallback | Yes |
| Chrome and Edge on macOS and ChromeOS | Yes. Native Barcode Detection is used when the browser reports Code 128 and QR support | Yes |

Desktop Chrome and Edge on Windows and Linux do not reliably provide a working Barcode Detection API. `BarcodeDetector` is often missing entirely, and where the object exists `getSupportedFormats()` comes back empty because those builds have no platform decoder. This page uses the native detector only when Code 128 and QR are actually reported (Android Chrome, and macOS or ChromeOS when the browser supports them). Otherwise it loads [zxing-wasm](https://github.com/Sec-ant/zxing-wasm) (ZXing C++) from jsDelivr and uses that for both modes. Android Chrome keeps the native detector and does not download the fallback.

Screen sharing needs a secure page (HTTPS or localhost) and a user gesture. The site cannot capture the screen silently. Firefox has no native Barcode Detection API; the ZXing fallback can still run there, but the tested targets are desktop Chrome and Edge.

A selected region that is only a few hundred pixels wide is scaled up (2x or 3x) before decoding so thin Code 128 bars survive. A full high-resolution frame is scaled down only enough to keep each pass responsive, which is another reason to box the barcode instead of scanning the whole monitor.

## Files

- `index.html` — page structure
- `script.js` — Excel loading, camera scan, screen share, region selection, decoders
- `style.css` — layout

## License

Free to use for personal and commercial projects.
