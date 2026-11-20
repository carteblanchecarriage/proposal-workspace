// Types for the schedule style (palette.js), for the TypeScript side of the app (the project page's schedule snapshot).
import type { Readable, Writable } from "svelte/store";

type Colors = Record<string, string>;
type Options = { font: string; showToday: boolean };
type Choice = { key: string; label: string; hint: string; base: string; half?: string; standard?: string };

export const CATEGORIES: Choice[];
export const BADGES: Choice[];
export const STANDARD_COLORS: Colors;
export function look(key: string, palette: Colors | undefined): string | undefined;
export const FONTS: { key: string; label: string; stack: string; google?: string }[];
export const DEFAULT_OPTIONS: Options;
export function cleanPalette(value: unknown): Colors;
export function cleanOptions(value: unknown): Options;
export const palette: Writable<Colors>;
export const options: Writable<Options>;
export function buildColorMap(colors: Colors | undefined): Map<string, string>;
export const colorMap: Readable<Map<string, string>>;
export function paint(hex: unknown, map: Map<string, string>): unknown;
export function badge(kind: string, hex: unknown, palette: Colors, map: Map<string, string>): unknown;
export function fontStack(key: string | undefined): string;
export function applyFont(font: string | undefined): void;
export function loadFont(font: string | undefined): void;
export function handOver(palette: Colors, options: Options): void;
