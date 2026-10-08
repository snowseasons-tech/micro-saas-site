# Micro SaaS Site

A lightweight invoice and billing page for a small SaaS or service business. The app is a single-file HTML page that lets you create invoice details, add line items, calculate totals, save a draft locally, and print or save as PDF.

## Features

- Clean invoice layout with business and customer details
- Line-item management with quantity, rate, and amount calculations
- Automatic subtotal, tax, and total calculation
- Currency selection
- Local draft save/load using browser `localStorage`
- Print-friendly layout for PDF export

## Project structure

- `index.html` — complete app UI and logic

## Running locally

Because this is a static HTML page, you can open it directly in a browser or serve it locally.

### Option 1: Open directly

Open `index.html` in your browser.

### Option 2: Serve locally

From the project root:

```bash
python3 -m http.server 8000
```

Then visit:

```text
http://localhost:8000
```

## Notes

- Drafts are saved in the browser using `localStorage`, so they are specific to the browser and device where the page is used.
- The print layout is designed to work well with browser print-to-PDF functionality.

## License

This project is provided as-is for demo and local use.
