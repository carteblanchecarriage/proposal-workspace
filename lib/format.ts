// Formatting shared by the browser and the server: money, counts and dates, written the same way everywhere. No dependencies.

const DOLLARS = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });

/** Whole dollars, "$12,345"; "—" when there's no number. */
export const money = (n: number | null | undefined): string => (n == null || !Number.isFinite(n) ? "—" : DOLLARS.format(n));

/** A construction budget in few characters: "$1.2M", or whole dollars under a million. */
export const shortMoney = (n: number): string =>
  n >= 1e6 ? `$${(n / 1e6).toLocaleString("en-US", { maximumFractionDigits: 1 })}M` : money(n);

/** "1 firm", "3 firms". */
export const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? "" : "s"}`;

/** A day with its year: "Nov 19, 2026". */
export const dateText = (when: number | Date): string => new Date(when).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });

/** A day in few characters: "Nov 19" this year, "Nov 19, 2025" otherwise. */
export const shortDay = (when: number | Date): string => {
  const d = new Date(when);
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", ...(d.getFullYear() === new Date().getFullYear() ? {} : { year: "numeric" }) });
};
