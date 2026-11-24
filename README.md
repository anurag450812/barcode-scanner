# Barcode Scanner

A web-based barcode scanner that automatically copies scanned barcodes to clipboard with sound and vibration feedback.

## Features

- 📱 Scans both 1D and 2D barcodes (QR codes, EAN, UPC, Code 128, etc.)
- 📋 Automatically copies barcode text to clipboard
- 🔊 Audio feedback on successful scan
- 📳 Vibration feedback (mobile devices)
- 📷 Uses the rear camera when the device has one, otherwise any camera
- 🎯 Native Barcode Detection API when the browser provides it
- 🔄 ZXing fallback so scanning works in Edge, Firefox, Safari, and desktop Chrome

## Supported Barcode Formats

- QR Code
- EAN-13, EAN-8
- UPC-A, UPC-E
- Code 128, Code 39, Code 93
- Codabar
- Data Matrix
- PDF417
- Aztec
- ITF

## Usage

1. Open the site in a modern browser (Chrome, Edge, Firefox, or Safari, on a phone or a computer)
2. Click "Start Scanner" and grant camera permissions
3. Point the camera at a barcode
4. The barcode text will automatically copy to clipboard with a beep and vibration

## Browser Compatibility

Scanning uses the native Barcode Detection API when `BarcodeDetector` is available (Chrome on Android, and desktop browsers that enable it). Everywhere else — including Microsoft Edge and Chrome on Windows, Firefox, and Safari — the page loads `@zxing/library` from a CDN and decodes the same formats in JavaScript. No build step is required.

The rear camera is requested as a preference. Laptops and desktops with only a front or built-in webcam still open that camera.

## Live Demo

Open the website on your phone to start scanning barcodes instantly!

## Files

- `index.html` - Main HTML structure
- `script.js` - Barcode detection and clipboard logic
- `style.css` - Mobile-friendly styling

## License

Free to use for personal and commercial projects.
