# Workspaces — Complete Guide

## What is a workspace in WorkEasy360?

A workspace represents a physical location or branch of your business — for example, "Downtown Clinic", "East Branch", or "Virtual". Workspaces help you organize staff, services, and appointments by location.

## Viewing workspaces

Go to **Workspaces** (`/workspaces`) to see all locations listed. Each workspace shows its name, description, address, service count, and active/inactive status.

## Creating a workspace

1. Go to **Workspaces** → **New Workspace** (`/workspaces/new`) or click **+ New Workspace**.
2. Fill in the form:

### Basic Information
- **Workspace Name** (required) — the name of this location (e.g., "Downtown Clinic")
- **Description** (optional) — description shown to customers
- **Email** (optional, must be valid format) — contact email for this location
- **Phone** (optional) — contact phone for this location
- **Address** (optional) — physical street address (e.g., "123 Main St, City, State 12345")
- **Timezone** (optional) — timezone for this location (defaults to organization timezone)

### Brand Color
- Choose from 6 preset colors or pick a custom color — used to visually distinguish workspaces in the dashboard

### Working Hours
- Set specific working hours for this workspace by toggling each day and setting start/end times
- Saved for reference only: bookable times come from staff working hours and the business hours, not from workspace hours

### Active Status
- **Active** — workspace appears in booking pages and accepts appointments
- **Inactive** — hidden from customers, described as "Inactive workspaces are hidden from booking pages"

3. Click **Create Workspace**.

### Workspace validation errors
- "Workspace name is required" — name field is empty
- "Enter a valid email address" — email format is invalid

## Editing a workspace

1. Go to **Workspaces** (`/workspaces`).
2. Click on the workspace to open its detail page.
3. Click **Edit** or go to `/workspaces/:id/edit`.
4. Modify fields.
5. Click **Save Changes**.

## Workspace detail page

The workspace detail page at `/workspaces/:id` shows:
- Basic information (name, description, contact details, address)
- Working hours
- Assigned services
- Assigned staff
- Recent appointments at this location

## Assigning staff to a workspace

- **From the workspace form:** In the workspace edit form, there is a Staff section where you can select staff members.
- **From the staff form:** In the staff form sidebar, check the workspaces where this staff member works.

## Assigning services to a workspace

- **From the workspace form:** Check the services available at this workspace.
- **From the service form:** In the service form, the Workspaces section shows checkboxes for each workspace.

## Deactivating a workspace

1. Edit the workspace.
2. Toggle the **Active** status to Inactive.
3. Save.

Inactive workspaces are hidden from customers in booking pages. Existing appointments are not cancelled.

## Deleting a workspace

Open the workspace detail page, click **Delete**, confirm. Existing appointments that reference this workspace are not deleted.

## Workspace API endpoints

| Action | Method | URL |
|---|---|---|
| List workspaces | GET | /api/workspaces |
| Get one | GET | /api/workspaces/:id |
| Create | POST | /api/workspaces |
| Update | PUT | /api/workspaces/:id |
| Delete | DELETE | /api/workspaces/:id |

## Workspace fields reference

| Field | Required | Notes |
|---|---|---|
| name | Yes | Location display name |
| description | No | Customer-visible description |
| email | No | Contact email (valid format required) |
| phone | No | Contact phone |
| address | No | Physical address |
| timezone | No | Defaults to organization timezone |
| color | No | Hex color, default #00BF62 |
| isActive | No | Default true |
| workingHours | No | JSON object per day |
| serviceIds | No | Assigned service IDs |
| staffIds | No | Assigned staff IDs |

## Troubleshooting workspaces

**Workspace not showing on booking page** — Check that the workspace is set to Active.

**Services not available in a workspace** — Ensure the service is assigned to the workspace (edit the workspace and check the service, or edit the service and check the workspace).

**Staff not showing for a workspace** — The staff member must be assigned to this workspace in either the staff form or workspace form.
