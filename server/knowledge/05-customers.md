# Customers — Complete Guide

## What is a customer in WorkEasy360?

A customer is a person who has booked or has been registered for appointments. The customer database stores contact information, booking history, and internal notes. Customers are unique per organization by email address.

## Viewing customers

Go to **Customers** (`/customers`) to see all customers listed alphabetically. You can search by name or email using the search bar.

## Adding a new customer

1. Go to **Customers** → **New Customer** (`/customers/new`) or click **+ New Customer**.
2. Fill in the form:
   - **Full Name** (required) — customer's full name (e.g., "Jane Smith")
   - **Email Address** (required) — must be a valid email format (e.g., "jane@example.com")
   - **Phone Number** (optional) — e.g., "+1 (555) 000-0000"
   - **Timezone** (optional) — the customer's timezone for scheduling communications
   - **Tags** (optional) — checkboxes: Regular, VIP, Corporate, Sports, Referral, New
   - **Notes** (optional) — internal notes visible to staff only, not shown to the customer
3. Click **Create Customer** (button disabled until name and email are filled in).

### Customer creation validation
- Name: required
- Email: required, must be a valid email format
- Duplicate email per organization → "A customer with that email already exists" — update the existing customer record instead

## Viewing a customer

Click on a customer from the list to view their detail page at `/customers/:id`. The detail page shows:
- Contact information (name, email, phone, timezone)
- Tags
- Internal notes
- Total bookings count
- Last booking date
- Appointment history

## Searching for a customer

From the Customers list (`/customers`), use the search box to find customers by name or email. The search is a partial-match search.

## Editing a customer

Open the customer's detail page, then click **Edit**. You can update all fields except email (which is used as the unique identifier). To change an email address, delete and recreate the customer record.

## Customer tags

Tags help categorize customers for filtering and reporting:
- **Regular** — recurring customers
- **VIP** — high-value or priority customers
- **Corporate** — business/corporate clients
- **Sports** — sports-related clients
- **Referral** — customers who came via referral
- **New** — newly registered customers

## How customers are created automatically

When a customer books through a public booking page, they are automatically added to your customer database. The system matches by email address — if a customer books again with the same email, their existing record is updated rather than creating a duplicate.

## Customer booking history

The customer's total booking count (`total_bookings`) and last booking date (`last_booking_date`) are automatically updated each time they make a new appointment.

## Customer API endpoints

| Action | Method | URL |
|---|---|---|
| List customers | GET | /api/customers |
| Search customers | GET | /api/customers?q=searchterm |
| Get one customer | GET | /api/customers/:id |
| Create customer | POST | /api/customers |
| Update customer | PUT | /api/customers/:id |
| Delete customer | DELETE | /api/customers/:id |

## Deleting a customer

Open the customer detail page and click **Delete**. Confirm the deletion. Note that deleting a customer does not delete their past appointment records.

## Troubleshooting customer issues

**"A customer with that email already exists"** — A customer with that email is already in your database. Search for them and update their record instead of creating a new one.

**Customer can't find their booking** — Direct them to `/book/:slug/manage` where they can enter their booking reference (WE-XXXXXXXX) to find and manage their appointment.

**Duplicate customer records** — If you have two records for the same customer, consolidate by updating one with all the correct information and deleting the duplicate.
