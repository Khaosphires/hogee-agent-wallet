# DESIGN.md: Ledger and Seal

**Thesis.** A ledger that writes itself, held in check by one human mark. Ink on cool paper: quiet, exact, tabular.
Cinnabar means one thing only, that Mei signed. Cobalt means the agent acted alone, and every cobalt row names the
seal that allowed it. Every money card ends in a stub holding that seal or a tx hash.

Reference: `final.html`. Light only. **Geist Sans + Geist Mono only; no new dependency.** Motion, materials, response
and the accessibility settings follow the apple-design pass (§11, `docs/decisions/apple-design.md`). The look (grouped
canvas, the Apple type scale, layered depth, radius, tints and the ux2 primitives) follows §12
(`docs/decisions/ux2-design.md`); where an older section disagrees, §12 wins.

**Start here when building a page (ux2, ux3):** no frame of your own (the shell's, §5), one `<PageHead>`, a
`<PageSection>` per listed section, then figures as <Stat>, lists as <GroupedList> with <IconTile> rows, pockets as
<PocketRow>, small choices as <Segmented>, and cards only for things that need a frame (money cards, a chart). See
§12.5–12.9 for the recipes and rules and `/dev/ui` (dev only) for every piece rendered.

## 1. Variables (replace `apps/web/app/globals.css`)

The block as first specified, kept for its contrast notes. `app/globals.css` is canonical: §11 added the motion,
material and accessibility values, and §12 changed the canvas, surfaces, fills, line, radius, shadows and type values.

```css
@import "tailwindcss";
@import "tw-animate-css";

@theme inline {
  --font-sans: var(--font-geist-sans), ui-sans-serif, system-ui, sans-serif;
  --font-mono: var(--font-geist-mono), ui-monospace, monospace;
  --color-background: var(--canvas); --color-foreground: var(--ink);
  --color-card: var(--surface); --color-card-foreground: var(--ink);
  --color-popover: var(--raised); --color-popover-foreground: var(--ink);
  --color-primary: var(--ink); --color-primary-foreground: var(--ink-on);
  --color-secondary: var(--sunk); --color-secondary-foreground: var(--ink);
  --color-muted: var(--sunk); --color-muted-foreground: var(--ink-3);
  --color-accent: var(--sunk); --color-accent-foreground: var(--ink);
  --color-destructive: var(--blocked);
  --color-border: var(--line); --color-input: var(--line-control); --color-ring: var(--ink);
  --color-safe: var(--waiting-wash); --color-safe-foreground: var(--waiting);
  --color-finalized: var(--paid-wash); --color-finalized-foreground: var(--paid);
  --color-canvas: var(--canvas); --color-surface: var(--surface); --color-raised: var(--raised);
  --color-sunk: var(--sunk); --color-sunk-2: var(--sunk-2);
  --color-ink: var(--ink); --color-ink-2: var(--ink-2); --color-ink-3: var(--ink-3);
  --color-ink-4: var(--ink-4); --color-ink-on: var(--ink-on);
  --color-line: var(--line); --color-line-2: var(--line-2); --color-line-control: var(--line-control);
  --color-primary-hover: var(--primary-hover);
  --color-paid: var(--paid); --color-paid-wash: var(--paid-wash);
  --color-waiting: var(--waiting); --color-waiting-wash: var(--waiting-wash); --color-waiting-dot: var(--waiting-dot);
  --color-blocked: var(--blocked); --color-blocked-wash: var(--blocked-wash);
  --color-agent: var(--agent); --color-agent-wash: var(--agent-wash);
  --color-seal: var(--seal); --color-seal-ink: var(--seal-ink); --color-seal-wash: var(--seal-wash);
  --color-chart-1: var(--chart-1); --color-chart-2: var(--chart-2); --color-chart-3: var(--chart-3);
  --color-chart-4: var(--chart-4); --color-chart-5: var(--chart-5); --color-chart-neutral: var(--chart-neutral);
  --radius-sm: 6px; --radius-md: 8px; --radius-lg: 10px; --radius-xl: 14px; --radius-2xl: 20px;
  --shadow-card: var(--elev-card); --shadow-lift: var(--elev-lift); --shadow-pop: var(--elev-pop);
  /* rem on a 16 px base (apple-design): the browser's text size is respected; identical to the px look at 100% */
  --text-meta: 0.75rem; --text-meta--line-height: 1rem; --text-meta--letter-spacing: 0.01em;
  --text-ui: 0.875rem; --text-ui--line-height: 1.3125rem;
  --text-chat: 0.9375rem; --text-chat--line-height: 1.5rem;
  --text-title: 0.9375rem; --text-title--line-height: 1.25rem; --text-title--font-weight: 600; --text-title--letter-spacing: -0.011em;
  --text-page: 1.375rem; --text-page--line-height: 1.75rem; --text-page--font-weight: 600; --text-page--letter-spacing: -0.02em;
  --text-amount: 1.75rem; --text-amount--line-height: 1.1; --text-amount--font-weight: 500; --text-amount--letter-spacing: -0.03em;
  --text-hero: 2.5rem; --text-hero--line-height: 1.05; --text-hero--font-weight: 500; --text-hero--letter-spacing: -0.035em;
  --ease-settle: cubic-bezier(0.22, 1, 0.36, 1);
  --ease-stamp: cubic-bezier(0.34, 1.45, 0.64, 1);
  --animate-stamp: stamp 440ms var(--ease-stamp) both;
  --animate-bleed: bleed 260ms var(--ease-settle) 260ms both;
  --animate-rise: rise 240ms var(--ease-settle) both;
  --animate-fade-up: fade-up 220ms var(--ease-settle) both;
}

:root {
  --radius: 10px;
  --canvas: oklch(0.977 0.004 255); --surface: oklch(0.995 0.0015 255); --raised: oklch(1 0 0);
  --sunk: oklch(0.962 0.005 255); --sunk-2: oklch(0.938 0.007 256);
  --ink: oklch(0.235 0.028 262); --ink-2: oklch(0.42 0.022 260); --ink-3: oklch(0.53 0.018 258);
  --ink-4: oklch(0.72 0.012 258); --ink-on: oklch(0.985 0.003 255);
  --line: oklch(0.915 0.006 258); --line-2: oklch(0.86 0.008 258); --line-control: oklch(0.64 0.014 258);
  --primary-hover: oklch(0.31 0.035 262);
  --paid: oklch(0.52 0.105 158); --paid-wash: oklch(0.962 0.03 160);
  --waiting: oklch(0.455 0.1 80); --waiting-wash: oklch(0.968 0.045 90); --waiting-dot: oklch(0.78 0.15 80);
  --blocked: oklch(0.45 0.16 0); --blocked-wash: oklch(0.965 0.02 5);
  --agent: oklch(0.48 0.15 262); --agent-wash: oklch(0.962 0.024 262);
  --seal: oklch(0.58 0.165 45); --seal-ink: oklch(0.5 0.15 42); --seal-wash: oklch(0.968 0.024 50);
  /* validate_palette.js light, adjacent: CVD 11.8, normal 16.1, all >= 3:1 */
  --chart-1: oklch(0.59 0.11 190); --chart-2: oklch(0.5 0.14 292); --chart-3: oklch(0.61 0.11 238);
  --chart-4: oklch(0.65 0.13 76); --chart-5: oklch(0.57 0.15 352); --chart-neutral: oklch(0.66 0.014 258);
  --elev-card: 0 0 0 1px var(--line), 0 1px 2px oklch(0.235 0.028 262 / 0.05);
  --elev-lift: 0 0 0 1px oklch(0.235 0.028 262 / 0.1), 0 2px 4px -2px oklch(0.235 0.028 262 / 0.08),
    0 14px 30px -12px oklch(0.235 0.028 262 / 0.18), inset 0 1px 0 oklch(1 0 0 / 0.7);
  --elev-pop: 0 0 0 1px oklch(0.235 0.028 262 / 0.08), 0 8px 24px -8px oklch(0.235 0.028 262 / 0.22);
  --dur-press: 120ms; --dur-state: 180ms; --dur-enter: 240ms; --dur-seal: 600ms;
}

@keyframes stamp { 0% { opacity: 0; transform: scale(1.35) rotate(-12deg) } 25% { opacity: 1 }
  60% { transform: scale(0.97) rotate(-3deg); animation-timing-function: var(--ease-settle) }
  100% { opacity: 1; transform: scale(1) rotate(-4deg) } }
@keyframes bleed { 0% { opacity: 0.35; transform: scale(0.9) } 100% { opacity: 0; transform: scale(1.3) } }
@keyframes rise { from { opacity: 0; transform: translateY(6px) } to { opacity: 1; transform: none } }
@keyframes fade-up { from { opacity: 0; transform: translateY(4px) } to { opacity: 1; transform: none } }

@layer base {
  * { @apply border-border outline-ring/50; }
  body { @apply bg-background text-foreground; font-variant-numeric: tabular-nums; -webkit-font-smoothing: antialiased; }
  h1, h2, h3, h4 { text-wrap: balance; }
  p { text-wrap: pretty; }
  ::selection { background: oklch(0.235 0.028 262 / 0.14); }
  /* Reduced motion is not "everything in 1 ms" any more: see §11 (the motion tokens turn slides, scales and springs
     into short cross-fades; the seal keeps its 120 ms fade). */
}
```

§11 lists the motion, material and accessibility tokens added on top of this block.

Contrast: ink 16.4, ink-2 8.3, ink-3 5.2 (canvas, surface or sunk only), line-control 3.3. Every status colour passes
4.5 on its wash. Seal against blocked: CVD 16.2, normal 16.8.

## 2. Type, numbers, space

- **Sizes** (changed by §12): hero 44/600 (one per view), amount 28/600, page 34/700 (the large title), card title
  17/600 (the headline), chat 15/24 (62ch), UI 14, secondary 13 `ink-2`, meta 12/500 `ink-3`; the full Apple scale is
  in §12.1. Geist Mono 12.5 for hashes, seal codes and countdowns only. The figures are px at
  100%; every text size is written in `rem` (16 px base: 13 px is `text-[0.8125rem]`), so Mei's own browser text size
  is respected. Never write a text size in px.
- **Tracking is size-specific:** headings and figures tighten as they grow (title −0.012em, page −0.026em, amount
  −0.03em, hero −0.038em); body and chat 0; meta and the smallest sans text slightly open (+0.01em). Mono keeps its
  own −0.01em. `font-optical-sizing: auto` on the body.
- **Why Geist stays** (not the system font, skill §15): the same letterforms on the judges' Macs and Windows laptops,
  true tabular numerals for every money column, and a mono cut drawn to pair with it for hashes and seal codes; it is
  self-hosted, so nothing is fetched.
- **Case:** sentence case. No eyebrows, uppercase or mono labels.
- **BU:** whole BU only. The suffix is 0.72em inline, 0.56em on an amount, 0.48em on the hero; weight 500, `ink-3`,
  never coloured.
- **Numerals:** `tabular-nums` everywhere, figures included (changed by §12: a figure that counts up must not jitter). True minus (−). One decimal on %.
  Times read "19 Oct, 14:02 SGT".
- **Spacing** on a 4 px base: groups 8/12, card body gap 18, card padding 20 (16 under 640), between turns 32, rail
  sections 28.
- **Radius** (changed by §12): tags 6, small controls 8, controls and wells 12, grouped lists 14, cards 18, sheets and
  dialogs 24, pills full. A segment thumb is concentric with its track (12 − 3 = 9; 12 − 2 = 10).
- **Depth** (changed by §12): cards sit on `shadow-card` (a hairline ring, a contact shadow, a soft ambient one). **Only the card waiting on Mei is lifted**: `bg-raised` plus `shadow-lift`
  on a `::before` whose opacity fades. Never two lifted cards. No gradients or coloured side stripes. Blur exists in
  exactly one place, the floating chrome's material (§5); anything Mei reads or signs (cards, sheets, the sign dialog)
  is solid.
- **Hit areas:** 40 px or more. Use `h-10` buttons. Small 32 px buttons extend to 40 with `after:`. Tabs 44, icon
  buttons 40×40, tx links get an expanded `after:`. Focus uses shadcn `ring-ring/50` (ink).
- **Press:** every pressable thing answers on pointer-down (§11): buttons, chips, segments and nav items scale to
  `--press` (0.96), rows and cards to `--press-row` (0.985), disclosure rows and plain links dim to 0.6.

## 3. Colour jobs

- **Ink:** primary and every button.
- **Seal (cinnabar):** a completed signature, nothing else. Even the logo is an ink chop.
- **Agent (cobalt):** what the wallet did or will do alone.
- **Waiting:** only Mei can act. **Paid:** money landed. **Blocked:** refused, with the reason.
- Every pill has an icon or dot plus a word.
- Semantic colours never colour chart marks, and chart colours never colour pills.

## 4. The seal moment

**Chop:** a 40 px `rounded-md` `bg-seal` square with a white hairline 2 px inside its edge. It shows the first four
hex characters of the signing tx hash, 2 × 2, in white Geist Mono 600 at 11 px, turned −4°. At 20 px (rail, history)
and 14 px (inline) it has no characters; print the code beside it. Set `aria-hidden`.

**Sequence** after WebAuthn resolves. Transform and opacity only, 600 ms or less in total:

| Time | What moves |
|---|---|
| While the passkey prompt is open | The label cross-fades to "Waiting for your passkey…" and the fingerprint breathes in opacity. This is the only loop. |
| 0 ms | The chop runs `animate-stamp` (440 ms): scale 1.35 → 0.97 → 1, rotate −12° → −3° → −4°. |
| 260 ms | The chop `::after` runs `animate-bleed`: opacity 0.35 → 0, scale 0.9 → 1.3. |
| 300 / 360 ms | The signer line, then the tx link, run `animate-fade-up`. |
| 0–600 ms | The lift layer fades out, and the pill cross-fades from Waiting on you to Signed. |
| After | The payment card runs `animate-rise`. |

With reduced motion, the chop fades in over 120 ms, its bleed and the signer/tx lines stay still, and the
fingerprint stops breathing. It plays only on a live transition to signed, never when history renders.

## 5. Shell

(Rewritten in UX round 3: the side nav replaced the top nav and its menu sheet in UX round 2, and the quick settings
replaced the Demo button. Code: `components/shell/*`, `components/settings/quick-settings.tsx`, `app/shell.css`.)

- **Side nav (from 900 px):** a fixed 248 px sidebar on the left in the sidebar material (a step heavier than the top
  bar's: structural chrome reads darker), with the brand (ink chop "H") at the top, the persona's pages, and
  **Settings pinned at the foot** under an inset hairline. Founder: Chat (home), Wallet (`/dashboard`), Plan. Officer:
  Loan officer (home), Wallet, Proof (Checks and Activity record). Suppliers left the nav; founders and judges reach
  Proof from the quick settings and the footer.
- **Rows:** 40 px, a 24 px `IconTile` (`size="sm"`: cobalt for Chat, green for Wallet, neutral ink or grey for the
  rest) and the label; the current page is a raised white pill. Each page with sections has its own disclosure button
  (32 px to see, 40 to hit) that drops down the page's sections (`lib/sections.ts`; Proof drops down its two
  sub-pages). The current page's list starts open; **opening another page's list closes any other except the current
  page's.** A guide hairline runs down the list, and one ink marker slides (transform only) to the section in view
  (`aria-current="location"`, from an IntersectionObserver scroll-spy). When the lists are taller than the room above
  Settings, the nav scrolls and the side with more fades out (a scroll edge, `data-more`), and an opened list is
  scrolled into view inside the nav (never the page).
- **Under 900 px:** no sidebar. The top bar holds the drawer button (top left), the brand and the quick settings; the
  same nav opens as a solid drawer from the left (48 px rows, 44 px section rows) that slides in and out the same way
  and closes after any choice.
- **Top bar:** 56 px, sticky, in **the material**: surface at 72 % with `blur(20px) saturate(180%)` and a bright 1 px
  top edge (`--material-highlight`), with content scrolling under it. No permanent line: the **scroll edge** (a
  hairline plus an 8 px soft shade, `scroll-edge`) appears only while content is under the bar (`data-scrolled` on
  `<html>`, from an IntersectionObserver in `shell/top-bar.tsx`). It holds only the **quick settings** at the top
  right (and, under 900 px, the drawer button and the brand).
- **Quick settings** (`demo-menu`, `demo-menu-panel`): the founder's avatar and first name (the officer's tile and
  title) and a chevron; a canvas popover that grows from the button: who is viewing with the data label (`mode-badge`,
  "Sample data" in a demo), View as (the persona radios; the officer needs the access code, and a demo says where it
  is printed, never the code), Sample business, Recording mode, For reviewers: Proof (`demo-menu-proof`), All
  settings. Built from the §12 primitives with the neutral settings tiles.
- **The page frame** (`ShellFrame`, `PAGE_FRAME`): the shell owns it, so every page's title starts on the same left
  edge (280 px at 1280 and 1440 with the sidebar, 16 px on a phone). Pages add no max-width, centring or side padding
  of their own. The width is one variable, `--page-max` on `:root` in `app/shell.css`, `none` for now: the frame runs
  from the side nav to the right edge, and stays anchored to the side nav if a cap is ever set. The user chose the
  **bento** layout (§12.10): pages fill that width as a grid of cards rather than a narrow column with empty sides.
- **Footer:** one line, "Amounts are in BU (budget units). What's a BU?", with the rest of the BU disclosure behind
  that press (a native `<details>`, `bu-note`), and "Proof (for reviewers)" (`footer-proof`) on the right. On `/chat`
  the BU line moves into the rail foot.
- **Skip link:** "Skip to content" is the first Tab stop on every page, hidden until focused; it moves focus to the
  page's `<main id="main">`.
- **Section jumps** (a side-nav section, `#section` in the address, or `SECTION_JUMP_EVENT`): smooth scroll (instant
  under reduced motion) to the section clear of the top bar, focus moves into it, and **the highlight starts only once
  the jump has landed** (`scrollend`, or 700 ms with no word from the browser, and the page still for 100 ms, 200 ms on
  a page that has just opened). If the page grows under the scroll (data and charts landing), the scroll re-aims at
  once; if it ended short, it scrolls again; it keeps correcting for up to 1.5 s and keeps the section in place while
  it glows. A wheel, touch or scroll key from the person ends the steering (trackpad momentum in the first 600 ms after
  the click doesn't count). The highlight: ink 6 % wash, a 2 px ink ring at 35 % and an 8 px halo at 12 %, in over
  150 ms, held 900 ms, faded over 400 ms; reduced motion keeps a short still tint (ring only) for 1 s.
- **Why a material, and where not** (changed from "no blur"): floating chrome that stays put while the page moves
  should read as a layer above the page, not a strip cut out of it. The rule: the material is only for floating chrome
  (the sidebar, the top bar, the phone wallet strip, the chat composer). Never one material on another. Cards, sheets,
  dialogs, the phone drawer and anything Mei reads to sign stay solid, legibility first. With
  `prefers-reduced-transparency` the material is solid with no blur; with `prefers-contrast: more` it is solid raised
  with a `line-control` edge that always shows.

## 6. Chat home

- **From 1100 px:** a thread (content 640) plus a sticky 336 px **wallet rail**, which holds:
  - BU left (hero) and the stage line;
  - **Waiting on you** (waiting-wash rows with a dot);
  - **What the agent can spend**: a 6 px meter per signed line, with paid `ink-2`, agent next cobalt-hatched, waits
    for you saffron-hatched (45°), 2 px gaps, the track as the limit, and a legend;
  - **Your seals**;
  - "Pause the agent".
- **Under 1100 px:** a sticky strip (the Next step and a Wallet button) in the same material as the bar, directly
  under it, opens the rail as a bottom sheet; on this page the scroll edge belongs to the strip, not the bar. The
  sheet drags (§11).
- **Thread head:** a lock-icon trust line, "…The wallet can't pay anyone or anything outside what you signed."
  History folds into one row with the chop and tx.
- **User turns:** `bg-sunk`, 1 px line, radius 16/16/4/16, at most 84% wide.
- **Hogee turns:** a byline (name, `ink-3` time) over unboxed prose. Agent turns start with a cobalt "Agent" badge;
  CFO turns are labelled "Hogee CFO".
- **Composer:** floats in the material (radius 16, `line-2` ring, ink ring on focus, the bright top edge, `shadow-pop`),
  docked at the bottom from the first message (the column is at least a screen tall), so it never moves as cards
  arrive. Its scroll edge, a canvas fade behind it, shows only while there is thread under it. It grows to 6 lines.
  The 40 px primary send button becomes Stop while streaming. The Next step bar above it stays solid `bg-raised`
  (it is read, not glanced at); a new step's line fades in where the old one was.
- **Arrivals:** a message, an action line, or a card that arrives while the page is open rises 6 px and fades in on
  the default spring (`enter-rise`); history never animates.

## 7. Cards

**Shell:** `rounded-xl bg-surface shadow-card p-4 sm:p-5`, with a title, a 13 px sub and at most one pill. **Info
cards** end at the body. **Money cards** (needs, terms, order, payment, `data-sign`) end in the **stub**: a full-bleed
`bg-canvas` foot with a dashed `line-2` top edge and a 14 px notch at each end. The stub is never empty:

- **Pending:** "**What you're signing:** …" in one sentence, a primary 44 px "Sign with passkey", and a ghost "Change
  something".
- **Signed:** chop, "Signed by Mei with a passkey", time, "seal C21E", tx link. The page cannot know which authenticator
  signed (Touch ID, a phone, a security key), so the seal never names one; with no name known it reads "Signed with a
  passkey".
- **Paid:** "Payment record", line usage, tx link. Before the tx exists, say when it will appear.

Card by card:
- **Needs:** "AI-drafted · check before you sign".
  - Registrations: a paid check or an `ink-4` circle, who acts, and the fee.
  - Budget: an allocation bar with 2 px gaps (Supplier `chart-1`, Packaging 2, Logistics 3, Ads 4, Platform fees 5,
    Buffer neutral), then rows of swatch, name, rule beneath, amount.
  - v2 rows: waiting-wash tint, a `+300` tag, the struck old value.
  - Tax reserve in a sunk box.
- **Sign:** renders as the stub of its card.
- **Next actions:** 1 to 4 `rounded-full` 40 px secondary buttons that all disable once one is pressed.
- **Search status:** step text, "Reading pages (14) → Checking → Ranking", with ticks and no spinner. READY collapses
  to "Search finished · 38 pages read · 3 kept · 1 left out". FAILED shows the error state plus "Use the supplier
  list".
- **Candidates:**
  - Each row: mono rank, name, an outline "Unverified web supplier" pill, and the listing age.
  - Metrics (2 or 4 columns): Landed cost (each, plus total), Minimum order, Lead time, Evidence "8 of 9 sourced".
  - A red flag is blocked text with an icon and the reason. A cap breach shows a blocked-wash box with an octagon:
    "**Over your line.** …the wallet would refuse it."
  - A sunk shield row: "1 page left out: it contained instructions aimed at the AI." A web string that fails
    `checkText` shows "(name hidden)".
- **Enquiry:** a letter well, `copy-button`, and "Hogee never sends messages."
- **Terms:**
  - The split is a `RadioGroup` styled as a segment. A preset that breaks a cap is disabled and struck, and its reason
    is printed below.
  - Payout account: a REST form, then read-only with a name check.
  - Milestones carry an **Agent pays** pill (cobalt, bot icon) or a **You release** pill (waiting, user icon), the
    condition and the amount.
  - Totals: the line left, and what the agent can pay without you.
- **Order / payment** (Agent byline): amount 28, then a `stepper` Signed → Cooling → Paid.
  - Cooling: "Pays automatically in 7:42" (`countdown`), "Stop this payment", a 4 px cobalt bar on one linear
    `scaleX` transition, and "The loan officer can also stop it during cooling."
  - Paid: an agent note (agent-wash): "**Paid automatically under your seal** ▢ C21E. It could not pay a different
    amount, a different account, or the balance before you release it."
- **CFO:** the title is the finding with its figure. At most 2 sentences, 1 or 2 actions plus "Open CFO", and the
  disclaimer every time. A proposed change becomes a needs card.

## 8. CFO page

- **Head:** "CFO" and "Estimates from your own records. Not financial advice."
- **Controls:** a period segment, then underline tabs (44 px, a 2 px ink indicator on `scaleX`): Overview, Spending,
  Sales, P&L, Forecast, Tax reserve.
- **P&L is the bridge,** a horizontal waterfall in plain HTML/CSS:
  - Sales and Net use `chart-1`; costs use `chart-neutral`. Bars are 16 px, rounded 4 px on the value end, with
    hairline gridlines at 0, 50 and 100%.
  - Amounts are tabular, with "% of sales" from 640 px. On phones the bar goes under the label.
  - Rows are a focusable `role="table"` with a tooltip, so no extra table is needed.
  - Side: the net hero, facts, a CFO note (sunk), and agent actions (agent-wash, tx).
- **Other charts:** recharts via `next/dynamic({ ssr: false })` behind fixed-height skeletons; `/chat` ships none.
  - Slots follow the line, never its rank. Bars 24 px or less with a 4 px top radius and 2 px gaps. Lines 2 px.
    Forecast dashed with a hatched band. Markers 8 px with a surface ring.
  - A legend from 2 series. A crosshair tooltip. "Show as table".
  - Forecast states its method and sample size; under 3 days of data, show the empty state.

## 9. Tables, pills, states

- **Tables:** 12 px `ink-3` headers, 44 px rows on hairline separators, tabular numbers on the right, totals at 600.
  On the canvas, `<Table grouped>` makes it an inset grouped list.
- **Pills:** 24 px.
  - Capsules, 12 px semibold: Waiting on you (dot), Signed (ink fill), Paid, Agent pays and Cooling (cobalt), Blocked
    (octagon).
  - Unverified and Sample data are outline pills.
  - Tags (20 px) hold `+300` and "AI-drafted".
- **Loading:** `sunk-2` skeletons with a slow light sweep (still under reduced motion) plus one status line. **Empty:** an icon, a title, one sentence, one action.
- **Error:** what didn't happen, "Nothing was paid or changed" when true, then retry and the fallback.

## 10. Do and don't

**Do**
- Say "Sign" for the act and "seal" for the mark.
- Give every money card a stub, and name the seal in every agent row.
- Use one lifted card, and whole BU.
- Validate new chart colours.
- Press scale 0.96 on buttons.

**Don't**
- Use cinnabar except for a signature.
- Use solid coloured buttons (a tint is fine: `tinted`, `destructive`), eyebrows, side stripes, serif, gradients (the
  skeleton's sweep is the one exception) or guilloché; or the material on anything but floating chrome, or one
  material on another.
- Animate an amount except a <Stat> counting up once on first view (`tick`, never after a change the person made);
  loop anything but the passkey wait and the skeleton sweep; or animate anything except transform and opacity (`scale`
  and `translate` count as transform).
- Use `@keyframes` for anything a person can reverse (open, close, drag): use transitions or a spring (§11).

## 11. Motion, response and the accessibility settings (apple-design)

From the apple-design skill (Apple's WWDC talks on fluid interfaces, translated to the web); the reasons and what was
left out are in `docs/decisions/apple-design.md`.

- **Springs, not durations.** Two numbers: damping (1.0 = no bounce) and response. `--ease-spring` is a critically
  damped spring sampled into CSS `linear()`; `--dur-spring-fast` (410 ms) is response 0.3 for dialogs, popovers,
  menus and the scrim; `--dur-spring` (540 ms) is response 0.4 for sheets and live arrivals. The curve is front-loaded:
  a surface is about 95 % there at a third of that time. Bounce (damping 0.8, response 0.3) only after a momentum
  gesture, and only in the phone sheet (`components/ui/sheet-physics.ts`).
- **Interruptible.** Opening and closing are transitions (`pop-surface`, `scrim`, `enter-rise`, `enter-fade`), never
  keyframes: enters start from `@starting-style`, exits go back the same way, and a re-open mid-exit turns around from
  what is on screen. Radix keeps a closing surface mounted while a no-op `presence-hold` animation runs as long as the
  exit. The chat's ⋯ menu uses `lib/use-exit-presence.ts` for the same.
- **Origins.** Popovers, menus and selects grow from their trigger (`origin-(--radix-…-transform-origin)`, the ⋯ menu
  `origin-top-right`); dialogs from their centre at 0.96; the menu sheet comes down from the top bar and goes back up;
  the wallet sheet comes up from the bottom and goes back down.
- **The phone sheet** (`SheetContent side="bottom"`): drag it by the grab handle or the header, never by its scrolling
  body. It tracks 1:1 from where it was grabbed (Pointer Events with capture), rubber-bands above open (`rubberband`,
  c = 0.55), and on release a flick (≥ 400 px/s) is decided by its direction, a slow release by where its momentum
  projects it (`project`, d = 0.998) against half the sheet. The spring then starts from the live position at the
  finger's velocity. The scrim dims with how much of the sheet is up. Esc, Close and the scrim still close it, along
  the same path. Grabbing it mid-flight catches it.
- **Response.** A press shows on pointer-down (`--press`, `--press-row`, a dim for rows and links); `touch-action:
  manipulation` removes the phone tap delay. Nothing on the input path waits on a timer.
- **Reduced motion** (`prefers-reduced-motion: reduce`): the tokens turn every slide, scale and spring into a short
  opacity cross-fade (`--dur-spring` 200 ms, `--dur-spring-fast` 160 ms, `--rise` 0, `--pop-scale` 1, `--sheet-from`
  0 %, `--press` 1 with a dim instead). The phone sheet cross-fades and never springs; a drag still moves it (the
  person is moving it), and on release it is back at once or fades out. Smooth scrolling stops. The seal keeps its
  120 ms fade.
- **Reduced transparency** (`prefers-reduced-transparency: reduce`): the material is solid surface, no blur.
- **More contrast** (`prefers-contrast: more`): the material is solid raised, its edge `line-control` and always shown;
  `ink-2`, `ink-3`, `ink-4`, `line` and `line-2` darken.

## 12. The look: grouped canvas, Apple type, depth, tints and the ux2 primitives (ux2-design)

The visible half of the apple-design pass (§11 was the feel). Think Apple Wallet plus iOS Settings in the Ledger and
Seal palette: a faint grey canvas, solid white groups and cards on it, one big title, big tabular numbers, small quiet
labels, colour that means something. Reasons and what was skipped: `docs/decisions/ux2-design.md`. Every piece is
rendered on `/dev/ui` (dev only, `DEMO_MODE=1`).

### 12.1 Type scale

All in `rem` (16 px base). Size, leading, weight and tracking move as a set: the bigger the size, the tighter the
leading and the tracking. `cn()` knows every name (`lib/utils.ts`), so a colour class next to one never drops it.

| Utility | Size / leading | Weight | Tracking | Use for |
|---|---|---|---|---|
| `text-large-title` (= `text-page`) | 34 / 40 | 700 | −0.026em | the page's one title |
| `text-hero` | 44 / 1.05 | 600 | −0.038em | the one figure a view leads with |
| `text-title-1` | 28 / 34 | 700 | −0.022em | a big figure in a card (<Stat size="md">) |
| `text-amount` | 28 / 1.1 | 600 | −0.03em | a payment card's amount |
| `text-title-2` | 22 / 28 | 600 | −0.018em | a section heading on a long page |
| `text-title-3` | 20 / 25 | 600 | −0.015em | dialog titles, a small figure |
| `text-headline` (= `text-title`) | 17 / 22 | 600 | −0.012em | card titles, the one line that matters in a block |
| `text-body` | 16 / 24 | 400 | −0.003em | longer reading |
| `text-callout` (≈ `text-chat`) | 15 / 21 | 400 | 0 | list row titles and values, chat |
| `text-subhead` (≈ `text-ui`) | 14 / 20 | 400 | 0 | controls, dialog descriptions |
| `text-footnote` | 13 / 18 | 400 | +0.003em | labels above figures, row subtitles, group headers and footers |
| `text-caption` (≈ `text-meta`) | 12 / 16 | 400 | +0.01em | table headers, chart labels, capsules |
| `text-caption-2` | 11 / 13 | 500 | +0.02em | the number inside a ring, tiny tags |

Pair them by job, not by habit: a page is `large-title` → (figures in `hero`/`title-1`) → `headline` card titles →
`callout` rows → `footnote` labels. Emphasise with weight before size.

### 12.2 Colour

- **Canvas** `oklch(0.964 0.005 262)` (#F1F3F7, like systemGroupedBackground). **Surface and raised are white.** A card
  or a grouped list reads as a sheet on the canvas without a border.
- **Fills** (ink at low alpha, so they read the same on white and on the canvas): `bg-fill` (4.5 %) for hover, filled
  fields and quiet tracks; `bg-fill-strong` (8.5 %) for pressed, segment tracks, progress tracks, the Signed capsule.
- **Separator** `--separator` (ink 10 %): the hairline between rows (`border-separator`, or
  `shadow-[inset_0_-1px_0_var(--separator)]` when it must not take space). Inside a grouped list it starts where the
  text starts, past the icon tile.
- **Tones** (`components/ui/tones.ts`), each with four forms: `solid` (fill under a white glyph, ≥ 3:1), `tint` (13 %
  fill: `bg-tint-*`), `ink` (glyph or figure on its tint, ≥ 4.5:1 on white and canvas: `text-slot-N-ink`) and `stroke`.

| Tone | Means | Solid | Tint | Ink |
|---|---|---|---|---|
| `slot-1` … `slot-5`, `slot-neutral` | a pocket (always `slotTone(LINE_SLOT[key])`, never its rank) | `bg-chart-N` | `bg-tint-N` | `text-slot-N-ink` |
| `paid` | money in, landed | `bg-paid` | `bg-tint-paid` | `text-paid` |
| `agent` | the wallet acted alone | `bg-agent` | `bg-tint-agent` | `text-agent` |
| `waiting` | only you can act | `bg-tile-waiting` | `bg-tint-waiting` | `text-waiting` |
| `blocked` | refused | `bg-blocked` | `bg-tint-blocked` | `text-blocked` |
| `seal` | **Mei's signature only** | `bg-seal` | `bg-tint-seal` | `text-seal-ink` |
| `ink`, `grey` | neutral (settings, receipts, profile) | `bg-ink`, `bg-chart-neutral` | `bg-tint-ink`, `bg-tint-neutral` | `text-ink`, `text-slot-neutral-ink` |

- Contrast (computed, oklch → sRGB): ink-3 on canvas 4.75, on sunk 4.53; a white glyph on every solid tone 3.1 to 8.1;
  every `ink` form on its tint 4.5 or more. Status colours on their washes are unchanged (§1).
- Chart colours still never colour pills; a pocket's tile, ring, bar and swatch all use its slot.

### 12.3 Depth

Every shadow is a hairline ring (alpha, so it works on any surface), a tight contact shadow and a soft ambient one
that grows with height. Surfaces stay solid; blur is still only the floating chrome's material (§5).

| Utility | Use for |
|---|---|
| `shadow-sm` | controls on a surface: secondary buttons, a segment thumb, a radio card |
| `shadow-card` | a card or a grouped list on the canvas |
| `shadow-md` | something raised above its card (a hovered tile, a floating summary) |
| `shadow-lg` | the one lifted card (`shadow-lift` adds a top highlight), a floating panel |
| `shadow-pop` | popovers, menus, dialogs, sheets |

Under `prefers-contrast: more`, `shadow-card` becomes a `line-2` ring and `shadow-sm` a `line-control` ring.

### 12.4 Radius

Not uniform: the bigger and further back a surface, the rounder.

| Utility | px | Use for |
|---|---|---|
| `rounded-sm` | 6 | tags |
| `rounded-md` | 8 | small (32 px) controls |
| `rounded-lg` = `rounded-control` | 12 | buttons, fields, wells, segment tracks |
| `rounded-group` | 14 | grouped lists, `<Table grouped>` |
| `rounded-xl` = `rounded-card` | 18 | cards (the stub's corners follow) |
| `rounded-2xl` | 20 | the chat composer and Next step bar |
| `rounded-sheet` | 24 | dialogs and sheets |

Nested surfaces stay concentric (outer = inner + padding): a thumb in a 12 px track with 2 px padding is 10.

### 12.5 Primitives

| Primitive | Use for | Not for |
|---|---|---|
| `<Button variant>` `default`/`filled`, `tinted`, `secondary`/`outline`, `plain`, `ghost`, `destructive`, `link`; sizes `sm`, `default`, `lg`, `xl`, `icon`, `icon-sm` | one filled action per view; `tinted` for the second; `plain` in toolbars and row actions; `destructive` (blocked tint) for stop, pause, reject | a solid coloured button |
| `<IconTile icon tone size variant>` (`ui/icon-tile.tsx`) | the leading mark of a row, a stat or a pocket; `solid` in lists (iOS Settings), `tinted` when several sit together | a button (it is decorative unless `label`) |
| `<GroupedList header footer>` + `<ListRow leading title subtitle value trailing href/onClick>` (`ui/grouped-list.tsx`) | anything listed: pockets, payments, receipts, activity, settings, checks; `inset={false}` inside a card | a paragraph of explanation |
| `<Segmented items value onValueChange aria-label>` (`ui/segmented.tsx`) | a small choice that filters what is on screen: a period, All / In / Out | switching whole panels (use `<Tabs>`) or navigation |
| `<Stat label minor/value unit size delta note leading tick>` (`ui/stat.tsx`) | every figure with a label: a quiet label, a big tabular number, a smaller unit, one line under it | figures in running text (use `<Money>`) |
| `<ProgressRing value tone label>` and `<Progress value tone>` (`ui/progress.tsx`) | how much of a pocket is used, a goal reached; rings in a row of pockets, bars in a row | an amount that must be read exactly (say the number too) |
| `<Tabs>` (segment look by default; `variant="underline"` still there) | panels of one page | page sections (the side nav scrolls to them) |
| `<Table grouped>` | a table on the canvas | a table inside a card (leave `grouped` off) |
| `<Skeleton>` | loading shapes (they shimmer; still under reduced motion) | anything that has loaded |
| Fields (`Input`, `Textarea`, `SelectTrigger`) | filled, white with an ink edge and halo on focus, blocked tint when invalid | |

### 12.6 Recipes

```tsx
// A page head and its sections (ui/page-section.tsx): the large title, one short line, an optional control; then a
// PageSection per id in lib/sections.ts (the side nav jumps to them), each with the 22 px heading.
<PageHead title="Wallet" line="Sample business · updated 2 min ago" aside={<Segmented … />} />
<PageSection id="wallet-spending" title="Spending" line="Last 30 days, by pocket.">…</PageSection>

// Figures: the hero first, then two or three smaller ones.
<Stat label="Ready to spend" minor={free} size="hero" tick />
<Stat label="Sales this week" minor={sales} delta={{ text: "+18% on last week", trend: "up", upIsGood: true }} />

// Pockets: a tile in the pocket's colour, the rule as the subtitle, the amount, a ring or a chevron.
<GroupedList header="Pockets" footer="Your wallet pays only from these, up to their limits.">
  {lines.map((l) => (
    <ListRow key={l.key} leading={<IconTile icon={POCKET_ICON[l.key]} tone={slotTone(LINE_SLOT[l.key])} />}
      title={l.label} subtitle={l.rule} value={<Money minor={l.capMinor} />}
      trailing={<ProgressRing value={l.usedPct} tone={slotTone(LINE_SLOT[l.key])} size={28} stroke={3} label={`${l.label}: ${l.usedPct}% used`} />} />
  ))}
</GroupedList>

// Activity: what happened, when ("2 h ago"), the amount; cobalt tile when the wallet acted alone.
<ListRow leading={<IconTile icon={Bot} tone="agent" />} title="Deposit paid automatically"
  subtitle="Under your seal · 2 h ago" value={<Money minor="75000" />} />
```

Suggested pocket icons (lucide): Supplier `Factory`, Packaging `Package`, Delivery `Truck`, Ads `Megaphone`, Marketplace
fees `Store`, Safety buffer `ShieldCheck`, Licensing `BadgeCheck`; money in `ArrowDownLeft`, agent `Bot`, waiting on
you `UserRound`, signed `Fingerprint` (seal tone), receipts `ReceiptText`, tax `Landmark`.

### 12.7 Accessibility

- **Filled fields** have no 3:1 box at rest (the iOS look): the label is always shown above, the fill and a faint
  inner edge mark the field, and focus is unmistakable (white, ink edge, ink halo). `prefers-contrast: more` restores
  the `line-control` edge. An invalid field is tinted and edged in blocked.
- **IconTile** is `aria-hidden` unless given `label`; the row's words carry the meaning.
- **Segmented** is a radio group (arrow keys move and choose); **ProgressRing** a `meter` with a name that states the
  number; **ListRow** marks the current item with `aria-current`.
- **Stat `tick`** counts once, on first view, for 900 ms; with reduced motion it never counts; while counting the
  moving digits are hidden from assistive tech and the final figure is read.
- **Skeleton** sweeps only with motion allowed.

### 12.8 From the old look (for the polish pass)

| Was | Now |
|---|---|
| a loose block of label + sentence per item | `<GroupedList>` of `<ListRow>`s with a tile, a title and at most one subtitle |
| `rounded-xl bg-card p-4 shadow-card` + `text-[0.8125rem] text-ink-2` label + `text-[1.375rem]` figure | `<Card>` (or none) + `<Stat>` |
| a 10 px colour swatch before a pocket name | `<IconTile icon tone={slotTone(slot)}>` (or keep the swatch where space is tight) |
| `<Tabs>` underline for a filter | `<Segmented>` |
| `<ToggleGroup>` for a small single choice | `<Segmented>` when the options are of similar length (ToggleGroup stays for the persona and country switches) |
| `bg-sunk` hover / pressed | `hover:bg-fill active:bg-fill-strong` |
| `border-line` between rows | `border-separator` (or the inset shadow) |
| `<PageHeader>` (`shell/page-header.tsx`) | `<PageHead>` (`ui/page-section.tsx`); the old name is a thin, deprecated alias |
| a page-local section wrapper (`WalletSection`, `PlanSection`, `SettingsSection`) | `<PageSection id title line aside>` |
| a page-local max-width or `mx-auto` wrapper | nothing: the shell's frame sets the width and the left edge (§5) |
| a local pocket row and ring | `<PocketRow>` (`ledger/pocket-row.tsx`), the same on every page (§12.9) |

### 12.9 One app (UX round 3)

The pages were built separately and looked like separate products; round 3 makes them one app with these rules.

- **One frame, one head, one section.** The shell owns the frame (§5); every page starts with `<PageHead>` (the
  34 px large title, at most one short line, an optional control on the right) and every section the side nav lists is
  a `<PageSection>` (22 px `text-title-2` heading, an optional 13 px line). No page-local title or section wrappers.
- **One pocket row.** `<PocketRow>` and `POCKET_ICON` (`components/ledger/pocket-row.tsx`) everywhere a pocket is
  listed: the value is "X BU left", the subtitle "of Y", and the ring fills as money goes out. A pocket reads the same
  on the chat rail, the Wallet and the Plan.
- **One word for made-up data: "Sample".** The data label in a demo is "Sample data" (`modeLabel`, the quick settings
  and Settings › Demo); the switch is "Sample business"; figures say "Sample". One page-level label where a page is all
  sample; per-figure tags only where real and sample figures sit side by side; the labels always show, recording mode
  included. Never "practice", "simulated", "mock" or "demo data" on screen. "AI-drafted" only in the chat header and on
  the plan card.
- **Neutral settings tiles.** Pocket colours are only for pockets. Settings, the quick settings and other system rows
  use the neutral tones: `grey` for what is about you and this device (profile, business, demo), `ink` for security
  (the passkey, what you signed, how the money is kept safe). On the Settings page every row has a tile (a field row
  too); an action in a group of its own (reset, go back) is a button with no tile, as in iOS. Rows `ListRow` can't hold
  (a text field, the colour swatches, View as) use `SettingRow` (`components/settings/settings-rows.tsx`), which has
  ListRow's anatomy.
- **Rows that can't be pressed don't look like rows.** A fact with nothing to change is a line under the section
  heading (Settings › Display: "Text size, motion and transparency follow your device settings."), not a list of
  label/value rows.
- **Targets.** Every control is at least 44 px to hit (swatches 44, persona segments 34 to see and 44 to hit, the
  footer's links 44 tall).
- **Say a state plainly.** Something not set up yet is "Not set up yet", not "Not on this device"; a passkey made on
  another device is "On your signing device".

### 12.10 Bento: pages fill the width (UX round 3, the user's choice)

The user disliked the empty space at the sides of a centred column and chose "A, the bento grid, across all pages":
each page fills the frame (§5) beside the side nav as a grid of cards of different sizes. `app/bento.css` (from the
`lay-bento` prototype, copied byte for byte on every branch; don't edit it locally), imported once from `globals.css`
under `shell.css`.

- **The container.** A page's root is `bento` (`container: bento / inline-size`), so the tiers follow the content's
  width, not the window's: the 248 px side nav never miscounts.
- **The grid.** `bento-grid` is 12 equal columns, a 20 px gap (24 px from 1600 px). Every cell spans the whole row
  until a tier gives it a span: `bm-1`…`bm-12` from 56 rem of content (a 1280 window: about 2 across), `bl-*` from
  68 rem (1440: about 3), `bx-*` from 92 rem (1920: about 4). Under 56 rem (phones, a narrow window) it is one column.
- **Helpers.** `bento-cell` makes a section fill its row (its heading keeps its size, its first block takes the rest,
  so the cards in a row end on one line); `bento-list` lets a list grow to the row's height with its "Show all" under
  it; `bento-dense` lets a later card fill a hole a wider one left; `bento-columns` flows a page's groups into
  balanced columns (2 from 56 rem, 3 from 68 rem; Settings uses it so the whole page fits one screen at 1440);
  `bento-six` puts six pockets in one row at 92 rem.
- **Rules.**
  - On-screen order is the side nav's order (lib/sections.ts): read top to bottom, then left to right (a dense grid
    must not move a section ahead of one listed before it; check when you use `bento-dense`).
  - No stretched empty blocks: a cell is as tall as its row only when its content can use the height (a list, a
    chart); otherwise give it a span that fits what it holds, or let a neighbour fill the hole.
  - Text keeps its measure inside a card (`max-w-[60ch]`–`[68ch]` on paragraphs); a wide card never means a 200
    character line.
  - Phones (and anything under 56 rem of content) are one column in DOM order, exactly as before.
  - Cards, groups, tiles and the type scale are §12's; bento only decides where they sit.

