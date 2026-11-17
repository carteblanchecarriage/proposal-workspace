// The project an RFP review or proposal comparison is being started for. Set by the project page's "Review the RFP"
// and "Compare proposals"; the review or comparison links itself to it when it finishes. In its own module so the
// project page and the tools can share it without importing each other.

let pending: { id: string; name: string } | null = null;
export const pendingProject = () => pending;
export const setPendingProject = (p: { id: string; name: string }) => (pending = p);
export const clearPendingProject = () => (pending = null);
