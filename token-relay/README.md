# token-relay

Cloudflare Worker that holds the Google OAuth client secret of Orca Colab Community so the CLI does not
ship it. It accepts exactly two requests and forwards each to `https://oauth2.googleapis.com/token` with
the client ID and secret added, returning Google's answer unchanged:

| Request | Body (JSON) | Google grant |
|---|---|---|
| `POST /token` | `code`, `code_verifier`, `redirect_uri` (must be `http://127.0.0.1:<port>`) | `authorization_code` |
| `POST /refresh` | `refresh_token` | `refresh_token` |

Everything else is refused. It stores nothing, has request logs and traces disabled, and never calls a
Colab API. Bodies over 4 KB are rejected; a per-IP rate limit is configured (Cloudflare's limiter is
approximate). It runs on the Workers Free plan, which stops serving instead of billing past its quota.

Deploy (owner only, from this folder):

```sh
CLOUDFLARE_API_TOKEN=… CLOUDFLARE_ACCOUNT_ID=… npx wrangler deploy
npx wrangler secret put GOOGLE_CLIENT_SECRET   # paste the secret at the prompt; never commit it
```

Rotate the secret in Google Cloud (Clients → orca-colab → Add secret), `secret put` the new one, then
disable the old one. No CLI release is needed.
