# Wrenyard documentation

Wrenyard is a local-first desktop workbench for orchestrating AI engineering
work. Start with the [project README](../README.md) for an overview and
screenshots ([中文](../README.zh-CN.md)).

## Using Wrenyard

| Guide | What it covers |
| --- | --- |
| [Getting started](guides/getting-started.md) | Workspace, providers, project registration and the first conversation |
| [Bots and routines](guides/bots.md) | Agents that run on routines, open sessions, track todos and message each other |
| [Supported providers](model-providers.md) | Every built-in provider, how it authenticates and what quota it reports |
| [Task graphs](taskgraph.md) | Runtime signals for multi-step task graphs |

## How it works

| Document | What it covers |
| --- | --- |
| [Architecture](architecture.md) | Package boundaries, the daemon, the gateway, execution and state |
| [Session feature](../packages/features/session/README.md) | The append-only conversation ledger and how the main model acts |

## Developing Wrenyard

| Document | What it covers |
| --- | --- |
| [Development guide](development.md) | Dev loop, checks, screenshots and releases |
| [Contributing](../CONTRIBUTING.md) | How to propose a change |
| [Signing](release/signing.md) | Code-signing status of release builds |
| [Upgrade notes](history/migration.md) | Notes for users of early previews |
| [Changelog](../CHANGELOG.md) | What changed between versions |
| [Security](../SECURITY.md) | How to report a vulnerability |

The desktop app opens this page from the connection menu at the bottom of the
sidebar (文档).
