# Contributing to Engram

Thanks for your interest in contributing to Engram. This document covers the basics.

## Getting Started

1. Fork the repo
2. Clone your fork:
   ```bash
   git clone https://github.com/YOUR_USERNAME/engram.git
   cd engram
   ```
3. Install dependencies:
   ```bash
   npm install
   ```
4. Build:
   ```bash
   npm run build
   ```
5. Run tests:
   ```bash
   npm test
   ```

## Development

- `npm run dev` -- watch mode for TypeScript compilation
- `npm run lint` -- run ESLint
- `npm run format` -- format with Prettier
- `npm run test:run` -- run tests once (no watch)

## Pull Requests

1. Create a feature branch from `main`
2. Make your changes
3. Add tests if you're adding functionality
4. Make sure `npm run build` and `npm test` pass
5. Open a PR with a clear description of what you changed and why

## Code Style

- TypeScript with strict mode
- Use the existing patterns in the codebase
- Prefer clarity over cleverness

## Reporting Bugs

Open an issue with:
- What you expected to happen
- What actually happened
- Steps to reproduce
- Your environment (Node version, OS, MCP client)

## Feature Requests

Open an issue describing the feature and why it would be useful. We prefer focused, well-scoped proposals.

## License

By contributing, you agree that your contributions will be licensed under the MIT License.
