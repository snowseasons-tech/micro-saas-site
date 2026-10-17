# SnowSeasonsTech Engagement Dashboard

A single-file, dark-themed operations dashboard for managing client engagements and project opportunities. Built as a fully static demo — no backend, no build step, no database. All data lives in the browser and resets on page reload.

> **Note:** This dashboard is a demo workspace. It is not connected to SnowSeasonsTech systems or live company metrics. All records are illustrative samples.

## Features

### 1. Operations Overview

- **KPI cards**: Active Engagements, Open Opportunities, and Average Fit Score (X/100), all updated live as data changes.
- **Opportunity Pipeline** — a donut chart showing the distribution of opportunities by status (Hot / Warm / Contacted).
- **Engagements by Service** — a horizontal bar chart counting engagements across the six service lines.

Both charts are powered by Chart.js and re-render automatically whenever an engagement or opportunity is added.

### 2. New Engagement (3-step wizard)

A guided form that walks through creating an engagement:

1. **Organization & Service**
2. **Desired Outcome**
3. **Existing Tools / Constraints**

Includes a live progress bar and step indicator. On submit, the new engagement is added to the sample list and the dashboard metrics refresh. Sample engagement cards are displayed below the wizard.

### 3. Project Pipeline

- Sortable opportunity table with color-coded fit scores (green > 70, amber otherwise) and status badges.
- **Filters**: view all opportunities or only those with a fit score above 75.
- **Add Opportunity** modal for creating new entries (organization, service area, fit score 0–100, status).
- **Export CSV** — downloads the current opportunity list as `snowseasonstech-opportunities.csv` (UTF-8 with BOM, CSV-injection safe: cells beginning with `=`, `+`, `-`, or `@` are neutralized).

### 4. Services

A marketing-style grid of the six service lines:

| # | Service |
|---|---------|
| 01 | AI Infrastructure |
| 02 | Software Engineering |
| 03 | Security Engineering |
| 04 | DevOps & Automation |
| 05 | Data Engineering |
| 06 | Architecture & Consulting |

Each links back to the live site for details.

### 5. UI Extras

- **Profile selector** (Admin Dashboard / Analyst View) in the sidebar — UI only in this demo.
- **Dark theme toggle** — switches the Tailwind `dark` class (the dashboard is styled dark by default).

## Tech Stack

- **HTML5** — single self-contained `index.html` file
- **Tailwind CSS** (CDN, Play CDN with custom `brand` color palette)
- **Chart.js** (CDN) for donut and bar charts
- **Vanilla JavaScript** — all state and rendering handled client-side

No build tooling, dependencies, or server required.

## Getting Started

1. Save `index.html` anywhere on your machine.
2. Open it in any modern browser (double-click, or serve it with any static server).
3. That's it — the dashboard initializes with sample data on load.

> **Internet connection required** for the Tailwind CSS and Chart.js CDNs.

## How It Works

- A central `state` object holds two arrays: `clients` (engagements) and `leads` (opportunities), plus wizard step tracking and chart references.
- Rendering functions (`renderClients`, `renderLeads`) rebuild the engagement cards and pipeline table from state; all user input is escaped via `escapeHTML()`.
- `updateDashboardData()` recomputes the KPI metrics and pushes fresh counts into both charts.
- Navigation between the four sections is handled by `switchTab()`, which toggles visibility of the corresponding `<section>` and syncs the sidebar highlight and page title.

## Data Persistence

None, by design. All changes (new engagements, added opportunities) live only in the current browser session and are lost on reload. To persist data, you would need to wire the state object to `localStorage` or a backend API.

## Customization

- **Branding**: colors are defined in the `tailwind.config` block in the `<head>` (`brand.500/600/700` are sky blues).
- **Services**: edit the `<option>` lists in the onboarding form and Add Opportunity modal, plus the Services section cards and the chart label array in `initCharts()`.
- **Sample data**: modify the `clients` and `leads` arrays in the `state` object near the bottom of the file.
- **CSV filename**: change `link.download` in `exportCSV()`.

## Disclaimer

All organization names, scores, and records shown are sample data for demonstration purposes only. Nothing in this dashboard reflects real SnowSeasonsTech clients, pipelines, or metrics.