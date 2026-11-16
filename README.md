# Proposal Workspace

Two tabs:

- **RFP**: drop in an RFP (plus any addenda) to see its summary, key facts, key dates, critical components, questions to ask, and scoring.
- **Proposals**: review one consultant proposal or compare several (below).

Results can be added to a project (optional). Everything is saved to Supabase when it's configured, otherwise in the browser.

## Proposals

Upload one consultant proposal (PDF) to get its key facts, or several to compare them. It works for any architecture or engineering discipline (MEP, structural, AV, acoustics, lighting, and others). Claude reads each one, then the tool shows:

- **Fees**: total (lowest highlighted), per-phase breakdown, additional services, reimbursables, hourly rates, CA visits, schedule, payment terms. Totals are calculated in code from the fees each proposal states.
- **Briefing**: headline, overview, flagged issues/inconsistencies, and clarification questions to send each firm.
- **Scope**: a normalized checklist grouped by discipline. Each firm is marked Included / Optional (add-on) / Excluded (explicitly) / Not mentioned (silent, so ask), and hovering a cell shows its note and page reference. A "Show differences only" toggle hides rows where every firm matches.
- **Proposal details** (collapsed): exclusions, assumptions, clarifications, and deliverables for each firm.
- **Ask / correct**: a chat panel that can see the original PDFs and the analysis. Ask questions, or ask it to fix something; corrections update the tables and briefing in place.
- **Recent comparisons**: every comparison (and its chat) is saved automatically in this browser and can be reopened or deleted from the start page. Nothing is shared between computers or browsers. If a saved comparison is older than a day, its PDFs have been deleted from Anthropic, so the chat offers **Re-attach PDFs** (pick the same files) instead of re-running the analysis.
- **Print / PDF**: a print-ready layout. Pages print portrait by default; choose landscape in the print dialog if you want it.

## Run locally

```
npm install
cp .env.example .env.local    # then fill in your keys
npm run dev
```

Open http://localhost:5173.

Run `bash scripts/install-hooks.sh` once per clone: it adds git hooks that block commits and pushes containing secrets (API keys, `.env` files and similar). The repo is public.

## Supabase

1. In the Supabase SQL Editor, run `supabase/schema.sql` once.
2. Add `SUPABASE_URL` (`https://<project-id>.supabase.co`), `SUPABASE_SECRET_KEY` (`sb_secret_...`) and `SUPABASE_PUBLISHABLE_KEY` (`sb_publishable_...`) to `.env.local` and to Vercel's environment variables.

Only the server reads and writes the tables; the secret key never reaches the browser. Without these, saving falls back to the browser and there's no login.

### Login and organizations (Supabase Auth)

With `SUPABASE_PUBLISHABLE_KEY` set, the site asks people to sign in (email and password, or an emailed sign-in link). Anyone can create an account, and each new account gets its own empty **organization**. Every record belongs to one organization, and the server only reads and writes the signed-in person's. A sign-in is remembered in that browser and renews itself, so people stay signed in until they click **Sign out**.

1. Run `supabase/orgs.sql` in the SQL Editor (after `schema.sql`). It adds organizations, puts all existing records into one called "My organization", and adds usage tracking. **Run it before deploying this code**: the server expects the `org_id` columns.
2. Create your own account (sign up on the site), then put it in "My organization" with the snippet at the end of `orgs.sql`.
   Then run `supabase/domain-join.sql`: after you fill in the firm's name and email domain at its marked line, it names the firm's organization and sets its **join domain**. Anyone who signs up with a confirmed email at that domain joins the firm's organization as a member, with no invite needed; everyone else gets an organization of their own. Public email providers (gmail.com, outlook.com, …) can't be a join domain. To change it: `update organizations set join_domain = 'yourfirm.com' where name = '…';`
3. **Authentication → URL Configuration:** set **Site URL** to the live address and add `http://localhost:5173` under **Redirect URLs**, so confirmation, sign-in and password-reset links come back to the app.
4. **Authentication → Emails → SMTP:** Supabase's built-in email sender is limited to a few emails an hour; set up your own SMTP (Resend, Postmark, SES, …) before opening sign-up to the public.

**AI spending.** Every Claude call records its tokens and cost against the organization (`usage_events`). Each organization has a monthly limit (`organizations.ai_monthly_limit_usd`, null = no limit); AI features answer "limit reached" once it's spent. New organizations get `DEFAULT_ORG_AI_LIMIT_USD` (default 0, so strangers can't spend your Anthropic credit until you raise their limit or billing is added). "My organization" has no limit. This is what a subscription (Stripe) will set later.

Optional: `AUTH_ALLOWED_EMAILS` (e.g. `@yourfirm.com,someone@gmail.com`) limits sign-in to those people.

On a production deploy, if login isn't configured the API refuses every request instead of staying open. Locally without the publishable key, no login is asked for and records are saved in the browser.

### Moving to a new Supabase project

Run `supabase/schema.sql` in the new project (and `supabase/orgs.sql` only after copying), fill in `.env.migrate` (old and new URL and secret key), then run `node --env-file=.env.migrate scripts/migrate-supabase.mjs`. It copies every table and the stored RFP PDFs, and is safe to re-run. User accounts aren't copied; add people again in the new project.

## Deploy (Vercel)

1. `vercel` (or import the repo in the Vercel dashboard; it auto-detects Vite).
2. Add `ANTHROPIC_API_KEY` under Project → Settings → Environment Variables.
3. Add the three Supabase variables (see **Supabase** above) so login is on. Without them the live site refuses every request.

Limits on Vercel: each PDF must be under ~4.4 MB (the platform caps request bodies at 4.5 MB), so compress larger PDFs first. Each request can run for up to 5 minutes. Locally there's no size cap.

## How it works

| Step | Endpoint | What happens |
|---|---|---|
| 1 | `POST /api/extract` | One call per PDF, run in parallel. The PDF goes to Claude as a document block, and Claude returns structured JSON (`ProposalSchema` in `lib/claude.ts`). |
| 2 | `POST /api/compare` | All extractions (text only) go to Claude, which returns the master scope checklist and watch-outs (`ComparisonSchema`). |

- Model: `claude-opus-5-5` at `effort: "high"`, with structured outputs and the server-side refusal fallback enabled.
- Prompts and schemas live in `lib/claude.ts`. Edit the prompts there to change how scope gets categorized.
- `dev-api-plugin.ts` serves the `/api` handlers inside the Vite dev server, so local dev doesn't need the Vercel CLI.

## Costs

The app shows cost notes as it goes. Prices live in `lib/cost.ts`; update them there if Anthropic pricing changes.

- **Before a run:** each PDF is measured with Anthropic's free token-count endpoint, and the page shows an estimated range per file and for the whole run. The range covers what can't be known in advance: how much Claude writes back.
- **After a run:** actual costs, taken from the API's own usage report, are shown per file and for the run.
- **Chat:** an estimate sits under the input box. Each reply shows what it cost, and the results header keeps a running total for the comparison, also shown in Recent comparisons.
- **Trim PDFs first:** every page is billed. Upload only scope, fees, assumptions and exclusions, and leave out resumes, firm history and project sheets. To make a trimmed PDF, print the needed pages to PDF (choose "Pages" in the print dialog) or use Acrobat's Organize Pages. The page shows the same tip under the upload box.
- **No paying twice:** each PDF's reading is saved in the browser under a fingerprint of the file. Adding the same PDF again (for example re-running with one more proposal) reuses it at no cost, and "Re-read" forces a fresh, paid reading. Chat corrections update the saved reading.
- Chat runs at medium effort (reading and comparing use high), which keeps questions cheaper and faster.
- Typical figures for four ~10-page proposals: about $1–$2.50 per run, a few cents to about $0.20 per follow-up question, and more for the first question or a correction.

## Data handling (SOC 2 notes)

- The API key is read only on the server (`.env.local` or Vercel env vars) and is never bundled into the browser code.
- PDFs are uploaded to your Anthropic account (Files API) so the chat can re-read them without re-uploading. Each run deletes this app's files older than one day; only files whose names start with `proposal-comparison__` are touched. Results aren't stored anywhere; they live in the browser tab.
- Server logs record status messages only, never document content.
- Chat cost: the PDFs are prompt-cached, so follow-up questions read them at about 5% of the normal input price for as long as you keep chatting (the cache lapses after ~5 minutes idle).
- Vendors: Anthropic API (SOC 2 Type II; commercial API inputs aren't used for training) and Vercel (SOC 2 Type II). Request the reports from trust.anthropic.com and vercel.com/security for your vendor file. Ask Anthropic about Zero Data Retention if a client contract requires it.
