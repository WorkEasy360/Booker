# Booking Pages — Complete Guide

## What are booking pages?

Booking pages are public URLs that your customers can visit to book appointments online without needing a login. Each page has a unique URL like `/book/my-clinic-name`. Customers can browse your services, pick a staff member, select a date and time, and confirm a booking.

## Viewing booking pages

Go to **Booking Pages** (`/booking-pages`) to see all your booking pages.

## Creating a booking page

1. Go to **Booking Pages** → **New Booking Page** (`/booking-pages/new`).
2. The editor has four tabs:

### Tab 1: Branding
- **Logo** — upload a PNG or JPG (up to 2 MB) for your business logo
- **Page Title** — the headline shown at the top of the booking page
- **Description** — introductory text shown to customers
- **Primary Color** — choose a color for buttons and accents (Emerald, Blue, Purple, Red, Amber, Navy)
- **Font Family** — Inter, Roboto, Open Sans, or Lato
- **Button Text** — the label on the booking button (default: "Book Now")
- **Header Text** — large heading text (e.g., "Book an Appointment")
- **Footer Text** — footer message (e.g., "We look forward to seeing you!")

### Tab 2: Layout
- **Layout Style** — Classic, Modern, or Minimal
- **Background Color** — background color preset
- **Show Logo** — toggle whether to display your logo
- **Show Staff Photo** — toggle whether to display staff member photos

### Tab 3: Form Fields
Default fields (always present, cannot be removed):
- Full Name (required)
- Email (required)
- Phone (required)

Custom Questions (dynamic):
- Click **Add Question** to add a custom intake question
- Set the question label, type, and whether it is required
- Question types: Short Text, Long Text, Dropdown, Checkbox, Phone, Email

### Tab 4: Settings
- **Timezone Display** — which timezone to show customers (ET, CT, MT, PT, GMT, CET)
- **Language** — English, Spanish, French, German
- **Customer Registration** — None / Optional / Required
- **Cancellation Policy** — toggle to show a policy text to customers
- **Minimum Booking Notice** — require a certain lead time (1, 2, 4, 12, 24, or 48 hours)

3. Click **Save Changes** to save, or **Create & Publish** to save and make it live.

### Booking page validation
- **Title** — required
- **Slug** (URL path) — required, must use only lowercase letters, numbers, and hyphens (e.g., "my-clinic", "downtown-branch")
- Duplicate slug per organization → "A booking page with that slug already exists"

## The booking page URL

Once created, the booking page is accessible at:
`/book/{slug}`

For example, if the slug is "downtown-clinic", customers visit: `/book/downtown-clinic`

## Publishing a booking page

A booking page must be published to be accessible to customers. Options:
- Click **Publish** from the Booking Pages list
- Click **Create & Publish** when creating
- Use the toggle in the booking page editor

A page with `isPublished = false` shows "Page not found" to customers.

## Editing a booking page

1. Go to **Booking Pages** (`/booking-pages`).
2. Click on the page to open the editor.
3. Make changes.
4. Click **Save Changes**.

## Booking page types

| Type | Description |
|---|---|
| business | Shows all services for your entire business |
| service | Shows a specific service only |
| staff | Shows availability for a specific staff member only |

## Sharing your booking page

Copy the booking page URL and share it:
- In email communications
- On your website (paste as a link or button)
- On social media
- In your email signature

The URL format is: `https://yourapp.com/book/your-slug`

## Deleting a booking page

Open the booking page, click **Delete**, confirm. This removes the page and makes the URL inaccessible. Existing appointments are not affected.

## Booking page API endpoints

| Action | Method | URL |
|---|---|---|
| List pages | GET | /api/booking-pages |
| Get one | GET | /api/booking-pages/:id |
| Create | POST | /api/booking-pages |
| Update | PUT | /api/booking-pages/:id |
| Publish/unpublish | POST | /api/booking-pages/:id/publish |
| Delete | DELETE | /api/booking-pages/:id |

## Troubleshooting booking pages

**"Page not found" when customers try to book** — Check that the page is published (isPublished = true). Only published pages are accessible to the public.

**Wrong slug URL** — The slug must contain only lowercase letters (a-z), numbers (0-9), and hyphens. No spaces, uppercase letters, or special characters.

**Services not showing on the booking page** — The services must be active and included in the page's service list. Check the booking page settings and the service's active status.

**Customers can't complete booking** — Verify that the services on this page have active staff assigned, and that those staff members have working hours configured for the requested time.
