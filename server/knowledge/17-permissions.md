# Roles and Permissions — Guide

## User roles in WorkEasy360

WorkEasy360 has three user roles that control what actions a user can perform:

| Role | Description |
|---|---|
| admin | Full access to all features and settings |
| manager | Runs appointments, customers, services, resources, booking pages and reports; no staff management or business settings |
| staff | Views their own appointments only |

Note: The UI shows "Owner", "Admin", "Staff", and "Viewer" labels in some screens. These correspond to admin (admin or owner), manager, staff, and a read-only variant. The backend uses admin/manager/staff.

## What each role can do

### Admin role
- Full access to all dashboard features
- Create, edit, delete: appointments, services, staff, workspaces, resources, customers, booking pages
- Add staff members, change their working hours, and invite them to sign in
- View reports
- Change all business settings (profile, working hours, booking rules, time zone)
- Change password and security settings
- Use the AI assistant and maintain its knowledge index

### Manager role
- Create, reschedule and cancel appointments for any staff member
- Manage customers, services, resources and booking pages
- Resend booking emails
- View reports and use the AI assistant
- Cannot add, edit or deactivate staff members, change their working hours, or invite them to sign in
- Cannot create or edit workspaces
- Cannot change business settings (business profile, working hours, booking rules, time zone)

### Staff role
- View their own appointments only
- Cannot create, change or cancel appointments, including changing the status of their own appointments
- Cannot access reports, customers or other staff members' appointments, and cannot change settings

## Signing in and sessions

Sign in at `/login` with your email address and password. The server keeps the session (7 days by default) and ends it when you sign out, change your password, or when an administrator turns off your sign-in. Wrong sign-ins get one generic message ("Invalid email or password"), and repeated failures are temporarily blocked.

In the browser the session is a secure, HTTP-only cookie, and every change is also checked against a security token sent with the request. API clients can send the session as `Authorization: Bearer <token>` instead.

## Signup and first user

When you sign up at `/signup` and confirm the emailed link, you become an Admin of your new organization. The first user is always created with the Admin role.

## Role enforcement

- Every action is checked on the server against the signed-in user's role; hiding a button in the UI is never the only protection
- All data queries are automatically scoped to the organization — users cannot access another organization's data
- All authenticated routes enforce organization isolation: you cannot see or modify another organization's appointments, customers, staff, services, etc.

## Changing user roles

Staff and managers get their role when they are invited (see "Inviting a staff member to sign in" in the Staff guide). The role of an existing sign-in cannot be changed from the dashboard yet. The Settings → Roles page shows a read-only permission matrix.

## Tenant isolation

WorkEasy360 is a multi-tenant system. Each organization's data is completely isolated:
- All tables include an `organization_id` column
- All queries are filtered by the authenticated user's organization
- Users cannot access data from other organizations even with a valid session

## Permission errors

| Code | Message | Cause |
|---|---|---|
| 401 | "Authentication required" | Not signed in |
| 401 | "Your session has ended. Please sign in again." | Signed out, password changed, sign-in turned off, or session expired |
| 403 | "Security check failed. Refresh the page and try again." | The page's security token is missing or out of date |
| 403 | "You do not have permission to do this" | The role does not allow the action |
| 404 | Not found | Accessing a record from another organization (treated as not found) |
