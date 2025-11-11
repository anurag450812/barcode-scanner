# Barcode Scanner

A web-based barcode scanner that automatically copies scanned barcodes to clipboard with sound and vibration feedback.

## Features

- 📱 Scans both 1D and 2D barcodes (QR codes, EAN, UPC, Code 128, etc.)
- 📋 Automatically copies barcode text to clipboard
- 🔊 Audio feedback on successful scan
- 📳 Vibration feedback (mobile devices)
- 📷 Uses device's rear camera
- 🎯 Native Barcode Detection API for fast scanning

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

1. Open `index.html` in Chrome on Android (or any browser supporting the Barcode Detection API)
2. Click "Start Scanner" and grant camera permissions
3. Point the camera at a barcode
4. The barcode text will automatically copy to clipboard with a beep and vibration

## Browser Compatibility

This app uses the native Barcode Detection API, which is currently supported in:
- Chrome on Android
- Chrome/Edge on desktop (with experimental flags enabled)

## Live Demo

Open the website on your phone to start scanning barcodes instantly!

## Files

- `index.html` - Main HTML structure
- `script.js` - Barcode detection and clipboard logic
- `style.css` - Mobile-friendly styling

## License

Free to use for personal and commercial projects.
