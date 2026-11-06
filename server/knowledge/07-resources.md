# Resources — Complete Guide

## What are resources in WorkEasy360?

Resources are physical assets that can be reserved alongside appointments — for example, treatment rooms, examination tables, massage chairs, specialized equipment, or vehicles. When an appointment requires a resource, it is reserved to prevent double-booking.

## Resource types

| Type | Examples |
|---|---|
| Room | Treatment room, consultation room, studio |
| Equipment | Massage table, ultrasound machine, projector |
| Vehicle | Company car, delivery van |
| Table | Dining table, work table |
| Other | Any asset that doesn't fit above |

## Viewing resources

Go to **Resources** (`/resources`) to see all resources listed alphabetically. Each shows its name, type, capacity, and status.

## Creating a resource

1. Go to **Resources** → **New Resource** (`/resources/new`) or click **+ New Resource**.
2. Fill in the form:

### Basic Information
- **Resource Name** (required) — e.g., "Room A", "Massage Table 1"
- **Type** (required) — Room, Equipment, Vehicle, or Other
- **Capacity** (required, minimum 1) — how many appointments can use this resource simultaneously (usually 1)
- **Description** (optional) — details about this resource

### Availability Hours
- Set when the resource is available, by day and time slot
- Saved for reference only: resource availability and capacity are not checked when booking yet, so a resource is not protected from being booked twice at the same time

### Status (sidebar)
- **Active** — available for booking
- **Inactive** — not available, described as "Inactive — not available"

### Workspaces (sidebar)
- Check which workspaces this resource belongs to

### Assigned Services (sidebar)
- Check which services require this resource (the resource will be reserved when these services are booked)

3. Click **Create Resource**.

### Resource validation errors
- "Name is required" — name field is empty
- "Capacity must be at least 1" — capacity is less than 1

## Editing a resource

1. Go to **Resources** (`/resources`).
2. Click on the resource to open its detail page at `/resources/:id`.
3. Click **Edit** or go to `/resources/:id/edit`.
4. Modify the fields.
5. Click **Save Changes**.

## Resource detail page

The detail page at `/resources/:id` shows:
- Resource type, capacity, description
- Assigned workspaces
- Assigned services
- Availability hours

## Deactivating a resource

Edit the resource, toggle the Active status to Inactive, save. The resource will no longer be reservable for new appointments.

## Resource API endpoints

| Action | Method | URL |
|---|---|---|
| List resources | GET | /api/resources |
| Get one | GET | /api/resources/:id |
| Create | POST | /api/resources |
| Update | PUT | /api/resources/:id |
| Delete | DELETE | /api/resources/:id |

## How resources relate to appointments

When creating an appointment, you can optionally specify `resourceIds`. The appointment will reference those resources. Resource conflict checking (preventing two appointments from using the same resource at the same time) is planned but handled at the application level.

## Resource fields reference

| Field | Required | Notes |
|---|---|---|
| name | Yes | Resource display name |
| type | Yes | room/equipment/vehicle/table/other |
| capacity | Yes | Minimum 1 |
| description | No | Details about the resource |
| isActive | No | Default true |
| workspaceIds | No | Workspaces where this resource is located |
| serviceIds | No | Services that use this resource |
| availabilityRules | No | JSON map of availability by day |

## Troubleshooting resources

**Resource not appearing when creating an appointment** — Check that the resource is Active and is assigned to the service being booked.

**Resource shows as unavailable** — Check the availability hours set for the resource. If the requested time is outside the resource's availability, it won't be offered.
