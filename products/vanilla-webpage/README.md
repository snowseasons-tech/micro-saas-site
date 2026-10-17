# Snow Seasons — Vanilla Webpage Template

A lightweight, dependency-free single-page website template for a products page. Everything — HTML, CSS, and JavaScript — lives in one self-contained `index.html` file. No frameworks, no build step, no CDNs. Open it in a browser and it works.

Built by Snow Seasons Tech ([snowseasonstech.net](https://snowseasonstech.net)).

## Features

- **Zero dependencies** — pure HTML, CSS, and vanilla JS in a single file
- **Light/dark theme toggle** — driven by a `data-theme` attribute on `<html>`, with an accessible `aria-pressed` state on the toggle button
- **CSS variable theming** — all colors and the container width are defined once in `:root` and overridden for dark mode
- **Responsive layout** — auto-fit card grid plus a mobile breakpoint at 600px that reflows the nav and scales the hero
- **Sticky header** with smooth anchor navigation to the About and Features sections
- **Semantic, accessible markup** — `header`/`main`/`footer` landmarks, `aria-label` on the nav, real `<button>` for the theme toggle

## Page Structure

| Section | ID | Contents |
|---------|----|----------|
| Header / Nav | — | "Snow Seasons" logo, anchor links (About, Features), theme toggle |
| Hero | `#hero` | Headline, intro copy, "Explore features" call-to-action |
| About | `#about` | Blurb about BI/CI/CD pipelines and micro-SaaS offerings |
| Features | `#features` | Three cards: Responsive layout, Theme toggle, Easy to customize |
| Footer | — | © 2026 snowseasonstech.net |

## Theming

All visual styling is controlled by CSS variables in the `<style>` block:

| Variable | Purpose | Light | Dark |
|----------|---------|-------|------|
| `--bg-color` | Page background | `#ffffff` | `#1a1a1a` |
| `--text-color` | Body text | `#333333` | `#f4f4f4` |
| `--primary-color` | Logo, links, buttons | `#3498db` | *(same)* |
| `--secondary-color` | Header, footer, cards | `#f4f4f4` | `#2d2d2d` |
| `--accent-color` | Accent (available, currently unused in markup) | `#e74c3c` | *(same)* |
| `--container-width` | Max content width | `1100px` | — |
| `--transition` | Global transition preset | `all 0.3s ease` | — |

To rebrand the template, edit `--primary-color` and the logo text in the header — the rest follows automatically.

## How the Theme Toggle Works

```js
const themeToggle = document.querySelector("#theme-toggle");

themeToggle.addEventListener("click", () => {
    const isDark = document.documentElement.dataset.theme !== "dark";
    document.documentElement.dataset.theme = isDark ? "dark" : "light";
    themeToggle.setAttribute("aria-pressed", String(isDark));
});
```

Clicking the toggle flips the `data-theme` attribute between `dark` and `light`, which swaps the CSS variable overrides. The `aria-pressed` attribute keeps the button's state exposed to assistive technology.

## Getting Started

1. Save `index.html` anywhere.
2. Open it in any modern browser — no server or build tooling required.
3. Customize the colors, copy, and sections to fit your product.

## Customization Ideas

- **Content** — replace the hero headline and the three feature cards with your product's benefits.
- **Persistence** — the theme choice currently resets on reload; save it with `localStorage` and set `data-theme` on page load.
- **More sections** — duplicate a `<section>` block; nav links use anchor IDs (`#about`, `#features`).
- **Typography** — swap the `font-family` stack (`Segoe UI, Tahoma, Geneva, Verdana, sans-serif`).
- **Accent color** — `--accent-color` is defined but not yet used; wire it into badges or highlights.

## Accessibility Notes

- Navigation has `aria-label="Main navigation"`.
- The toggle button is a real `<button type="button">` with `aria-pressed` tracking the current theme.
- All interactive elements are reachable via keyboard; hover/focus styles come from the global transition.
- One note: the intro copy contains a typo ("envirnment") you may want to fix before publishing.