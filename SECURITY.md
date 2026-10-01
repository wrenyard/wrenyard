# Security Policy

Wrenyard is one public product in one monorepo. This policy applies to the
Wrenyard repository and to all code and artifacts produced from it.

## Supported versions

Wrenyard is in rolling `1.0.0-dev.N` development preview; only the latest
prerelease receives fixes. There are no supported stable release versions yet,
and preview builds should not be used for sensitive production workloads.

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
