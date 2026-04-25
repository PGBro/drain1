# Secrets Handling Policy

## Rules
- Never commit `.env` files or private keys.
- Keep route secrets and private keys server-side only.
- Never expose secrets through `VITE_*` variables, browser code, logs, or client responses.

## Key Rotation
- Rotate API route secrets and signing keys every 60-90 days, or immediately after any suspected leak.
- Use a staged rotation:
  1. Provision a new key/secret in secure server runtime config.
  2. Deploy and verify server health using the new value.
  3. Update trusted server-to-server callers.
  4. Revoke old key/secret immediately.

## Incident Response
- If a secret is exposed, treat it as compromised.
- Revoke and replace affected values immediately.
- Audit recent transactions and access logs for abuse.
