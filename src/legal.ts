// The Privacy, Terms and 404 pages: the site's font and styles, the current year, and the same cookie-free analytics
// as the app.
import "@fontsource-variable/inter";
import "./legal.css";
import { startAnalytics } from "./analytics";

document.querySelectorAll("[data-year]").forEach((el) => (el.textContent = String(new Date().getFullYear())));
startAnalytics();
