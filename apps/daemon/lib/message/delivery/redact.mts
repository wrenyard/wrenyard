// Redaction helpers - used across backends and hub to prevent secret
// leakage into MessageDeliveryResult.error, detail, and log lines.

// Replace every occurrence of each secret string (case-sensitive) with ***.
export function redactSecrets(text: string, secrets: string[]): string {
  let result = text
  for (const secret of secrets) {
    if (!secret) continue
    result = result.split(secret).join('***')
  }
  return result
}

// Redact the bot token path segment from Telegram API URLs.
export function redactTelegramUrl(url: string): string {
  return url.replace(/\/bot[^/]+\//, '/bot***/')
}

// Redact the key= query parameter from WeCom webhook URLs.
export function redactWecomUrl(url: string): string {
  return url.replace(/([?&]key=)[^&]+/, '$1***')
}

// Redact Bearer token values from Authorization headers.
export function redactAuthorizationHeader(header: string): string {
  return header.replace(/Bearer\s+\S+/, 'Bearer ***')
}
