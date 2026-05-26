# Contributing to EduVault

Thanks for contributing.

## Scope

EduVault is an in-development educational content marketplace with a current web prototype and a planned Stellar-native settlement layer. Contributions should improve one of these areas:

- product clarity
- security
- Soroban contract design
- developer experience
- accessibility
- documentation

## Before You Start

1. Read [README.md](README.md).
2. Review [docs/overview.md](docs/overview.md) and [docs/architecture.md](docs/architecture.md).
3. Open an issue before starting large changes so architecture and scope can be aligned early.

## Local Setup

```bash
npm install
cp .env.example .env.local
docker compose up -d mongodb
npm run dev
```

## Branching

- Use a short descriptive branch name such as `docs/stellar-submission` or `feat/entitlement-checks`.
- Keep pull requests focused. Avoid mixing documentation, refactors, and feature work unless the changes are tightly coupled.

## Coding Standards

- Keep changes small and reviewable.
- Prefer explicit naming over clever abstractions.
- Preserve the distinction between current prototype behavior and planned Stellar milestones.
- Do not claim a feature is on Stellar unless it is implemented and testable in this repository.
- Do not add new product work to the archived EVM prototype unless there is an explicit architecture decision to do so.
- Update documentation when architecture or environment requirements change.

## Pull Request Checklist

- The change is scoped and explained clearly.
- Relevant docs are updated.
- New environment variables are reflected in `.env.example`.
- Pull requests that change visible frontend behavior include screenshots or a short screen recording.
- Request/response examples are included when backend or API changes materially benefit from them.
- Any product or architectural assumptions are stated explicitly in the PR description.

## Commit Messages

Use concise, conventional commit messages when possible:

- `docs: rewrite README for Drip Wave submission`
- `chore: add contributor and license files`
- `docs: document Stellar architecture direction`
- `feat: add Soroban contract scaffolding`

## Reporting Issues

When opening an issue, include:

- expected behavior
- actual behavior
- reproduction steps
- screenshots or logs if relevant
- whether the issue affects the current prototype or the planned Stellar milestone

## Security

Do not disclose secrets, private keys, or production credentials in issues or pull requests. If you discover a sensitive security issue, contact the maintainer privately before public disclosure.
🌟 Stellar Contributors: See the [Stellar Integration Guide](docs/STELLAR_GUIDE.md) for setup instructions.