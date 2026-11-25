---
name: e2e_assistant Web Workbench
description: A precise, calm workbench that turns structured E2E test intent into reviewable Playwright code.
colors:
  action-green: '#0c703e'
  review-blue: '#3b82f6'
  ink-deep: '#0f172a'
  ink-body: '#334155'
  ink-muted: '#64748b'
  canvas-cool: '#f8fafc'
  surface: '#ffffff'
  surface-subtle: '#f1f5f9'
  border-cool: '#e2e8f0'
  warning: '#f0a020'
  danger: '#d03050'
  code-shell: '#0b1120'
typography:
  headline:
    fontFamily: "Inter, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif"
    fontSize: '28px'
    fontWeight: 700
    lineHeight: 1.25
    letterSpacing: 'normal'
  title:
    fontFamily: "Inter, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif"
    fontSize: '18px'
    fontWeight: 600
    lineHeight: 1.4
    letterSpacing: 'normal'
  body:
    fontFamily: "Inter, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif"
    fontSize: '14px'
    fontWeight: 400
    lineHeight: 1.6
    letterSpacing: 'normal'
  label:
    fontFamily: "Inter, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif"
    fontSize: '12px'
    fontWeight: 400
    lineHeight: 1.5
    letterSpacing: 'normal'
  code:
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, 'Courier New', monospace"
    fontSize: '14px'
    fontWeight: 400
    lineHeight: 1.5
    letterSpacing: 'normal'
rounded:
  control: '3px'
  brand: '8px'
  compact-container: '10px'
  panel: '12px'
  soft-container: '16px'
  composer: '18px'
  feature-card: '20px'
spacing:
  xs: '4px'
  sm: '8px'
  md: '12px'
  lg: '16px'
  card: '18px'
  section: '20px'
  page: '24px'
components:
  button-primary:
    backgroundColor: '{colors.action-green}'
    textColor: '{colors.surface}'
    typography: '{typography.body}'
    rounded: '{rounded.control}'
    padding: '0 14px'
    height: '34px'
  button-primary-hover:
    backgroundColor: '#0c7a43'
    textColor: '{colors.surface}'
  button-primary-active:
    backgroundColor: '#095f35'
    textColor: '{colors.surface}'
  button-secondary:
    backgroundColor: '#0c703e1f'
    textColor: '{colors.action-green}'
    typography: '{typography.body}'
    rounded: '{rounded.control}'
    padding: '0 14px'
    height: '34px'
  input-standard:
    backgroundColor: '{colors.surface}'
    textColor: '{colors.ink-body}'
    typography: '{typography.body}'
    rounded: '{rounded.control}'
    padding: '0 12px'
    height: '34px'
  nav-item-active:
    backgroundColor: '#0c703e1a'
    textColor: '{colors.action-green}'
    typography: '{typography.body}'
    rounded: '{rounded.control}'
    height: '42px'
  skill-card:
    backgroundColor: '{colors.surface}'
    textColor: '{colors.ink-body}'
    rounded: '{rounded.feature-card}'
    padding: '18px'
  chat-composer:
    backgroundColor: '{colors.surface}'
    textColor: '{colors.ink-body}'
    rounded: '{rounded.composer}'
    padding: '8px 10px 8px 14px'
  editor-card:
    backgroundColor: '{colors.surface}'
    textColor: '{colors.ink-body}'
    rounded: '{rounded.panel}'
    padding: '18px'
---

# Design System: e2e_assistant Web Workbench

## Overview

**Creative North Star: "The Verification Bench"**

e2e_assistant is a calibrated workbench for turning structured test intent into an inspectable technical artifact. The interface is precise, calm, and capable: dense enough for real E2E work, approachable enough for test engineers, and explicit about every consequential state. Visual hierarchy comes from alignment, tonal surfaces, typography, and state clarity rather than decoration.

The system follows a restrained product strategy. Familiar controls and compact spacing keep attention on the case-to-code workflow. Chinese interface copy leads, while established technical terms such as Skill, API, Agent, and Playwright remain untranslated when they are clearer. The Agent behaves like a capable collaborator inside the workbench, never like a mascot or the visual centerpiece.

The system explicitly rejects generic SaaS dashboards, playful AI chatbot styling, and flashy cyber aesthetics. It must never resemble a sales dashboard, a novelty chat product, or a neon hacker console.

**Key Characteristics:**

- Compact and dependable controls with explicit hover, focus, active, disabled, loading, and error states.
- Cool slate surfaces with one committed action signal and one review/focus signal.
- Structural layouts that move from workbench navigation to dense editor panels without changing visual vocabulary.
- Progressive technical depth: structured fields first, code and diagnostics available when needed.
- Responsive behavior that changes layout structure rather than shrinking typography.

## Colors

The palette is a cool, restrained workbench system: neutral slate carries most surfaces, Action Green commits work, and Review Blue marks authored focus, inspection, and selection.

### Primary

- **Action Green** (`#0c703e`): Primary buttons, confirmed actions, successful status, and active Naive UI controls. The deeper base keeps 14px white button text above WCAG AA contrast. Hover uses `#0c7a43`; active uses `#095f35`.
- **Review Blue** (`#3b82f6`): e2e_assistant identity, focus rings, selected authored surfaces, review affordances, and interactive card focus. It is not a second primary-action color.

### Secondary

- **Warning Amber** (`#f0a020`): Recoverable warnings, assumptions that need attention, and save-and-continue decisions.
- **Validation Red** (`#d03050`): Blocking validation, failed operations, destructive actions, and error status.

### Neutral

- **Deep Workbench Ink** (`#0f172a`): High-emphasis titles and dark code toolbars.
- **Body Slate** (`#334155`): Default readable text, field content, and technical descriptions.
- **Muted Slate** (`#64748b`): Helper text, identifiers, timestamps, and secondary metadata. It is the lightest approved body-sized text on white.
- **Cool Canvas** (`#f8fafc`): App-level and editor-level background behind working surfaces.
- **Workbench Well** (`#f1f5f9`): Secondary content regions, navigation wells, and grouped work areas.
- **White Surface** (`#ffffff`): Cards, forms, headers, dialogs, and message surfaces.
- **Cool Border** (`#e2e8f0`): Standard separators and resting component borders.
- **Code Shell** (`#0b1120`): Monaco editor canvas beneath the `#0f172a` toolbar.

### Named Rules

**The Two Signal Rule.** Action Green commits or confirms; Review Blue focuses, selects, or inspects. Never place competing green and blue primary actions in the same decision group.

**The Ten Percent Rule.** Saturated accents occupy no more than roughly 10% of a screen. Their rarity preserves meaning.

**The Readable Muted Rule.** Body-sized muted text on white never becomes lighter than Muted Slate (`#64748b`). Placeholder and disabled text must still meet the applicable WCAG 2.2 AA contrast requirement.

## Typography

**Display Font:** Inter with the system sans stack
**Body Font:** Inter with the system sans stack
**Label/Mono Font:** ui-monospace, SFMono-Regular, Menlo, Monaco, and Courier New fallbacks

**Character:** One neutral sans family carries the product hierarchy so controls remain familiar and quiet. Monospace appears only where code, paths, identifiers, or machine-readable values require it. Inter is not currently bundled, so every role must remain robust through the system fallbacks.

### Hierarchy

- **Headline** (700, 28px, 1.25): Initialization titles and rare first-run states; never routine page chrome.
- **Title** (600, 18px, 1.4): Page headers, card titles, editor section titles, and the e2e_assistant wordmark.
- **Body** (400, 14px, 1.6): Default controls, descriptions, form content, menus, and messages. Long explanatory prose is capped at 70ch.
- **Label** (400 or 600, 12px, 1.5): Metadata, status, helper copy, and compact field labels. Weight 600 is reserved for labels that organize dense forms or steps.
- **Code** (400, 14px, 1.5): Monaco, code blocks, paths, environment variables, and generated Playwright output.

### Named Rules

**The One Sans Rule.** Do not introduce a display font into workbench labels, buttons, data, or page titles. Hierarchy comes from weight, size, spacing, and position.

**The Stable Scale Rule.** Product typography uses fixed sizes. Responsive layouts reflow panels and controls; headings do not use fluid `clamp()` scaling.

## Elevation

e2e_assistant uses structural layering. Borders and cool tonal surfaces establish depth at rest; soft ambient shadows appear only when a surface floats, receives focus, responds to hover, or opens above the workbench. The visual system is neither fully flat nor card-heavy.

### Shadow Vocabulary

- **Sidebar Separation** (`2px 0 8px rgba(29, 35, 41, 0.05)`): Separates persistent navigation from the work area.
- **Header Separation** (`0 1px 4px rgba(0, 21, 41, 0.08)`): Defines fixed workbench chrome without making it float.
- **Interactive Card Lift** (`0 10px 24px rgba(59, 130, 246, 0.12)`): Appears only on hover or focus-visible for an actionable Skill card.
- **Composer Rest** (`0 8px 28px rgba(15, 23, 42, 0.08)`): Keeps the chat composer distinct from the scrolling message field.
- **Composer Focus** (`0 0 0 3px rgba(59, 130, 246, 0.12), 0 8px 28px rgba(15, 23, 42, 0.08)`): Adds an explicit Review Blue focus ring without changing layout.
- **Editor Card** (`0 3px 10px rgb(15 23 42 / 4%)`): Gives structured E2E sections a minimal separation from the cool canvas.
- **Floating Control** (`0 4px 16px rgba(15, 23, 42, 0.12)`): Reserved for controls that genuinely float over scrollable content.

### Named Rules

**The Structural-at-Rest Rule.** Cards and panels are flat at rest unless they sit above scrolling content. If every container casts a shadow, the hierarchy has failed.

**The State Earns Elevation Rule.** Hover, keyboard focus, overlays, and floating controls may lift; static information does not.

## Components

Components are compact and dependable. They use familiar Naive UI conventions where those conventions serve the workflow, with authored slate surfaces and explicit focus treatment tying the workbench together.

### Buttons

- **Shape:** Compact rectangular controls with gently softened corners (`3px`) and a standard height of `34px`.
- **Primary:** Action Green background, white text, `14px` type, and `0 14px` horizontal padding.
- **Hover / Focus:** Hover and focus move to `#0c7a43`; keyboard focus must add a visible ring rather than relying on color alone. Active state uses `#095f35`.
- **Secondary:** A translucent Action Green well with green text for supporting actions. Ghost controls remain neutral until hover.
- **Disabled / Loading:** Disabled controls preserve their label and reduce emphasis without disappearing. Loading retains button width to prevent layout shift.

### Chips

- **Style:** Compact status tags use a `22px` height, `2px` radius, `12px` type, and `0 7px` padding.
- **State:** Success, warning, and error variants combine foreground, translucent background, border, and text/icon meaning. Status never relies on hue alone.

### Cards / Containers

- **Corner Style:** Structured editor panels use `12px`; soft wells use `16px`; actionable Skill cards use `20px`. Do not apply the largest radius to every surface.
- **Background:** White surfaces sit on Cool Canvas or Workbench Well backgrounds.
- **Shadow Strategy:** Static containers rely on Cool Border; actionable Skill cards lift only on hover or focus-visible.
- **Border:** Resting border is Cool Border (`1px solid #e2e8f0`); structured editor rows may use the slightly stronger `#dbe3ee` separator.
- **Internal Padding:** Standard working panels use `16–18px`; page regions use `24px`.

### Inputs / Fields

- **Style:** White `34px` controls with `3px` corners, `0 12px` padding, Body Slate text, and a `1px` neutral border.
- **Focus:** Focus uses a stronger state border plus a visible two-pixel ring. Naive controls use Action Green; authored review/composer surfaces use Review Blue according to the Two Signal Rule.
- **Error / Disabled:** Error state combines Validation Red with clear text. Disabled fields use a tonal surface and preserve readable content. Placeholder copy uses Muted Slate rather than the inherited low-contrast Naive default.

### Navigation

- **Style:** Workbench navigation uses a `42px` row, `14px` type, familiar icons, and compact horizontal insets. Hover uses a cool neutral well; active state uses a translucent Action Green well and green text/icon.
- **Structure:** Desktop navigation is `240px` expanded and `64px` collapsed. The brand/header strip remains `64px` high. Mobile explorer navigation becomes an explicit `220px` overlay rather than compressing editor content.
- **States:** Default, hover, focus-within, active, and disabled treatments must remain visually distinct.

### Skill Card

- **Character:** The primary actionable object in the workbench: descriptive, inspectable, and clearly interactive.
- **Style:** White surface, `20px` corners, `18px` padding, Cool Border, `18px` title, readable description, and indigo-tinted metadata wells.
- **Interaction:** Hover and focus-visible switch the border to Review Blue, lift by one pixel, and add the Interactive Card Lift shadow. The entire card must retain a visible keyboard focus state.

### Chat Composer

- **Character:** A focused collaboration control, not a decorative chat bubble.
- **Style:** White surface, `18px` corners, `8px 10px 8px 14px` padding, Cool Border, and Composer Rest shadow.
- **Interaction:** Focus-within uses Review Blue and Composer Focus. At compact container widths the radius reduces to `16px`, secondary helper copy hides, and the send/stop action grows to a minimum `42px` touch height.
- **Motion:** Border and shadow respond in `120ms`. Reduced-motion mode removes nonessential transitions and always disables smooth scrolling.

### Code and Structured Editors

- **Code:** Monaco sits on Code Shell with a Deep Workbench Ink toolbar, `14px` monospace type, `48px` minimum toolbar height, and clear file/path metadata.
- **Structured Cases:** White `12px` panels with `18px` padding and a minimal Editor Card shadow organize basic information, preconditions, and ordered steps.
- **Responsive:** The explorer, toolbar, forms, step rows, and diff views change structure at their existing breakpoints. They never solve narrow widths by shrinking text below the documented scale.

## Do's and Don'ts

### Do:

- **Do** make structured test intent the clearest object on every authoring screen.
- **Do** use Action Green for committed actions and Review Blue for focus, selection, and inspection.
- **Do** preserve visible keyboard focus for cards, navigation, inputs, editor controls, dialogs, and chat actions.
- **Do** use Cool Canvas, Workbench Well, white surfaces, and `1px` borders as the default layering vocabulary.
- **Do** keep body text at `14px` with Body Slate or darker; cap long prose at 70ch.
- **Do** teach the next useful action in empty states instead of showing a generic “nothing here” message.
- **Do** implement `prefers-reduced-motion` alternatives for authored transitions and override nonessential library motion where possible.
- **Do** keep Chinese interface copy primary while preserving established technical terms such as Skill, API, Agent, and Playwright.

### Don't:

- **Don't** create a generic SaaS dashboard with decorative metrics, oversized empty space, or sales-oriented card layouts.
- **Don't** use playful AI chatbot styling, mascots, bubbly decoration, or novelty-first assistant interactions.
- **Don't** use flashy cyber aesthetics, neon gradients, glowing panels, or dark hacker-tool clichés.
- **Don't** make the Agent the visual centerpiece; it is a collaborator inside the workflow.
- **Don't** use Review Blue as a competing primary action color beside Action Green.
- **Don't** nest cards or give every workbench region the same radius and shadow.
- **Don't** use gradient text, decorative glassmorphism, colored side-stripe borders, or arbitrary z-index values.
- **Don't** accept low-contrast placeholder or muted text simply because it is a component-library default.
- **Don't** animate page arrival or decorative movement; product motion communicates state in `120–250ms` and has a reduced-motion alternative.
