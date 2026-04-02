# Visualping Cloud Monitoring Chrome Extension

A Chrome extension that helps create and manage Visualping Cloud monitoring jobs directly from the page you are viewing.

The extension currently focuses on four things:

- Detecting whether the user has an active Visualping Cloud session
- Creating a new monitoring job for the current tab with a custom alert condition and check frequency
- Showing tracked jobs created for the current site inside the popup
- Keeping browser cookies synced into the related Visualping Cloud job so authenticated or personalized pages can be monitored reliably

## Behavior

When the popup opens on a normal website page:

- If there is no usable Visualping session, the popup shows a button that opens [Visualping login](https://visualping.io/login)
- If the user is logged in, the popup shows:
  - the current page title and URL
  - an `Alert me when` field
  - a `Frequency of checking` selector
  - a button to create a new monitoring job
  - a list of tracked jobs for that hostname, including sync status, cookie count, and last sync time

After a job is created, the background service worker listens to `chrome.cookies.onChanged` and updates tracked Visualping Cloud jobs whose host matches the changed cookie domain.

## How It Works

- The extension loads config from `https://localhost:3000/config.json` first, then falls back to cached config, then finally to production Visualping endpoints.
- Login detection reads the Visualping `idToken` cookie and validates it with `GET /describe-user`.
- Job creation uses the session-backed `jobServiceEndpointV2URL` flow used by Visualping's web app.
- Cookie sync stores browser cookies in Visualping `preactions.actions[]` as `cookie` actions shaped like:

```json
{
  "cookie": {
    "field": "session",
    "value": "abc123",
    "domain": "example.com"
  }
}
```

## Load in Chrome

1. Open `chrome://extensions`
2. Enable `Developer mode`
3. Click `Load unpacked`
4. Select this folder:
   `/Users/mohsen/workspace/vp-cloud-chrome-ext`

## References

- [Visualping API docs](https://api.visualping.io/)
- [visualping-api-skill](https://github.com/webmonitoring/visualping-api-skill)

## Scope And Limitations

- The extension relies on Visualping's `idToken` cookie. If the session expires, the popup will ask the user to log in again.
- Site cookie access is requested per monitored origin the first time a job is created for that site.
- Job management currently means creating jobs, listing tracked jobs for the active site, and keeping their cookie preactions updated. The popup does not yet expose full edit or delete controls for existing jobs.
