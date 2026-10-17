# Snow Seasons Tech · Booking App

A single-page, booking-only scheduling tool built as a white-label demo. It renders a weekly calendar of appointment slots and lets you create, view, and cancel bookings — all in client-side React state, with no backend.

> **Note:** This is a demo component. Bookings are seeded with sample data and persist only for the current session — nothing is sent to a server or saved between reloads.

## Features

- **Weekly slot grid** — five days (Mon 5 – Fri 9), each with seven time slots (09:00–16:00, no lunch hour at 13:00). Booked slots show client name, service, and a hover-revealed **Cancel** button; open slots are shown as dashed placeholders.
- **New booking form** — client name, email, service, day, and time. The **Confirm booking** button stays disabled until all fields are filled and the chosen slot is free.
- **Double-booking prevention** — the `taken()` helper checks slot availability; occupied time slots are disabled and marked "(taken)" in the time dropdown.
- **Live stats cards** — *Bookings this week*, *Confirmed*, and *Open slots* (35 total slots minus bookings), recalculated on every change.
- **White-label branding** — header carries a "Your Brand Here" badge; the "Snow Seasons Tech · Booking" title and gradient styling are easy to re-skin.

## Tech Stack

- **React** (`useState` for all state)
- **TypeScript** (typed `Booking` model)
- **shadcn/ui** components — `Card`, `Button`, `Input`, `Label`, `Badge`, `Select`
- **Tailwind CSS** for styling (dark slate / sky-cyan theme)

## Data Model

```ts
type Booking = {
  id: string;        // unique id, e.g. "b1"
  client: string;    // client name
  email: string;     // contact email
  service: string;   // one of: Consultation, Styling, Follow-up, Training, Site review
  day: number;       // index into `days` (0 = Mon 5, ... 4 = Fri 9)
  time: string;      // "HH:MM" slot, e.g. "09:00"
  duration: number;  // minutes; new bookings default to 60
  status: "Confirmed" | "Pending";
};
```

Seed data ships with three sample bookings (two Confirmed, one Pending).

## Getting Started

### Prerequisites

- A React project with TypeScript and Tailwind CSS configured
- The shadcn/ui components listed above installed (e.g., via `npx shadcn@latest add card button input label badge select`)
- A `@/` path alias pointing at your project root (standard in Vite + shadcn setups)

### Installation

1. Save the component as `src/App.tsx` (or import it wherever you like).
2. Ensure the shadcn/ui imports resolve: `@/components/ui/card`, `button`, `input`, `label`, `badge`, `select`.
3. Run your dev server (`npm run dev` or equivalent) and open the app.

## How It Works

- **State** — a single `bookings` array holds all appointments; form fields are individual controlled inputs.
- **`taken(day, time)`** — returns true if any booking already occupies that day/time pair; used to disable slots, guard the form, and render the grid.
- **`book()`** — validates inputs, appends a new `Booking` with status `Confirmed`, then clears the form. Booking IDs are generated as `"b" + (bookings.length + 1)`.
- **`cancel(id)`** — filters the booking out of the array; the grid and stats update reactively.

## Limitations & Roadmap Ideas

- **No persistence** — reload resets to seed data. Add `localStorage` or an API layer for durability.
- **No email validation** — the email field accepts any non-empty text.
- **Fixed week & hours** — the `days` and `timeSlots` arrays are hardcoded; generate them from real dates for production.
- **ID collisions** — `"b" + (length + 1)` can duplicate IDs after cancellations; use `crypto.randomUUID()` instead.
- **No duration editing** — new bookings are always 60 minutes; slot capacity doesn't account for longer services.
- **No pending workflow** — the status type includes "Pending" (used in seed data) but the form always creates "Confirmed" bookings.

## Customization

- **Branding** — swap the header title, gradient classes (`from-sky-300 to-cyan-300`), and the "Your Brand Here" badge for your client's identity.
- **Services** — edit the `services` array.
- **Schedule** — adjust `days` and `timeSlots` (remember that "Open slots" stat assumes `days.length * timeSlots.length` total capacity).
- **Theme** — the dark theme is driven by Tailwind classes (`bg-slate-950`, `bg-slate-900`, `border-slate-800`); replace with your palette.

## Disclaimer

All client names, emails, and bookings are illustrative sample data for demonstration purposes only.