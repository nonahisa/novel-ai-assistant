# Repository Guidelines

## Project Structure & Module Organization

`src/extension.ts` activates this TypeScript VS Code extension. Put types and pure functions in `src/models/`, domain logic in `src/core/`, AI adapters in `src/ai/`, prompts in `src/prompts/`, orchestration in `src/features/`, and UI code in `src/views/`. Dependencies flow `views`/`features` → `core` → `models`; `models` must not import VS Code. Assets live in `media/`, design notes in `docs/`, and generated output in ignored `dist/` and `out/`.

Read `CLAUDE.md` and the three documents it identifies before changing behavior, especially rules protecting manuscript files and author-edited metadata.

## Build, Test, and Development Commands

- `npm install`: install locked dependencies from `package-lock.json`.
- `npm run build`: create the production bundle at `dist/extension.js`.
- `npm run watch`: rebuild on source changes during development.
- `npm run test:unit`: run the fast Vitest suite.
- `npm run test:integration`: test activation and file workflows in VS Code 1.90.0.
- `npm run check`: run type checks, unit tests, and the production build.
- `npm run package:vsix`: run release gates and create the versioned VSIX.
- Press `F5` in VS Code: build and launch an Extension Development Host.

## Coding Style & Naming Conventions

Use TypeScript with two-space indentation, double quotes, and strict typing; do not introduce `any` in production code. Use `camelCase` for variables, functions, and source filenames, `PascalCase` for types and classes, and `UPPER_SNAKE_CASE` for constants. Comments should explain why a decision exists and should be written in Japanese, matching UI text and project documentation. No formatter or linter is configured, so preserve the surrounding style and run `npm run typecheck` before submitting. Increment a prompt's `_VERSION` constant whenever its content changes.

## Testing Guidelines

Vitest covers pure logic and provider boundaries under `test/unit/`; name files `*.test.ts`. The VS Code Electron host runs `src/test/run.ts` against the minimum supported editor. Run `npm run check` for every change and `npm run test:integration` for extension behavior. `npm run test:ollama` is an optional live check. Releases must also pass `npm run verify:vsix`. Never commit manuscript paths, credentials, caches, or generated AI results.

## Commit & Pull Request Guidelines

History uses Conventional Commit-style subjects such as `feat: integrate Claude AI provider`. Write concise, imperative subjects with an appropriate prefix (`feat:`, `fix:`, `docs:`, or `refactor:`). Pull requests should explain the user-visible change, cite relevant design sections or issues, list build/typecheck/manual-test results, and include screenshots or recordings for UI changes. Call out migration, AI-cost, or manuscript-safety implications explicitly.
