# Dockhood — UI Rebrand Brief

**Scope:** Frontend / UI only.
**Not in scope:** Smart contracts, Envio indexer, Pons integration, Lean worker, Verification Queue backend, Fastify API, database schemas, Railway deploy configs, auth (SIWE), fee splits, token economics.

**What this rebrand changes:** visual language, naming, copy, assets, routes.
**What stays identical:** every line of code under `apps/api`, `apps/indexer`, `apps/contracts`, `apps/verifier-worker`, `packages/shared`, and all `.env` configs. Chain stays Robinhood Chain. Launch rail stays Pons. Token contract address does NOT change (we rename display ticker from `$HEXE` → `$DOCK`; contract/CA unchanged).

---

## 1. Brand

| Field | Value |
|-------|-------|
| Product name | **Dockhood** |
| Domain | **dockhood.fun** |
| X handle | **@dockhood** (keep @Hoodexe\_ as backup redirect) |
| Ticker (display) | **$DOCK** |
| Token contract | unchanged (keep existing $HEXE CA, display-only rename) |
| Tagline (hero H1) | **The launchpad that boots clean.** |
| Subhead | Theorem-backed coins. Formally verified. Fully on-chain. |
| One-liner | **Dockhood. The Mathematical Superintelligence launchpad.** |
| Pons bio | Mathematical Superintelligence launchpad on Robinhood Chain. Theorem-backed coins. |

**Tone rules (apply to every string in UI):**
- Declarative, product-first, confident
- Short sentences. Period over comma.
- No "we", "our", "join us"
- No "revolutionary", "cutting-edge", "disruptive"
- Numbers over adjectives ("15 minutes", not "fast")
- One idea per line

---

## 2. Visual language — macOS Sonoma

**Reference:** macOS Sonoma / Sequoia desktop aesthetic. Clean, premium, translucent glass, warm abstract wallpaper, rounded square icons, dock magnify.

**DO NOT** copy Apple assets 1:1 (wallpaper file, exact icon artwork, SF logo). Build custom equivalents.

### 2.1 Colors

```css
/* Base */
--bg-wallpaper-start: #ff9a56;   /* warm sunset orange */
--bg-wallpaper-mid:   #f45b7a;   /* dune pink */
--bg-wallpaper-end:   #3a2d6b;   /* deep twilight purple */

/* Glass surfaces */
--glass-light: rgba(255, 255, 255, 0.72);
--glass-dark:  rgba(28, 28, 32, 0.68);
--glass-border: rgba(255, 255, 255, 0.18);
--glass-shadow: 0 10px 40px rgba(0, 0, 0, 0.25);

/* Traffic lights */
--tl-red:    #ff5f57;
--tl-yellow: #febc2e;
--tl-green:  #28c840;

/* Text */
--text-primary:   #1c1c20;
--text-secondary: #6a6a70;
--text-on-dark:   #f2f2f5;

/* Accent (keep hood equity) */
--accent-primary: #0a84ff;   /* macOS system blue */
--accent-success: #30d158;
--accent-warning: #ff9f0a;
--accent-danger:  #ff453a;
```

Backdrop filter: `backdrop-filter: blur(32px) saturate(180%);` on every glass surface.

### 2.2 Typography

**Primary:** Inter (free, SF Pro alternative; do NOT ship SF Pro — Apple license risk)
- Weights needed: 400, 500, 600, 700
- Fallback stack: `Inter, -apple-system, "SF Pro Display", BlinkMacSystemFont, system-ui, sans-serif`

**Mono (code / addresses / numbers):** JetBrains Mono or SF Mono fallback
- Fallback: `"JetBrains Mono", "SF Mono", Menlo, Consolas, monospace`

Scale:
```
display: 48px / 1.1 / 700
h1:      34px / 1.2 / 700
h2:      24px / 1.3 / 600
h3:      18px / 1.4 / 600
body:    14px / 1.5 / 400
caption: 12px / 1.4 / 500
micro:   11px / 1.3 / 500
```

### 2.3 Window chrome

Every "app window" in the desktop uses:
- Rounded corners: `border-radius: 12px`
- Border: `1px solid var(--glass-border)`
- Background: `var(--glass-light)` with `backdrop-filter`
- Shadow: `var(--glass-shadow)`
- Title bar: 32px tall, centered title text, **traffic lights top-left (red/yellow/green dots, 12px each)**
- NO Windows-style chunky title bars. NO minimize/maximize/close text buttons.

Title bar HTML pattern:
```html
<div class="window-chrome">
  <div class="traffic-lights">
    <span class="tl tl-red"></span>
    <span class="tl tl-yellow"></span>
    <span class="tl tl-green"></span>
  </div>
  <div class="window-title">Launch</div>
</div>
```

### 2.4 Dock (replaces XP taskbar)

- Position: `bottom: 16px; left: 50%; transform: translateX(-50%)`
- Height: 72px
- Background: `var(--glass-light)` + strong blur
- Border-radius: 20px
- Icons: 56px rounded squares, 12px gap
- Hover magnify: scale 1.4, neighbors scale 1.2 (CSS transform on hover; no JS physics required for v1 — can be enhanced later)
- Running-app indicator: 4px dot below icon

### 2.5 Menu bar (new element, replaces XP top area)

- Position: `top: 0; left: 0; right: 0`
- Height: 28px
- Background: `rgba(255,255,255,0.5)` + blur
- Left side: 🐬 Dockhood logo + "Dockhood" + menu items (File · Edit · View · Window · Help) — menu items are display-only for v1, no dropdown required unless time permits
- Right side: live $DOCK price ticker, Σ score (if applicable), wallet connect pill, clock

### 2.6 Icons

Replace all XP pixel icons with rounded-square app icons:
- Size: 128×128 source, display at 56px on dock, 96px on desktop
- Border-radius: 22% (iOS-style squircle)
- Soft inner highlight + outer shadow
- Flat gradient background per app
- Single-color glyph in center (white or dark depending on bg)

Icon palette per app (keep consistent):

| App | Icon bg | Glyph |
|-----|---------|-------|
| Launch | gradient blue → purple | rocket |
| Explore | gradient teal → cyan | compass |
| Callouts | gradient orange → red | megaphone |
| Portfolio | gradient gold → brown | briefcase |
| Theorem Board | gradient dark → navy | Σ symbol |
| Verification | gradient green → mint | checkmark |
| Games | gradient pink → purple | controller |
| hood.exe on X (legacy; rename to "@dockhood") | black | X logo |

---

## 3. Screens / routes

Routing stays the same path structure, but every page gets the macOS treatment. Nothing moves on the URL side except the domain.

### 3.1 Domain + redirects

- Primary: `dockhood.fun`
- Keep `hood.exe` / `hoodexe.site` live for 60 days with a 301 redirect to `dockhood.fun`
- Preserve all subpaths: `/explore/[token]` → `/explore/[token]`

### 3.2 Desktop (home / `/`)

Replace the XP Bliss desktop with the Dockhood desktop:

- **Background:** custom abstract dune/wave gradient wallpaper (do NOT use Apple's Sonoma file). Deliverable as static optimized webp 2560×1440. If time-constrained, use CSS gradient `linear-gradient(135deg, var(--bg-wallpaper-start), var(--bg-wallpaper-mid), var(--bg-wallpaper-end))`.
- **Desktop app icons:** grid of 96px rounded-square icons on the left side, same apps as current hood.exe (Launch, Explore, Callouts, Portfolio, Theorem Board, Verification, Games, @dockhood). Labels under icons in white with text-shadow.
- **Dock at bottom:** persistent, holds Launch, Explore, Verification, Callouts, Portfolio, with "@dockhood on X" at far right.
- **Menu bar at top:** persistent across all screens.
- **No Start button. No Recycle Bin.** Those are Windows metaphors.

### 3.3 Launch window (`/launch`)

- Open as a draggable glass window centered on desktop
- Title: "Launch"
- Keep all existing form fields (name, symbol, description, image upload, Pons params)
- Replace Luna Blue inputs with macOS text fields:
  - `border: 1px solid rgba(0,0,0,0.1)`
  - `background: rgba(255,255,255,0.6)`
  - `border-radius: 6px`
  - `padding: 8px 12px`
- Primary CTA button: filled blue (`var(--accent-primary)`), 36px tall, 8px radius, white Inter 600 label
- Secondary button: `background: rgba(0,0,0,0.06)`, dark label

### 3.4 Explore / Callouts / Portfolio / Theorem Board / Verification windows

Same window chrome, same backend endpoints, same data shapes. Only visual tokens change. Tables keep their columns. Row hover: `background: rgba(10,132,255,0.06)`.

### 3.5 Verification Queue (critical — our current flagship)

Keep every panel and button that exists today:
- Verification Admin: pool balance, queue, this week, paid out, fee split, submissions toggle, payouts toggle
- Verification Queue: My submissions / Public queue / Verified tabs, + Submit new proof CTA

Visual only: swap chunky XP window → macOS glass window. Keep all logic.

### 3.6 Games

Replace XP games folder metaphor with a macOS-style Launchpad grid (full-screen frosted overlay triggered from dock), icons for Solitaire + Minesweeper (and future Pinball). The games themselves (Solitaire, Minesweeper) keep their internal logic — ONLY wrap them in the new window chrome.

---

## 4. Copy changes

Global find-and-replace table. Do these as a single PR so nothing drifts.

| Find | Replace |
|------|---------|
| `hood.exe` | `Dockhood` |
| `hood exe` | `Dockhood` |
| `Hoodexe` | `Dockhood` |
| `HEXE` | `DOCK` |
| `$HEXE` | `$DOCK` |
| `hoodexe.site` | `dockhood.fun` |
| `@Hoodexe_` | `@dockhood` |
| `Running in Windows XP` | `Boots clean on macOS.` (or remove entirely from bio) |
| any mention of "XP desktop" / "Windows XP" in body copy | remove or replace with "Dockhood desktop" |
| any mention of "Luna Blue", "Bliss", "Tahoma" in UI copy | remove |

**Do NOT** touch:
- Variable names, class names, folder names in code (`hood/shared`, `@hood/web`, worker file names) unless the dev wants to refactor as a separate PR
- Smart contract names
- Database column names
- Event names in indexer

Those are internal; keep them to avoid regressions. The brand swap is user-facing strings only.

---

## 5. Assets checklist

Dev or designer produces these; ping back when ready and we review:

- [ ] Dockhood logo mark (SVG, light + dark variants)
- [ ] Dockhood wordmark (SVG, Inter 700 "Dockhood")
- [ ] Favicon (32×32, 16×16, apple-touch-icon 180×180)
- [ ] OG image (1200×630) with wordmark + tagline on wallpaper
- [ ] Wallpaper (webp, 2560×1440, warm sunset dune gradient)
- [ ] App icons (8 total, 128×128 PNG with transparency, rounded squircle)
- [ ] Dock bar component (reusable)
- [ ] Menu bar component (reusable)
- [ ] Window chrome component (reusable, with traffic lights)
- [ ] Dockhood "boot" splash (optional, shows briefly on first load — logo on wallpaper, 800ms fade)

---

## 6. Pages / meta

Update per page:

```html
<title>Dockhood — The launchpad that boots clean.</title>
<meta name="description" content="Dockhood. The Mathematical Superintelligence launchpad. Theorem-backed coins on Robinhood Chain.">
<meta property="og:title" content="Dockhood">
<meta property="og:description" content="The Mathematical Superintelligence launchpad.">
<meta property="og:image" content="https://dockhood.fun/og.png">
<link rel="icon" href="/favicon.ico">
<link rel="apple-touch-icon" href="/apple-touch-icon.png">
```

---

## 7. Rollout plan

**Phase 1 — build (dev)**
1. New branch `feat/dockhood-rebrand`
2. Install Inter + JetBrains Mono via @fontsource
3. Build design tokens file (`packages/shared/tokens.ts`) with the color/typography scale above
4. Build 3 reusable components: `WindowChrome`, `Dock`, `MenuBar`
5. Replace desktop page `/` with new Dockhood desktop
6. Sweep every page to use new WindowChrome + remove XP chrome
7. Global copy find-and-replace per table above
8. Add 301 redirect from legacy routes

**Phase 2 — staging QA (us)**
- Preview deploy on Vercel
- Walk every page, check for leftover XP chrome, leftover "hood.exe" strings, leftover Bliss wallpaper, leftover Tahoma
- Verify every backend call still works (launch, verify proof, submit callout, buy/sell)
- Verify $HEXE contract still resolves, just displays as $DOCK

**Phase 3 — launch**
- Point `dockhood.fun` DNS to Vercel
- Flip 301 on `hoodexe.site` → `dockhood.fun`
- Post rebrand announcement tweet from @dockhood (I'll draft separately)
- Pin new tweet, update X bio, update Pons bio

---

## 8. QA checklist (before merging)

- [ ] Zero occurrences of "hood.exe", "Hoodexe", "HEXE", "Windows XP", "Luna Blue", "Bliss", "Tahoma" in user-visible strings (`grep -r` on `apps/web/**/*.tsx`)
- [ ] Every window has traffic lights (red/yellow/green), no chunky title bars
- [ ] Dock renders at bottom center with magnify-on-hover
- [ ] Menu bar renders at top across all pages
- [ ] Inter font loads on first paint (no FOUT with Times)
- [ ] All backend endpoints respond identically to pre-rebrand (regression test suite still green)
- [ ] Pons launch flow works end-to-end on testnet
- [ ] Verification Queue admin panel functional (pause/resume submissions, payouts)
- [ ] Submit new proof flow intact
- [ ] Mobile responsive (dock collapses to simplified bar; windows become full-screen cards; menu bar stays)
- [ ] Lighthouse accessibility ≥ 90 (contrast, focus rings, keyboard nav through dock)
- [ ] 301 redirect verified from hoodexe.site/* → dockhood.fun/*

---

## 9. Timeline estimate (for planning)

Rough, assume 1 dev full-time:
- Design tokens + 3 core components: **1 day**
- Desktop page + icon set: **1 day**
- Window chrome swap across all pages: **1-2 days**
- Copy sweep + redirects + meta: **0.5 day**
- QA + fixes: **1 day**

**Total: ~5 working days** from kickoff to live rebrand.

---

## 10. What's explicitly out of scope

Do NOT touch in this PR (list for dev clarity so they don't scope-creep):

- Smart contracts
- Envio indexer schema
- Lean verifier worker
- Pons API integration code
- Fee split logic
- Fastify routes
- Database migrations
- SIWE auth flow
- RPC endpoints / chain config
- Token contract (keep CA; display only)
- Any `.env` values beyond the public `NEXT_PUBLIC_SITE_URL` and `NEXT_PUBLIC_SITE_NAME`

If any backend change is needed to support a visual thing, flag it to me first before touching.

---

**Questions for dev → Bix:** none expected; this is a UI-only sweep. Any ambiguity → ping, don't guess.
