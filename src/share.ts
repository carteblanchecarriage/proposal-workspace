/** "#rfp/<id>" → { tab: "rfp", id }. */
export function parseHash(): { tab: string; id: string | null } {
  const [tab, id] = location.hash.slice(1).split("/");
  return { tab: tab ?? "", id: id ? decodeURIComponent(id) : null };
}
