# Getting started: setting up your business in WorkeasyBooking

For the business's administrator, on the first day. It takes about an hour. You need the site address, your email
address and the password your provider gave you (by phone or in person, never by email).

Your business starts **empty**: no sample services, staff, customers or bookings. Everything you see is what you or
your team enter.

## 1. Sign in and secure your account

1. Open `https://book.<your-domain>/login`, enter your **Email** and **Password**, choose **Sign in**.
2. **Settings → Security → Change Password**: choose your own password (at least 8 characters, with an uppercase
   letter and a number). Changing it signs out every other session.
3. **Settings → Security → Two-Factor Authentication → Set up two-factor sign-in**: scan the code with an
   authenticator app (Google Authenticator, Microsoft Authenticator, 1Password …), enter the 6-digit code, then
   **Download** the recovery codes and keep them somewhere safe. Choose **I have saved them**. Strongly recommended:
   you are the only administrator, and the recovery codes are how you get back in if you lose your phone.
4. **Active Sessions** (same page) shows where you are signed in; **Sign out other sessions** ends the others.

## 2. Company details and time zone

**Settings** (left menu, bottom):

| Section | What to fill in |
|---|---|
| **Business Profile** | Organization name, Email address, Phone number, Website, Street address, City, Country |
| **Language & Region** | **Timezone** (check it first: every booking time is shown in it; India is Asia/Kolkata), Date format, Currency |
| **Branding** | Logo (an image up to 2 MB), Business display name |
| **Working Hours** | Opening hours for each day; switch a day off to close it; **Apply to all active days** copies one day's hours |
| **Booking Rules** | Default duration and buffer for new services, **Minimum booking notice** (how soon before a time it can still be booked), **Maximum advance booking** (how far ahead) |

Save each section before moving to the next.

> **Cancellation Policy** can be filled in, but it is **not yet applied or shown to customers**: a customer with
> their booking link can cancel or reschedule online until the appointment starts, and no fee is charged. If you need
> a stricter policy, tell customers in the booking page description, and handle late cancellations yourself.

## 3. Services

**Services → New Service**:

- **Service Name**, Description, Category, Location.
- **Duration & Pricing**: duration, Price and Currency. Prices are shown to customers; payment is made to you
  directly (there is no online payment).
- **Staff Assignment**: who can provide it (you can also do this from each staff member).
- **Scheduling Rules**: Buffer Before / Buffer After (free time around each booking), Minimum Notice, Advance Booking
  Window (these override the business defaults for this service).
- **Custom Questions** (optional): extra questions customers answer when booking.

Choose **Create Service**. Repeat for each service.

## 4. Staff

**Staff → Add Staff Member**:

- **Full Name**, **Email Address**, Phone Number, Job Title, **Role**, Bio.
- **Working Hours**: this person's own days and hours. Customers can only book them inside these hours **and** the
  business's working hours.
- **Status → Active**.
- **Workspaces** and **Services**: where they work and what they provide.

Choose **Create Staff**.

**Staff sign-in:** a staff member gets their own login only through an email invitation from their profile, so this
works once your provider has switched email on. Until then you manage everything from your account. Roles
(**Settings → Roles & Permissions**): an administrator can do everything; a manager runs the day-to-day; staff see
their own bookings (**My Space**).

**Holidays and time off:** there is no time-off screen yet (the staff profile says "Not available yet"). To block a
day, switch that day off in the person's **Working Hours** and switch it back afterwards. Bookings already made on
that day are not moved: check **Appointments** for that date.

## 5. Workspaces and resources

- **Workspaces → New Workspace**: a location or branch. Choose the **Services Offered Here**, then **Create
  Workspace**. Staff are added to a workspace from each staff member's form (**Workspaces**). A business with one
  location needs one workspace.
- **Resources → Add Resource** (optional): rooms or equipment that a booking needs.

## 6. Your public booking page

**Booking Pages → Create booking page**:

1. **Page Title** and Description (put any cancellation terms here).
2. **Page address**: the end of the link customers use, for example `main-clinic` gives
   `https://book.<your-domain>/book/main-clinic`.
3. **Page type**: the whole business, or one staff member (**Staff member**).
4. Choose the services offered on it; adjust Button Text, Header Text and Footer Text if you like, and check the
   desktop and mobile preview.
5. **Create & Publish** (or **Save as Draft** to publish later; **Unpublish** takes it offline).

Open the link on your phone and make one test booking with your own email address. The times offered come from
the business hours, the staff member's hours, existing bookings, buffers and the notice and advance rules.

## 7. Bookings

- **Appointments**: every booking, with search and filters (status, staff, dates). **New Appointment** books on a
  customer's behalf (Service & Staff, Date & Time, Customer — choose an existing one or enter Full Name, Email,
  Phone — and notes: **Customer-facing notes** are shown to the customer, **Internal notes** only to your team).
- Open a booking to **reschedule** it, **cancel** it, mark it **complete** or a **no-show**, and see its history and the
  emails sent about it.
- **Calendar**: the same bookings by Day, Week, Month or as an Agenda.
- **Customers**: everyone who has booked, with their number of bookings and last booking; **New Customer** adds one
  by hand.
- Customers who booked online can cancel or reschedule with the link in their confirmation email (once email is on).

## 8. Dashboard and reports

- **Dashboard**: today's and upcoming bookings and key figures, in your business time zone.
- **Reports**: choose a **Date range**; see **Booking Volume**, **Status Breakdown**, **By Service**, **By Staff**
  and **Top Customers**. The **Export** button is not available yet.

## 9. Email notifications

Email to customers and staff is switched on by your provider (it needs an email account for your domain). Until
they confirm it is on, bookings work but **no emails are sent**: each booking shows that no email was sent, so tell
customers their booking is confirmed on screen.

Once it is on, open **Notifications** (left menu):

- **Booking emails to customers**: confirmation, reschedule and cancellation emails (always on).
- **Reminders to customers** and **Reminder times**: when reminders go out (for example 24 hours and 2 hours before).
- **Alerts to staff**: emails to the staff member when their bookings change.
- **Business recipients**: other people at your business who should receive copies.
- **Email texts**: subject and opening text of each email, with a **Preview**.
- **Language for customers**: English or Hindi.
- **Delivery channels** shows whether email works and the latest problem, if any.

Text messages (SMS), WhatsApp and Google/Outlook calendar sync are **not switched on** for your business. Leave
those settings alone; ask your provider if you need them.

## 10. If something goes wrong

- **Forgotten password:** use **Forgot password?** on the sign-in page once email is on. Before that, contact your
  provider. Keep your recovery codes for two-factor sign-in.
- **A customer says they cannot see free times:** check the service is on the booking page, the staff member is
  **Active**, offers the service and has working hours that day, and the business is open that day.
- **Wrong times:** check **Settings → Language & Region → Timezone**.
- **Anything else:** contact your provider with the time it happened and what you saw; never send your password.
