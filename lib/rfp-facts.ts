// The facts every RFP review records. In its own module so the browser can name them without loading lib/claude.ts.
export const RFP_FACTS = {
  location: "Location",
  building_size: "Building size",
  construction_budget: "Construction budget",
  delivery_method: "Delivery method",
  phases: "Phases",
  fee_format: "Fee format",
  contract: "Contract",
  insurance: "Insurance",
  page_limit: "Page limit",
  submission: "Submission format",
  contact: "Contact",
} as const;
export type RfpFactKey = keyof typeof RFP_FACTS;
