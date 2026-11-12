# kite_portfolioagent

One-stop solution to analyse your Zerodha portfolio and mutual funds by connecting through Claude.

A Next.js web app (in `web/`) that screens your Kite holdings against the rules in `screen-rules.json` (valuation, quality, growth, price trend), pulls news sentiment, and produces a dashboard and reports.

## Project layout

| Path | Purpose |
|------|---------|
| `web/` | Next.js app (UI + API routes: `analyze`, `brief`, `kite`, `rules`) |
| `screen-rules.json` | Screening rules applied to holdings |
| `data/` | Fundamentals and cache |
| `reports/` | Generated screen reports (`.json` / `.md`) |

## Prerequisites

- Node.js 18.18+ and npm
- A Zerodha Kite account (connected through the Kite MCP)

## Running the server

```bash
cd web
npm install
cp .env.example .env.local   # optional, see below
npm run dev
```

Open http://localhost:3000.

Other scripts (run from `web/`): `npm run build`, `npm start` (production), `npm run typecheck`.

## Configuration

Set in `web/.env.local` (all optional):

| Variable | Description |
|----------|-------------|
| `ANTHROPIC_API_KEY` | Enables Claude-based news sentiment and synthesis. Without it, a simple headline lexicon and rule-based synthesis are used. |
| `ANTHROPIC_MODEL` | Model override (default `claude-haiku-5-5`). |
| `GMAIL_MCP_URL` | Gmail MCP server URL. When set, every **Run agents** saves the report as a Gmail draft (no recipient, never sent). |
| `APP_URL` | Public URL when deployed (e.g. `https://portfolio.example.com`). Used for the Kite login redirect. |
| `SESSION_DIR` | Where per-browser Kite tokens and reports are kept (default `web/.sessions`). Use persistent storage when deployed. |
| `KITE_DATA_DIR` | Folder holding `screen-rules.json`, `data/` and `reports/` (default: parent of `web/`). |

## Gmail draft report

With `GMAIL_MCP_URL` set, each **Run agents** click creates a draft in Gmail containing the brief, per-holding stance/scores/flags and quant-vs-news conflicts. The first run shows an "authorize here" link for Gmail sign-in (tokens are kept in `web/.gmail-oauth.json`, gitignored); click Run agents again afterwards. The draft has no recipient and is never sent automatically.

## How data flows (generic, any Kite account)

Nothing is tied to one account. Each browser gets its own session: **Connect Kite** opens the Kite login, then the server reads that user's holdings through the Kite MCP, pulls daily candles for each holding and NIFTY 50 (trend, SMA20/50/200, RSI, returns, 52-week range), fetches fundamentals from the public screener.in page (cached in `data/fundamentals.json`), and scores everything against `screen-rules.json`. Kite sessions expire daily around 06:00 IST; click Connect or Run agents again to sign in.

Limits: the Entry plan lists only holdings-based add-on levels (there is no candidate universe yet), and `screen-rules.json` is shared by all users of one deployment.
