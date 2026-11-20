// Sample data for the demo: a fictional firm pursuing a fictional library renovation. Everything here is made up
// (township, firms, people, numbers). Loaded only when someone opens the demo, and kept in memory: nothing is saved.
// Dates are set relative to today so the demo always looks current.

import type { Comparison, Proposal, Rfp } from "../../lib/claude";
import { DISCIPLINES } from "../../lib/disciplines";
import { DEFAULT_PHASES, DEFAULT_SECTIONS, type Pursuit, type WorldView } from "../../lib/worldview";
import { DEFAULT_ROLES, TEMPLATES, templatePhases } from "../fee-templates";
import { createMediumTemplate } from "../schedule/lib/data/sample.js";
import type { CallSource, SavedComparison, SavedConsultant, SavedFee, SavedProject, SavedRfp, SavedSchedule } from "../store";
import type { Sourced } from "../table";

const DAY = 24 * 60 * 60 * 1000;
const now = Date.now();
const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const inDays = (n: number) => new Date(now + n * DAY);
/** n days out, moved to the Monday after when it lands on a weekend (RFP deadlines and walkthroughs are weekdays). */
export const weekdayIn = (n: number) => {
  const d = inDays(n);
  const shift = d.getDay() === 6 ? 2 : d.getDay() === 0 ? 1 : 0;
  return new Date(d.getTime() + shift * DAY);
};
const say = (d: Date) => d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });

const PROJECT_ID = "demo-project-library";
const RFP_ID = "demo-rfp-library";
const CMP_ID = "demo-cmp-mep";
const PROJECT_NAME = "Maple Hollow Library Renovation + Addition";

// ---------- The RFP review ----------

const due = weekdayIn(19);
const walk = weekdayIn(6);
const questionsDue = weekdayIn(11);
const interviews = weekdayIn(40);

const requested: Record<string, ["yes" | "no" | "unclear", string, number]> = {
  Architecture: ["yes", "Prime consultant: renovation of the 1968 building and a 6,500 SF addition.", 4],
  Interiors: ["yes", "Interior finishes and wayfinding for the whole building.", 4],
  "FF&E": ["yes", "Shelving, seating and children's area furniture; procurement support.", 5],
  "Hazardous Materials": ["yes", "Asbestos survey reported in floor tile and pipe insulation (Appendix C).", 6],
  Geotechnical: ["yes", "Borings for the addition footprint.", 5],
  Civil: ["yes", "Parking expansion (22 spaces) and stormwater management.", 5],
  Landscape: ["yes", "Reading garden and site planting.", 5],
  Structural: ["yes", "New addition; evaluate the existing roof for rooftop units.", 5],
  "Laboratory Design": ["no", "", 0],
  "Food Service": ["no", "", 0],
  "Fire Protection": ["yes", "New sprinkler system for the existing building (currently unsprinklered).", 6],
  Plumbing: ["yes", "Restroom expansion to meet current code.", 6],
  Mechanical: ["yes", "Replace 1990s rooftop units; evaluate geothermal per the Township's sustainability goals.", 6],
  Electrical: ["yes", "Service upgrade, LED lighting, EV charging rough-in for 4 spaces.", 6],
  Acoustics: ["unclear", "The quiet reading room and new meeting room need sound isolation, but the RFP doesn't say whether that's a separate consultant.", 4],
  "Cost Estimating": ["unclear", "Estimates are required at SD, DD and 95% CD, but the RFP doesn't say whether by the architect's team or the Township's construction manager.", 7],
};

const rfp: Rfp = {
  fit: {
    verdict: "pursue",
    reasons: [
      "Civic library renovation with an addition: squarely the kind of work we want more of.",
      "Budget ($7.8M) is in our sweet spot, and fee is only 20% of the RFP's scoring, so qualifications decide it.",
      "We know the county's permitting process from two recent projects nearby.",
      "Watch the schedule: substantial completion is tight for a phased, occupied renovation.",
    ],
  },
  project_name: PROJECT_NAME,
  client: "Township of Maple Hollow",
  summary:
    "The Township of Maple Hollow is selecting an architect to renovate its 18,000 SF public library (built 1968) and design a 6,500 SF addition for a children's wing and community room. The library stays open during construction, so the work must be phased. The Township wants a design that meets its 2030 sustainability goals and is evaluating geothermal heating and cooling.",
  facts: {
    location: { value: "410 Orchard Lane, Maple Hollow", page: 2 },
    building_size: { value: "18,000 SF existing + 6,500 SF addition", page: 3 },
    construction_budget: { value: "$7.8M construction", page: 3 },
    delivery_method: { value: "Design-bid-build, multiple prime contracts", page: 3 },
    phases: { value: "Programming through Construction Administration and closeout", page: 4 },
    fee_format: { value: "Lump sum by phase, separate sealed envelope", page: 8 },
    contract: { value: "AIA B101 with Township amendments (Appendix D)", page: 9 },
    insurance: { value: "Professional liability $2M per claim", page: 9 },
    page_limit: { value: "20 pages, excluding resumes and cover letter", page: 8 },
    submission: { value: "One PDF by email, plus 5 printed copies", page: 8 },
    contact: { value: "Dana Whitfield, Township Manager, dwhitfield@example.org", page: 1 },
  },
  services: DISCIPLINES.map((d) => {
    const [req, detail, page] = requested[d] ?? ["unclear", "", 0];
    return { discipline: d, requested: req, detail, page };
  }),
  dates: [
    { label: "Mandatory pre-proposal walkthrough", date: iso(walk), when: `${say(walk)}, 10:00 AM`, mandatory: true, page: 2 },
    { label: "Questions due", date: iso(questionsDue), when: `${say(questionsDue)}, 4:00 PM`, mandatory: false, page: 2 },
    { label: "Proposals due", date: iso(due), when: `${say(due)}, 2:00 PM`, mandatory: true, page: 2 },
    { label: "Shortlist interviews", date: iso(interviews), when: `Week of ${say(interviews)}`, mandatory: false, page: 2 },
    { label: "Substantial completion", date: "", when: "Summer, two years out", mandatory: false, page: 4 },
  ],
  watch_outs: [
    { critical: true, title: "Fee in a separate sealed envelope", detail: "Proposals that show fees in the main submission are disqualified.", page: 8 },
    { critical: true, title: "Walkthrough is mandatory", detail: "Firms that miss the walkthrough can't propose. Sign in at the front desk.", page: 2 },
    { critical: false, title: "Library stays open", detail: "The design and schedule must show how the building stays open in phases.", page: 4 },
    { critical: false, title: "Geothermal feasibility", detail: "A geothermal study is asked for in Schematic Design, but no budget is given for test wells.", page: 6 },
    { critical: false, title: "Contract amendments", detail: "Appendix D adds a broad indemnity clause; flag for review.", page: 9 },
  ],
  questions: [
    "Is the cost estimate by our team, or by the Township's construction manager?",
    "Will the Township fund geothermal test wells, or should we carry an allowance?",
    "Can the children's wing open before the main renovation finishes?",
    "Is there an existing hazardous materials report beyond the summary in Appendix C?",
  ],
  scoring: [
    { criterion: "Relevant library and civic experience", weight: "30%" },
    { criterion: "Approach to phasing an occupied building", weight: "25%" },
    { criterion: "Team qualifications", weight: "25%" },
    { criterion: "Fee", weight: "20%" },
  ],
  outline: {
    page_limit: "20 pages (resumes and cover letter don't count)",
    pages: [
      { pages: "—", section: "Cover Letter", content: ["Why us, in one page", "Single point of contact"], answers: "Required cover letter" },
      { pages: "1–3", section: "Project Understanding", content: ["The library's role in Maple Hollow", "What the addition adds", "Sustainability goals"], answers: "Section 3.1" },
      { pages: "4–8", section: "Project Approach", content: ["Phasing plan that keeps the library open", "Community engagement", "Geothermal feasibility"], answers: "Section 3.2, scored 25%" },
      { pages: "9–12", section: "Project Team", content: ["Org chart", "Consultant team", "Availability"], answers: "Section 3.3" },
      { pages: "13–18", section: "Relevant Project Experience", content: ["Three libraries", "Two occupied renovations"], answers: "Section 3.4, scored 30%" },
      { pages: "19–20", section: "Notes + Qualifications", content: ["Assumptions", "Exclusions"], answers: "Section 3.6" },
    ],
    format: [
      { rule: "8.5 × 11 pages, 11-point minimum", page: 8 },
      { rule: "Fee in a separate sealed envelope", page: 8 },
    ],
    notes: ["Lead with phasing: it's 25% of the score and the Township's biggest worry."],
  },
};

// ---------- Three consultant proposals (MEP + fire protection) ----------

const scope = (status: "included" | "excluded" | "optional", category: string, description: string, page: number, phase: string | null = null) => ({
  category,
  description,
  phase,
  status,
  page,
});

const base = {
  contact: null,
  project_name: PROJECT_NAME,
  reimbursables: null,
  hourly_rates: [] as Proposal["hourly_rates"],
  ca_site_visits: null,
  schedule: null,
  payment_terms: "Monthly, net 30",
  exclusions: [] as string[],
  assumptions: [] as string[],
  deliverables: [] as string[],
  clarifications: [] as string[],
  extraction_notes: [] as string[],
};

const copperleaf: Sourced = {
  ...base,
  firm: "Copperleaf Engineering",
  contact: "Ravi Menon, PE, Principal",
  proposal_date: iso(inDays(-3)),
  disciplines: ["Mechanical", "Electrical", "Plumbing", "Fire Protection"],
  fee_structure: "Lump sum by phase",
  fee_items: [
    { id: 1, scenario: null, phase: "SD", label: "Schematic Design", kind: "fee", basis: "fixed", amount: 38_000, percent: null, page: 3 },
    { id: 2, scenario: null, phase: "DD", label: "Design Development", kind: "fee", basis: "fixed", amount: 52_000, percent: null, page: 3 },
    { id: 3, scenario: null, phase: "CD", label: "Construction Documents", kind: "fee", basis: "fixed", amount: 86_000, percent: null, page: 3 },
    { id: 4, scenario: null, phase: "BID", label: "Bidding", kind: "fee", basis: "fixed", amount: 8_000, percent: null, page: 3 },
    { id: 5, scenario: null, phase: "CA", label: "Construction Administration", kind: "fee", basis: "fixed", amount: 41_000, percent: null, page: 3 },
    { id: 6, scenario: null, phase: "OTHER", label: "Reimbursable expenses (allowance)", kind: "expense", basis: "allowance", amount: 3_500, percent: null, page: 3 },
  ],
  additional_services: [
    { description: "Geothermal feasibility study", amount: 14_500, basis: "lump sum" },
    { description: "Energy model (LEED)", amount: 9_000, basis: "lump sum" },
  ],
  reimbursables: "Allowance of $3,500 for printing and travel",
  hourly_rates: [
    { role: "Principal", rate: 235 },
    { role: "Senior Engineer", rate: 185 },
    { role: "Designer", rate: 130 },
  ],
  ca_site_visits: "12 site visits plus punch list",
  schedule: "SD in 6 weeks; CDs in 10 weeks after DD approval",
  scope_items: [
    scope("included", "Mechanical", "New rooftop units and controls", 2, "SD–CA"),
    scope("optional", "Mechanical", "Geothermal feasibility study", 4),
    scope("included", "Electrical", "Service upgrade and new switchgear", 2),
    scope("included", "Electrical", "LED lighting and controls", 2),
    scope("included", "Electrical", "EV charging rough-in", 2),
    scope("included", "Plumbing", "Restroom expansion", 2),
    scope("included", "Fire Protection", "Sprinkler design for the existing building", 2),
    scope("optional", "Commissioning", "Energy model for LEED", 4),
    scope("excluded", "Commissioning", "Building commissioning", 5),
  ],
  exclusions: ["Building commissioning", "Utility company fees"],
  assumptions: ["Existing drawings are available and reasonably accurate", "One round of value engineering"],
  deliverables: ["Drawings and specifications at SD, DD, 50% and 100% CD"],
  source_file: "Copperleaf - MEP Proposal.pdf",
};

const halvorsen: Sourced = {
  ...base,
  firm: "Halvorsen Lake Engineers",
  contact: "Ingrid Halvorsen, PE",
  proposal_date: iso(inDays(-2)),
  disciplines: ["Mechanical", "Electrical", "Plumbing", "Fire Protection"],
  fee_structure: "Lump sum, single total",
  fee_items: [
    { id: 1, scenario: null, phase: "MULTI", label: "Basic services (SD through CA)", kind: "fee", basis: "fixed", amount: 198_000, percent: null, page: 6 },
    { id: 2, scenario: null, phase: "OTHER", label: "Reimbursables", kind: "expense", basis: "not_to_exceed", amount: 2_500, percent: null, page: 6 },
  ],
  additional_services: [{ description: "Geothermal feasibility study, including test well oversight", amount: 18_000, basis: "lump sum" }],
  reimbursables: "Not to exceed $2,500",
  hourly_rates: [
    { role: "Principal", rate: 210 },
    { role: "Project Engineer", rate: 165 },
  ],
  ca_site_visits: "Monthly site visits during construction (about 14)",
  schedule: "Matches the Township's schedule",
  scope_items: [
    scope("included", "Mechanical", "New rooftop units and controls", 3),
    scope("optional", "Mechanical", "Geothermal feasibility study", 6),
    scope("included", "Electrical", "Service upgrade and new switchgear", 3),
    scope("included", "Electrical", "LED lighting and controls", 3),
    scope("included", "Plumbing", "Restroom expansion", 3),
    scope("included", "Fire Protection", "Sprinkler design for the existing building", 3),
    scope("included", "Commissioning", "Building commissioning", 4),
  ],
  exclusions: ["Energy modeling"],
  assumptions: ["Township provides a hazardous materials report before DD"],
  deliverables: ["Drawings and specifications; commissioning plan and report"],
  clarifications: ["Fee is not broken down by phase; ask for a split."],
  source_file: "Halvorsen Lake - Proposal.pdf",
};

const twinSpruce: Sourced = {
  ...base,
  firm: "Twin Spruce MEP",
  contact: "Marcus Bell, PE",
  proposal_date: iso(inDays(-1)),
  disciplines: ["Mechanical", "Electrical", "Plumbing"],
  fee_structure: "Lump sum by phase",
  fee_items: [
    { id: 1, scenario: null, phase: "SD", label: "Schematic Design", kind: "fee", basis: "fixed", amount: 29_000, percent: null, page: 2 },
    { id: 2, scenario: null, phase: "DD", label: "Design Development", kind: "fee", basis: "fixed", amount: 41_000, percent: null, page: 2 },
    { id: 3, scenario: null, phase: "CD", label: "Construction Documents", kind: "fee", basis: "fixed", amount: 69_000, percent: null, page: 2 },
    { id: 4, scenario: null, phase: "BID", label: "Bidding", kind: "fee", basis: "fixed", amount: 6_000, percent: null, page: 2 },
    { id: 5, scenario: null, phase: "CA", label: "Construction Administration", kind: "fee", basis: "hourly", amount: 30_000, percent: null, page: 2 },
  ],
  additional_services: [],
  reimbursables: "Billed at cost plus 10%",
  hourly_rates: [
    { role: "Principal", rate: 195 },
    { role: "Engineer", rate: 150 },
  ],
  ca_site_visits: "6 site visits",
  schedule: null,
  scope_items: [
    scope("included", "Mechanical", "New rooftop units and controls", 1),
    scope("included", "Electrical", "Service upgrade and new switchgear", 1),
    scope("included", "Electrical", "LED lighting and controls", 1),
    scope("included", "Plumbing", "Restroom expansion", 1),
    scope("excluded", "Fire Protection", "Sprinkler design", 3),
  ],
  exclusions: ["Fire protection design (by others)", "Geothermal", "Commissioning"],
  assumptions: ["CA billed hourly up to the amount shown"],
  deliverables: ["Drawings and specifications"],
  source_file: "Twin Spruce - Fee Proposal.pdf",
};

const proposals = [copperleaf, halvorsen, twinSpruce];

const status = (firm_index: number, s: "included" | "excluded" | "optional" | "not_mentioned", note: string | null = null, page = 0) => ({
  firm_index,
  status: s,
  note,
  page,
});

const cmp: Comparison = {
  briefing: {
    headline: "Copperleaf is the most complete; Twin Spruce is cheapest but leaves out fire protection and geothermal.",
    overview:
      "All three cover the core MEP work. Copperleaf ($225,000 base) breaks out every phase and offers both studies the Township asked about. Halvorsen Lake ($198,000) includes commissioning but gives one lump sum with no phase split. Twin Spruce ($175,000) is lowest, but excludes fire protection, which the RFP requires, and bills CA hourly with only 6 site visits.",
    flags: [
      { level: "high", title: "Fire protection missing", detail: "Twin Spruce excludes sprinkler design, which the RFP requires for the existing building. Their price isn't comparable until it's added.", firm_indexes: [2] },
      { level: "medium", title: "No phase breakdown", detail: "Halvorsen Lake quotes one total for SD through CA. Ask for a split to compare and to bill against.", firm_indexes: [1] },
      { level: "medium", title: "Few CA site visits", detail: "Twin Spruce allows 6 visits for an 18-month phased construction; the others allow 12–14.", firm_indexes: [2] },
      { level: "low", title: "Commissioning differs", detail: "Only Halvorsen Lake includes commissioning; Copperleaf excludes it.", firm_indexes: [0, 1] },
    ],
    questions: [
      { firm_index: 0, items: ["Would you include commissioning, and at what fee?"] },
      { firm_index: 1, items: ["Please split the fee by phase.", "Does the geothermal study include test well oversight in the base fee?"] },
      { firm_index: 2, items: ["Please add fire protection design to your scope and fee.", "Can you allow 12 site visits during CA?"] },
    ],
  },
  scenarios: [],
  fee_rows: [
    { section: "Basic services", label: "Schematic Design", cells: [{ firm_index: 0, item_ids: [1], note: null }, { firm_index: 1, item_ids: [], note: "in total" }, { firm_index: 2, item_ids: [1], note: null }] },
    { section: "Basic services", label: "Design Development", cells: [{ firm_index: 0, item_ids: [2], note: null }, { firm_index: 1, item_ids: [], note: "in total" }, { firm_index: 2, item_ids: [2], note: null }] },
    { section: "Basic services", label: "Construction Documents", cells: [{ firm_index: 0, item_ids: [3], note: null }, { firm_index: 1, item_ids: [], note: "in total" }, { firm_index: 2, item_ids: [3], note: null }] },
    { section: "Basic services", label: "Bidding", cells: [{ firm_index: 0, item_ids: [4], note: null }, { firm_index: 1, item_ids: [], note: "in total" }, { firm_index: 2, item_ids: [4], note: null }] },
    { section: "Basic services", label: "Construction Administration", cells: [{ firm_index: 0, item_ids: [5], note: null }, { firm_index: 1, item_ids: [], note: "in total" }, { firm_index: 2, item_ids: [5], note: "hourly, up to" }] },
    { section: "Basic services", label: "SD through CA (lump sum)", cells: [{ firm_index: 0, item_ids: [], note: null }, { firm_index: 1, item_ids: [1], note: null }, { firm_index: 2, item_ids: [], note: null }] },
    { section: "Expenses", label: "Reimbursables", cells: [{ firm_index: 0, item_ids: [6], note: "allowance" }, { firm_index: 1, item_ids: [2], note: "not to exceed" }, { firm_index: 2, item_ids: [], note: "cost + 10%" }] },
  ],
  categories: [
    {
      name: "Mechanical",
      items: [
        { item: "New rooftop units and controls", statuses: [status(0, "included", null, 2), status(1, "included", null, 3), status(2, "included", null, 1)] },
        { item: "Geothermal feasibility study", statuses: [status(0, "optional", "$14,500", 4), status(1, "optional", "$18,000, with test well oversight", 6), status(2, "excluded", null, 3)] },
      ],
    },
    {
      name: "Electrical",
      items: [
        { item: "Service upgrade and switchgear", statuses: [status(0, "included", null, 2), status(1, "included", null, 3), status(2, "included", null, 1)] },
        { item: "LED lighting and controls", statuses: [status(0, "included", null, 2), status(1, "included", null, 3), status(2, "included", null, 1)] },
        { item: "EV charging rough-in", statuses: [status(0, "included", null, 2), status(1, "not_mentioned"), status(2, "not_mentioned")] },
      ],
    },
    {
      name: "Plumbing",
      items: [{ item: "Restroom expansion", statuses: [status(0, "included", null, 2), status(1, "included", null, 3), status(2, "included", null, 1)] }],
    },
    {
      name: "Fire Protection",
      items: [{ item: "Sprinkler design, existing building", statuses: [status(0, "included", null, 2), status(1, "included", null, 3), status(2, "excluded", "By others", 3)] }],
    },
    {
      name: "Commissioning",
      items: [
        { item: "Building commissioning", statuses: [status(0, "excluded", null, 5), status(1, "included", null, 4), status(2, "excluded", null, 3)] },
        { item: "Energy model", statuses: [status(0, "optional", "$9,000", 4), status(1, "excluded", null, 6), status(2, "not_mentioned")] },
      ],
    },
  ],
};

// ---------- World view, past pursuits, consultants ----------

const worldView: WorldView = {
  id: "worldview",
  savedAt: now - 20 * DAY,
  whoWeAre:
    "Demo Architects is a 25-person studio focused on civic, library and higher-education work. We're strongest at renovations of occupied buildings and at community engagement.",
  goodPursuit: "Public clients, $3M–$20M construction, renovation or additions, where qualifications count for more than fee.",
  redFlags: "Fee counts for more than 40% of the RFP's scoring. Design-build led by a contractor we haven't worked with. No construction budget given.",
  weighing: "Favor projects within two hours' drive. Libraries and schools over offices.",
  marketConditions: "Construction costs are rising about 4% a year; mechanical equipment lead times are 20–30 weeks.",
  feeCurve: [
    { budget: 1_000_000, percent: 11 },
    { budget: 5_000_000, percent: 8.5 },
    { budget: 10_000_000, percent: 7.5 },
    { budget: 25_000_000, percent: 6.5 },
    { budget: 50_000_000, percent: 6 },
  ],
  phaseShares: DEFAULT_PHASES,
  proposalSections: DEFAULT_SECTIONS,
};

const pursuits: Pursuit[] = [
  {
    id: "demo-pursuit-1",
    savedAt: now - 120 * DAY,
    outcome: "won",
    ourProposal: "Led with a phasing plan that kept the branch open; brought our library planner to the interview.",
    debrief: "Committee said phasing and community engagement set us apart. Fee was second lowest.",
    budget: 5_400_000,
    ourFee: 470_000,
  },
  {
    id: "demo-pursuit-2",
    savedAt: now - 260 * DAY,
    outcome: "lost",
    ourProposal: "Emphasized sustainability; fee at 9%.",
    debrief: "Lost to a firm with more K-12 experience. Fee was 15% above the winner.",
    budget: 12_000_000,
    ourFee: 1_080_000,
  },
];

const consultant = (id: string, name: string, disciplines: string[], location: string, notes = ""): SavedConsultant => ({
  id,
  savedAt: now - 40 * DAY,
  name,
  disciplines,
  location,
  notes,
  source: "manual",
});

const consultants: SavedConsultant[] = [
  consultant("demo-c-1", "Copperleaf Engineering", ["Mechanical", "Electrical", "Plumbing", "Fire Protection"], "Riverton", "Good on libraries; responsive in CA."),
  consultant("demo-c-2", "Halvorsen Lake Engineers", ["Mechanical", "Electrical", "Plumbing", "Fire Protection"], "Lakeport"),
  consultant("demo-c-3", "Twin Spruce MEP", ["Mechanical", "Electrical", "Plumbing"], "Fairview"),
  consultant("demo-c-4", "Granite Ridge Structural", ["Structural"], "Riverton", "Did our last two additions."),
  consultant("demo-c-5", "Bluestem Civil + Landscape", ["Civil", "Landscape"], "Millbrook"),
  consultant("demo-c-6", "Northfield Geotechnical", ["Geotechnical"], "Fairview"),
  consultant("demo-c-7", "Clearview Environmental", ["Hazardous Materials"], "Lakeport"),
  consultant("demo-c-8", "Ledger Cost Consulting", ["Cost Estimating"], "Riverton"),
];

// ---------- Project, schedule, fee ----------

const project: SavedProject = {
  id: PROJECT_ID,
  savedAt: now - 2 * DAY,
  name: PROJECT_NAME,
  number: "2611",
  rfpId: RFP_ID,
  consultants: [
    { name: "Granite Ridge Structural", disciplines: ["Structural"], statuses: { Structural: "teaming" } },
    { name: "Bluestem Civil + Landscape", disciplines: ["Civil", "Landscape"], statuses: { Civil: "teaming", Landscape: "asked" } },
    { name: "Northfield Geotechnical", disciplines: ["Geotechnical"], statuses: { Geotechnical: "candidate" } },
    { name: "Clearview Environmental", disciplines: ["Hazardous Materials"], statuses: { "Hazardous Materials": "asked" } },
  ],
  // A sample proposal check, so the demo shows what one looks like (the demo can't run AI).
  qaqc: {
    fileName: "Maple Hollow Library - Proposal DRAFT.pdf",
    checkedAt: now - DAY / 2,
    summary: "Close to ready. Two things must be fixed before it goes out: a missing required form and a fee total that doesn't add up.",
    flags: [
      { kind: "brief", severity: "fix", issue: "The RFP requires a signed Non-Collusion Affidavit (Form B), and it isn't included.", page: 0, fix: "Add the signed Form B behind the cover letter." },
      { kind: "mistake", severity: "fix", issue: "The fee table's phases add up to $664,270, but the total reads “$670,270”.", page: 18, fix: "Correct the total or the phase that's off by $6,000." },
      { kind: "mistake", severity: "check", issue: "The cover letter is addressed to “Township of Maple Grove”; the rest of the proposal says Maple Hollow.", page: 1, fix: "Change it to Township of Maple Hollow." },
      { kind: "brief", severity: "check", issue: "The RFP limits the response to 20 pages excluding resumes; this one runs 22.", page: 0, fix: "Trim two pages or move project sheets to an appendix." },
      { kind: "mistake", severity: "check", issue: "“Schematic Desgin” in the schedule heading.", page: 15, fix: "Spell it “Schematic Design”." },
    ],
    costUsd: null,
  },
};

/**
 * The sample schedule starts after the sample RFP's proposals are due, so it never looks already under way:
 * January 1, 2027, or the first of the month after the due date once that's later.
 */
function scheduleStart(): Date {
  const afterDue = new Date(due.getFullYear(), due.getMonth() + 1, 1); // the first of the next month
  const jan2027 = new Date(2027, 0, 1);
  return afterDue > jan2027 ? afterDue : jan2027;
}

function schedule(): SavedSchedule {
  const s = createMediumTemplate(scheduleStart()) as Record<string, unknown>;
  return { ...s, id: "demo-schedule-library", title: PROJECT_NAME, number: "2611", workspaceProjectId: PROJECT_ID, savedAt: now - DAY, createdAt: now - 3 * DAY };
}

function fee(): SavedFee {
  const medium = TEMPLATES.find((t) => t.key === "medium")!;
  const phases = templatePhases(medium, DEFAULT_PHASES);
  // Consultant fees by phase name. Copperleaf's match its proposal in the comparison ($225,000).
  const byName = (amounts: Record<string, number>) =>
    Object.fromEntries(phases.filter((p) => amounts[p.name] != null).map((p) => [p.id, amounts[p.name]]));
  return {
    id: "demo-fee-library",
    savedAt: now - DAY,
    title: PROJECT_NAME,
    workspaceProjectId: PROJECT_ID,
    template: medium.key,
    budget: { by: "amount", amount: 7_800_000, area: 24_500, costPerSf: null },
    targetPercent: 8,
    roles: DEFAULT_ROLES.map((r) => ({ ...r })),
    phases,
    consultants: [
      {
        id: "demo-fc-1",
        discipline: "Mechanical",
        firm: "Copperleaf Engineering",
        byPhase: byName({ "Schematic Design": 38_000, "Design Development": 52_000, "Construction Documents": 86_000, Bidding: 8_000, "Construction Administration": 41_000 }),
      },
      {
        id: "demo-fc-2",
        discipline: "Structural",
        firm: "Granite Ridge Structural",
        byPhase: byName({ "Schematic Design": 9_000, "Design Development": 14_000, "Construction Documents": 22_000, Bidding: 2_000, "Construction Administration": 11_000 }),
      },
      {
        id: "demo-fc-3",
        discipline: "Civil",
        firm: "Bluestem Civil + Landscape",
        byPhase: byName({ "Schematic Design": 8_000, "Design Development": 11_000, "Construction Documents": 18_000, Bidding: 1_500, "Construction Administration": 6_500 }),
      },
    ],
    markupPercent: 10,
    expenses: 12_000,
    durationMonths: 30,
  };
}

// ---------- Open Calls sources: public agencies around Cleveland, OH (real sites, for the demo) ----------

const callSources: CallSource[] = [
  { id: "demo-src-1", code: "CLE", name: "City of Cleveland", scope: "City departments' RFPs and RFQs for professional services, posted on the city's procurement portal.", url: "https://procurement.opengov.com/portal/clevelandoh" },
  { id: "demo-src-2", code: "CCPW", name: "Cuyahoga County Public Works", scope: "County buildings, roads and bridges. Open and upcoming bids, including design-build.", url: "https://www.cuyahogacounty.gov/publicworks/work-with-us/open-and-upcoming-bids" },
  { id: "demo-src-3", code: "CMSD", name: "Cleveland Metropolitan School District", scope: "School renovations, new construction and architect/engineer qualifications.", url: "https://www.clevelandmetroschools.org" },
  { id: "demo-src-4", code: "CSU", name: "Cleveland State University", scope: "Campus bids and proposals from the university's purchasing office.", url: "https://csuohio.edu/purchasing/bids-proposals" },
  { id: "demo-src-5", code: "TRI-C", name: "Cuyahoga Community College", scope: "Tri-C procurement: how the college buys, and its open solicitations.", url: "https://www.tri-c.edu/administrative-departments/procurement/how-we-buy.html" },
  { id: "demo-src-6", code: "METROPARKS", name: "Cleveland Metroparks", scope: "Park district bids and proposals: facilities, trails, the zoo and the lakefront.", url: "https://www.clevelandmetroparks.com/about/cleveland-metroparks-organization/finance-reports/purchasing-bid-information/bidding-procedures" },
  { id: "demo-src-7", code: "OFCC", name: "Ohio Facilities Construction Commission", scope: "State of Ohio. Architect/engineer and construction manager RFQs for state and university projects.", url: "https://ofcc.ohio.gov" },
];

// ---------- Schedule colors and font: the demo firm's own look (not any real firm's) ----------

const scheduleStyle = {
  id: "schedule-style",
  savedAt: now - 30 * DAY,
  colors: {
    // Every color different, so each kind of task and badge reads on its own.
    design: "#E26D5C", // Vibrant Coral
    review: "#C9CBA3", // Dry Sage
    hold: "#7A9E9F", // Muted Teal
    construction: "#723D46", // Wine Plum
    permit: "#FFE1A8", // Soft Peach
    other: "#472D30", // Mauve Shadow
    deliverable: "#C8963E", // Ochre
    milestone: "#5C5F38", // Deep Olive
    estimate: "#5E6B8A", // Slate Blue
    approval: "#B5838D", // Dusty Rose
  },
  font: "inter",
  showToday: true,
  // The notes every new schedule starts with (no firm named).
  notes: ["Dates assume timely owner reviews and approvals.", "Construction dates are estimates; the contractor's schedule governs."].join("\n"),
};

// ---------- Everything, by table ----------

export function demoSeed() {
  const savedRfp: SavedRfp = {
    id: RFP_ID,
    savedAt: now - 4 * DAY,
    files: ["Maple Hollow Library RFP.pdf", "Walkthrough sign-in and minutes.pdf"],
    rfp,
    project: PROJECT_NAME,
    projectId: PROJECT_ID,
    costUsd: null,
    // A document added after the RFP, as the project page lists it.
    addenda: [
      {
        number: 1,
        kind: "meeting",
        title: "Walkthrough minutes",
        files: ["Walkthrough sign-in and minutes.pdf"],
        at: now - DAY,
        changes: [
          { section: "Critical components", change: "Clarified: the children's wing must stay open until the addition is finished, so it's the last phase.", page: 2 },
          { section: "Key facts", change: "Clarified: the Township will provide the 1968 drawings to shortlisted firms only.", page: 3 },
        ],
        costUsd: null,
      },
    ],
  };
  const comparison: SavedComparison = {
    id: CMP_ID,
    savedAt: now - DAY,
    projectName: PROJECT_NAME,
    projectId: PROJECT_ID,
    proposals,
    cmp,
    // The MEP/FP section of the project's Consultants page (the proposals it compared, by file name).
    group: { key: "MEP/FP", label: "MEP/FP", signature: proposals.map((x) => x.source_file ?? "").sort(), v: 2 },
    messages: [
      { role: "user", text: "Which firm is the best value once fire protection is included?" },
      {
        role: "assistant",
        text: "Copperleaf. Twin Spruce's $175,000 leaves out fire protection; a sprinkler design for an 18,000 SF building typically adds $12,000–$18,000, and they'd still have half the site visits. Halvorsen Lake is $27,000 below Copperleaf and includes commissioning, but you'd need their phase split before you could compare phase by phase.",
      },
    ],
  };
  return {
    rfps: [savedRfp],
    comparisons: [comparison],
    readings: [],
    projects: [project],
    consultants,
    schedules: [schedule()],
    fees: [fee()],
    settings: [worldView, { id: "open-calls", savedAt: now - 10 * DAY, sources: callSources }, scheduleStyle],
    pursuits,
  };
}
