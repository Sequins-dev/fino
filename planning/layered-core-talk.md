# What if everything was TypeScript?

Source: `demos/layered-core.mdx`. Visual components come from `fino:ui/components`; the deck exports only its theme CSS.
Run: `./target/debug/fino demos/layered-core-slides.ts`.
Presenter: http://127.0.0.1:3000/control
Audience: http://127.0.0.1:3000/talk

## Argument

Native integration enables a runtime, but much of its work consists of orchestration and policy connecting those capabilities. Orchestration coordinates steps, progress and resource lifetimes. Policy chooses behavior, limits and ownership rules. Keeping this code in TypeScript allows more of the runtime to compose through ordinary values, functions and explicit dependencies.

The native boundary joins different representation and lifetime models. Narrow FFI adapters contain those translations. Moving more orchestration into native code can put that boundary in the way of extending runtime behavior. Moving it deeper lets higher layers build on TypeScript contracts without adding a native binding for every composition.

## Story and pacing

22 slides for a 20–25 minute talk. Validation is the central cross-system reuse example. Stores, sessions, workflows and the socket walkthrough are excluded.

- Slides 1–4: introduce the experiment and the large, TypeScript-heavy core thesis.
- Slides 5–8: define native integration, orchestration and policy, then establish what actually benefits from native code.
- Slides 9–12: show how pointers, buffers, handles and structure access can remain behind a narrow FFI boundary.
- Slide 13: introduce the reuse flywheel created by a broad core.
- Slides 14–17: follow validation into HTTP, tasks and AI to demonstrate reuse across unrelated consumers.
- Slides 18–20: use Realms, import maps and Facades to show composition as execution policy.
- Slides 21–22: close with holistic performance and the argument that a broader core can produce smaller subsystems.

## Example conventions

All examples use simplified Fino API shapes. Imports, application-specific code and dependency setup are omitted where they do not contribute to the architectural point.

Native engines and host integration remain useful; the talk argues for locating adaptable orchestration and policy in TypeScript without claiming universal performance superiority.
