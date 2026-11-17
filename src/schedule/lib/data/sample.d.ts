// Types for the schedule maker's starter projects (sample.js), for the TypeScript side of the app (the demo data).
type ScheduleProject = Record<string, unknown>;
export function createSampleProject(): ScheduleProject;
export function createBlankProject(): ScheduleProject;
export function createSmallTemplate(): ScheduleProject;
export function createMediumTemplate(start?: Date): ScheduleProject;
export function createLargeTemplate(): ScheduleProject;
