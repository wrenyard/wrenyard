# Security Policy

Wrenyard is one public product in one monorepo. This policy applies to the
Wrenyard repository and to all code and artifacts produced from it.

## Supported versions

Security fixes target the latest published Wrenyard release. Older versions,
including legacy `dev.N` previews, should upgrade to it. There are no separately
maintained dev/stable channels and no backport promise. A plain version number,
or a normal GitHub release classification, does not by itself guarantee
production suitability, trusted signing or security, and preview builds should
not be used for sensitive production workloads.

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
