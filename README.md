# Raising Arrows CRM

A simple pipeline tool for tracking inquiries, follow-ups, payments, and
closed enrollments — built specifically for Raising Arrows. Runs locally on
your Mac; no installs, accounts, or monthly fees required.

## Starting it up

Double-click **`Start CRM.command`** in this folder. A terminal window will
open (you can ignore it — just don't close it while you're using the CRM)
and your browser will open automatically to the app.

To stop the CRM, close that terminal window or press `Control+C` in it.

If double-clicking doesn't work the first time, right-click the file →
**Open** → confirm "Open" in the security prompt (macOS blocks unsigned
scripts by default on first run).

## First-time setup

The very first time you open it, you'll be asked to create the login — a
login name (doesn't need to be a real email, just something like `susan`)
and a password. **This is the one login you and your assistant will both
use** — just share it with her. There's no separate account for each person.

## Using it day to day

- **Pipeline** — a board with a column per stage (New Inquiry → Follow Up →
  Awaiting Payment → the three "Closed" stages → Closed Lost). Move a card
  two ways: drag it to a new column, or use the **"Move to…" dropdown** at
  the bottom of every card to jump straight to any stage (handy for jumping
  straight to Closed – Personalized Coaching or Closed Lost without dragging).
- Click **+ New Inquiry** to add someone new.
- Click any card to open it and edit name, phone, email, children (use
  **+ Add child** for each one), pricing, dates, and notes.
- **Pricing is automatic for the 3-month program**: ₦50,000 × however many
  children are listed on the card — you never type a total by hand for that.
  Personalized coaching is the only plan priced by hand (enter the months
  and the total you agreed on).
- **Payments**:
  - Moving a card to **Closed – Paid in Full** marks it fully paid
    automatically — no need to enter an amount.
  - Moving to **Closed – Payment Plan** does *not* assume anything was
    paid — use **Record payment** on the card to enter exactly what she
    actually received. Until you do, the card shows a red
    **⚠️ Payment not recorded** flag, both on the board and on the Dashboard,
    so nothing slips through.
  - Recording a payment on a payment-plan contact can also automatically
    push the next payment due date forward by 30 days (checkbox, on by
    default).
- **Dashboard** — total received, total outstanding, and clickable lists:
  who needs a follow-up, whose payment is coming due, and whose payment
  hasn't been recorded yet. Click any name and it jumps straight to their
  card.
- **Settings** — adjust the 3-month program's price per child, how many
  days ahead the dashboard should warn about follow-ups/payments, and the
  payment plan installment schedule (defaults: 3 installments, 30 days
  apart).

## Sharing it with your assistant

Right now the CRM only runs on your Mac. If your assistant is on the same
wifi network, the terminal window (from Start CRM.command) prints a network
address like `http://192.168.x.x:8420` — she can open that in her own
browser and log in with the same email/password to view and update stages.
If she's not on the same network, she'd need to be on your Mac directly, or
this would need to be deployed online instead — let me know if you want that
upgrade later.

## Your data

Everything is stored in one file: `raising_arrows.db`, right in this folder.
There's no cloud backup — it's a good idea to occasionally copy that file
somewhere safe (an iCloud Drive or Dropbox folder, an external drive) in
case anything happens to this Mac.

## Logo

You mentioned uploading the Raising Arrows logo — send it over and I'll swap
it in for the 🏹 emoji in the top-left corner.
