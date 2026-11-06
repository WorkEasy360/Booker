# Getting Started with WorkEasy360

## Creating an account (signup)

1. Go to `/signup` or click **Sign Up** on the login page.
2. Fill in the signup form:
   - **Full Name** — your name (required)
   - **Work Email** — your email address (required, must be valid format)
   - **Company / Business Name** — your organization name (required)
   - **Password** — minimum 8 characters, must contain at least one uppercase letter and one number
   - **Confirm Password** — must match the password field
3. Click **Create Account**. The page says **Check your email**.
4. Open the link in the email and click **Confirm my email**. The link works once and expires after 24 hours; the "Check your email" page can send a new one (a new link replaces the previous one).
5. Sign in at `/login` with your email and password. You are not signed in automatically.

### Signup validation rules
- Name: required, cannot be blank
- Email: must be a valid email format
- Company: required, cannot be blank
- Password: at least 8 characters, at least one uppercase letter, at least one number
- Confirm password: must exactly match the password

### Signup errors
- Signing up always answers "We’ll send an email with the next steps if the address can be used for this request." If the address already has an account, the email explains how to sign in or reset the password instead
- "Email is not set up on this server" — the server administrator must configure email before anyone can sign up
- "Password must be at least 8 characters"
- "Password must contain at least one uppercase letter"
- "Password must contain at least one number"
- "Passwords do not match"

## Logging in

1. Go to `/login`.
2. Enter your **Email** and **Password**.
3. Click **Sign In**.

### Login errors
- Incorrect email or password → "Invalid email or password"
- If you forgot your password, reset it (see below).

## Reset a forgotten password

Owners, managers and staff all reset a forgotten password the same way:

1. On the sign-in page (`/login`), click **Forgot password?** below the password field.
2. Enter your email address and click **Send reset link**.
3. Open the reset link in the email. It works once and expires after 60 minutes; asking again replaces the earlier link.
4. Choose a new password (at least 8 characters, one uppercase letter, one number) and click **Save new password**.
5. You are signed out on every device. Sign in with the new password.

No email? Check the spam folder and use the newest email. If the page says "Email is not set up on this server", the server administrator must configure email first.

## First-time setup after login

After signing up, complete these steps before accepting bookings:

### Step 1: Complete your Business Profile
1. Go to **Settings** → **Business** (`/settings/business`).
2. Enter your business name, email, phone, website, address, and country.
3. Click **Save**.

### Step 2: Set your Working Hours
1. Go to **Settings** → **Hours** (`/settings/hours`).
2. Toggle on each day your business is open.
3. Set the opening and closing times for each active day.
4. Optionally click **Apply to all active days** to copy one day's hours to all enabled days.
5. Click **Save Changes**. From then on, staff can only be booked inside these hours.

### Step 3: Configure Booking Rules
1. Go to **Settings** → **Booking** (`/settings/booking`).
2. Set your default appointment duration, buffer time, minimum booking notice, and advance booking window.
3. Click **Save**.

### Step 4: Create your first Workspace
1. Go to **Workspaces** → **New Workspace** (`/workspaces/new`).
2. Enter the workspace name and details.
3. Click **Create Workspace**.

### Step 5: Create your first Service
1. Go to **Services** → **New Service** (`/services/new`).
2. Enter the service name, duration, price, and assign staff.
3. Click **Create Service**.

### Step 6: Add Staff
1. Go to **Staff** → **New Staff** (`/staff/new`).
2. Enter the staff member's name, email, and working hours.
3. Assign them to workspaces and services.
4. Click **Create Staff**.

### Step 7: Create a Booking Page
1. Go to **Booking Pages** → **New Booking Page** (`/booking-pages/new`).
2. Set a title and URL slug (e.g., "my-clinic" makes the URL `/book/my-clinic`).
3. Publish the page.
4. Share the link with your customers.

## Changing your password

1. Go to **Settings** → **Security** (`/settings/security`).
2. In the **Change Password** section, enter your current password.
3. Enter and confirm your new password.
4. Click **Update Password**.

Password requirements: at least 8 characters, one uppercase letter, one number.

## Your user profile

Your current user information is displayed in the sidebar (name, email, role). You can see your role (admin, manager, or staff) but cannot change it from the dashboard — contact your administrator.
