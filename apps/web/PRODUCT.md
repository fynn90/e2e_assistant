# Product

## Register

product

## Platform

web

## Users

The primary users are test engineers creating and maintaining Web SaaS end-to-end test cases. They work in a local browser workbench and need to express test intent through structured Chinese-language fields without writing Playwright code from scratch.

## Product Purpose

e2e_assistant turns structured E2E test cases into reviewable Playwright TypeScript scripts. The current product scope follows PRD v5: users create and edit structured cases, validate test data, generate scripts, inspect warnings and assumptions, review changes, and confirm the result before saving. Recording, test execution, reports, scheduling, and CI/CD remain outside the current scope.

Success means a test engineer can move from a structured test case to a reviewed, valid Playwright script faster and with less manual coding.

## Positioning

Structured test intent becomes reviewable Playwright code while remaining understandable to test engineers.

## Brand Personality

e2e_assistant is precise, calm, and capable. It should feel like a dependable professional tool rather than an experimental AI demo. The interface is Chinese-first while retaining established technical terms such as Skill, API, Agent, and Playwright where translation would reduce clarity. The current e2e_assistant name and A2e mark are the working product identity.

Linear is the primary interaction-quality reference: compact hierarchy, consistent controls, calm precision, and fast task flow.

## Anti-references

- Generic SaaS dashboards built from decorative metrics, oversized empty space, or sales-oriented card layouts.
- Playful AI chatbot styling that relies on mascots, bubbly decoration, or novelty-first interactions.
- Flashy cyber aesthetics such as neon gradients, glowing panels, and dark hacker-tool clichés.

## Design Principles

1. **Start with test intent.** Make the structured case understandable and efficient for test engineers before exposing implementation detail.
2. **Review before trust.** Generated code, warnings, assumptions, and changes must remain inspectable before the user confirms a save.
3. **Reveal technical depth progressively.** Keep the primary workflow approachable while making precise files, code, and validation details available when needed.
4. **Prefer calm consistency over novelty.** Use familiar product conventions, compact hierarchy, and predictable controls so the interface disappears into the task.
5. **Treat the Agent as a capable collaborator.** AI assistance should clarify and accelerate the workflow without becoming the visual centerpiece of the product.

## Accessibility & Inclusion

Target WCAG 2.2 AA. Core workflows must support keyboard operation, visible focus states, compliant text and control contrast, reduced-motion preferences, and clear programmatic form, validation, and error semantics. Meaning and status must not depend on color alone.
