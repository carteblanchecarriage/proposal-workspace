import { inject } from "@vercel/analytics";

/**
 * Vercel Web Analytics: cookie-free page views and referrers, to see whether sharing the site works. Turned on in the
 * Vercel project (Analytics tab); until then the script does nothing. Only the page's path is sent: never the part
 * after # (which names records, e.g. #rfp/<id>) or the query string. Off in local development.
 */
export function startAnalytics() {
  if (!import.meta.env.PROD) return;
  inject({
    beforeSend: (event) => {
      const u = new URL(event.url);
      return { ...event, url: `${u.origin}${u.pathname}` };
    },
  });
}
