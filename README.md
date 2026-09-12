# Raising Arrows CRM

A pipeline tool for tracking inquiries, follow-ups, payments, and closed
enrollments — built specifically for Raising Arrows.

**Live at:** https://raising-arrows-crm.onrender.com — works from any device,
anywhere. (It can also be run locally on a Mac — see "Running it locally"
below — but the hosted link is what your wife and her assistant should use
day to day.)

## First-time setup

The first time anyone opens the link, they'll be asked to create the login —
a login name (doesn't need to be a real email, just something like `susan`)
and a password. **This is the one login your wife and her assistant will
both use** — there's no separate account per person.

## Using it day to day

- **Pipeline** — a board with a column per stage (New Inquiry → Follow Up →
  Awaiting Payment → the three "Closed" stages → Closed Lost). Move a card
  two ways: drag it to a new column, or use the **"Move to…" dropdown** at
  the bottom of every card to jump straight to any stage.
- Click **+ New Inquiry** to add someone new.
- Click any card to open it and edit name, phone, email, children (use
  **+ Add child** for each one), pricing, dates, and notes.

### Pricing

- **RAFA** (the 3-month program): ₦50,000 × however many children are on the
  card — calculated automatically, never typed by hand. Adjust the per-child
  price in Settings if it ever changes.
- **Personalized coaching**: priced by hand — enter the number of months and
  the total amount agreed.

### Payments — how stages move automatically

- **RAFA**: clicking **Record payment** and entering the full amount owed
  moves the card straight to **Closed – Paid in Full**. Entering a partial
  amount moves it to **Closed – Payment Plan** instead, and sets the next
  payment due date to 30 days from today (that date can always be
  hand-edited afterward if 30 days doesn't fit).
- **Personalized coaching**: clicking **Record payment** for the first time
  moves the card to **Closed – Personalized Coaching** automatically, and
  also sets a next payment due date 30 days out.
- If a payment-plan or personalized-coaching card still shows ₦0 paid, it's
  flagged with a red **⚠️ Payment not recorded** badge — both on the board
  and on the Dashboard — until an actual amount is entered.
- Once a card is on a payment plan, there's no separate "follow-up" date to
  manage — only the next payment date matters from there.

### Dashboard

- KPI tiles for total received, outstanding/pending, follow-ups due,
  payments due, and unrecorded payments.
- **Click "Total received"** or **"Outstanding / pending"** to expand a list
  of exactly who's behind that number — click any name to jump to their
  card.
- Lists for who needs a follow-up and whose payment is coming due, each
  clickable the same way.

### Settings

Adjust RAFA's price per child, how many days ahead the dashboard warns about
follow-ups/payments, and the payment-plan installment schedule (defaults: 3
installments, 30 days apart).

## Making changes later

The code lives at `github.com/stephospirit-star/raising-arrows-crm`. Any
time you want something changed, just ask — pushing an update to that repo
automatically redeploys the live site within a minute or two.

## Your data

All data lives in a database on Render's persistent disk attached to the
service — it survives restarts and redeploys. There's no separate backup
today; ask if you'd like one set up.

## Running it locally (optional)

If you ever want to run a copy on a Mac directly instead of using the
hosted link, double-click **`Start CRM.command`** in this folder — it needs
nothing but the Python that ships with macOS. This uses its own separate
local database, not the one behind the live link.
