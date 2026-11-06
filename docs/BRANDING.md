# Branding: WorkeasyBooking

WorkeasyBooking is a product of WorkEasy360. It is a multi-business platform, so two kinds of branding appear in
it, and they must not be mixed up:

- **Platform branding**: WorkeasyBooking, the product people sign in to.
- **Business branding**: each business's own name, booking-page title, colour, header and footer text. This is tenant
  data. It always comes from that business's records and is never replaced by the platform's.

## The identity

| | |
|---|---|
| Product name | WorkeasyBooking |
| Company | WorkEasy360 |
| Attribution | A WorkEasy360 Product |
| Short description | Smart appointment scheduling for businesses |
| Colours | primary `#00BF62`, secondary green `#008F49`, dark navy `#13222E`, accent yellow `#FFC940` |

The strings and colours are defined once per package. Never type them by hand.

- Web app: `src/lib/brand.ts`. It also has the tab-title helpers `pageTitle()` and `businessPageTitle()`, and
  `copyrightNotice()`. The colours are the Tailwind tokens `primary`, `primary-dark`, `navy` and `accent`.
- Emails: `server/src/brand.ts`.
- `tests/unit/brand.test.ts` fails if the two files differ, if the Tailwind colours drift, or if `index.html`, the
  web manifest or the icons stop matching.

## Components (`src/components/brand`)

| Component | Use |
|---|---|
| `ProductLogo` | The official "W" mark followed by the name "WorkeasyBooking": one accessible name, "WorkeasyBooking". `tone="dark"` on navy backgrounds; `layout="stacked"` (compact sizes) where space is narrow. The full logo artwork is not used for the product, because its wordmark spells the company name. |
| `ProductMark` | The official "W" mark alone: collapsed navigation, the phone header, credit lines. |
| `ProductAttribution` | "A WorkEasy360 Product". |
| `AppFooter` | Footer of the signed-in app. |
| `PoweredByFooter` | "Powered by WorkeasyBooking" at the foot of a business's public pages. |
| `PlatformFooter` | Attribution and copyright on pages that belong to no business. |
| `BrandedLoader` | Full-screen loading state while the session is checked. |

`src/pages/RouteErrorPage.tsx` is the branded error page. On public pages, `BusinessIdentity` (in
`src/features/public-booking`) shows the business's own initial and name.

## Where the brand appears

| Place | What it shows |
|---|---|
| Sign-in, sign-up, staff invitation, forgot password, reset password and confirm email pages | Product logo, description, "A WorkEasy360 Product", copyright. The invitation's heading is the business being joined. |
| Signed-in app | Product logo in the navigation: the mark when collapsed, and the drawer on phones (the phone header has no room for it). The business's own name sits under it. The help menu has an About block, and the footer reads "WorkeasyBooking · A WorkEasy360 Product · © year WorkEasy360". |
| Loading, connection-error, error and 404 pages | Product logo; attribution and copyright on full-page ones. |
| A business's booking, confirmation and manage pages | The business leads: its page heading, name and colour. The platform appears only as the "Powered by WorkeasyBooking" credit at the bottom. |
| `/book` entry page (belongs to no business) | Product logo, description, attribution. |
| Browser tabs | "Page — WorkeasyBooking". On a business's pages the business comes first: "Booking confirmed · Glow Studio — WorkeasyBooking". |
| Favicon, home-screen icon, web manifest, page metadata | The official mark; product name and description (`index.html`, `public/site.webmanifest`). |
| Emails (confirmation, reschedule, cancellation, staff invitation) | A text "WorkeasyBooking" header. The business's name opens the message and signs it. The footer reads "Sent by WorkeasyBooking on behalf of {business}. WorkeasyBooking · A WorkEasy360 Product". |
| Account emails (sign-up confirmation, sign-in help, password reset, password changed) | The platform's own: the text "WorkeasyBooking" header, and the product name where booking emails show the business's name. The footer reads "Sent by WorkeasyBooking. WorkeasyBooking · A WorkEasy360 Product". |

Rules:

- **Keep one product logo per screen.** Small marks in credit lines are fine. The browser suite checks this.
- **Never put platform branding where a business's identity belongs.** That means a business's page heading, its
  booking-page colour, and the subject line of a booking email.
- **No internal identifiers in any branded surface.** That covers organization, appointment, staff and service IDs.

## Emails

Emails use a text-based header rather than images, so nothing can be blocked, broken or tracked. They use tables and
inline styles only. The sender name is configuration (`EMAIL_FROM`, see `EMAIL.md`). On a platform shared by several
businesses, use the product name, for example `WorkeasyBooking <bookings@mail.yourdomain.com>`; each email names
the business it is for.

## Logo files

The official artwork is kept unchanged as the source:

- `src/assets/logo-full.png`: full logo for light backgrounds.
- `src/assets/logo-white.png`: full logo for dark backgrounds.
- `src/assets/logo-icon.png`: the mark.
- `public/favicon.png`: the mark, 4500 px; no longer linked.

The app loads right-sized copies, about 20 KB instead of about 850 KB per logo:

- `src/assets/brand/workeasy360-logo.png` and `workeasy360-logo-white.png`: 742 × 120, trimmed (company logo; not
  used by the product logo since the rename to WorkeasyBooking).
- `src/assets/brand/workeasy360-mark.png`: 128 × 128.
- `public/brand/favicon-32.png`, `icon-192.png`, `icon-512.png`, and `apple-touch-icon.png` (180 px, on white:
  iOS shows transparency as black).

If the official artwork changes, replace the originals and regenerate the copies (Windows, no extra dependencies):

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\make-brand-assets.ps1 -Root (Get-Location).Path
```

`public/favicon.svg` is a generic placeholder icon, not WorkEasy360 artwork, and is not linked.
