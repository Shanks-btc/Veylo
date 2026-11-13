# Security

## Reporting a vulnerability

Please report security problems privately. Don't open a public issue.

- Email: **security@[veylo-domain-to-be-confirmed]** (placeholder until the domain is confirmed)
- Include what you found, how to reproduce it, and what it affects.
- We'll acknowledge your report within 3 working days and keep you updated until it's fixed.

Please don't access other people's data, move funds, or disrupt the service while testing. Test only with accounts and funds you control.

## What Veylo protects

- **Who gets paid:** only the treasury account can sign the payee list, and the browser verifies it on NEAR itself.
- **What gets paid:** the browser checks every quote (signed by NEAR Intents, right payee, registered key, exact amount) before signing, and locks signing on any mismatch.
- **The wallet:** wallet code runs on a separate origin with no access to the Veylo API; the app verifies every signature itself.

See [ARCHITECTURE.md](ARCHITECTURE.md) (§6.3 and the threat model) for details.
