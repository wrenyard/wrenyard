# Security Policy

Wrenyard is one public product in one monorepo. This policy applies to the
Wrenyard repository and to all code and artifacts produced from it.

## Supported versions

Wrenyard 1.0.0-dev.0 is a development preview. Security support is provided
on a best-effort basis for the latest-dev channel only; there are no
supported stable release versions yet. Do not use preview builds for
sensitive production workloads.

## Reporting a vulnerability

Please report vulnerabilities privately. Do not open public issues containing
credentials, tokens, or exploit details. Use the repository's
[private vulnerability reporting](https://github.com/wrenyard/wrenyard/security/advisories/new)
form so details are visible only to maintainers.

## Data handling

Never commit the following to the repository:

- Credentials, tokens, API keys, or certificates
- Internal endpoints or personal machine paths
- User data or telemetry from real workloads

If credentials were ever exposed in history, rotate them immediately and
treat them as compromised.
