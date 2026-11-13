/**
 * Color conversion helpers.
 *
 * The RGB <-> xy conversion follows the Philips Hue application design notes
 * (Wide RGB D65 conversion with sRGB gamma correction).
 */
import type { Gamut, XY } from './hue/types';

/** RGB color, each channel 0..255 */
export interface RGB {
    /** Red */
    r: number;
    /** Green */
    g: number;
    /** Blue */
    b: number;
}

/** Fallback if the bridge does not report a gamut: the full CIE triangle */
const FULL_GAMUT: Gamut = {
    red: { x: 1, y: 0 },
    green: { x: 0, y: 1 },
    blue: { x: 0, y: 0 },
};

/**
 * Round to 4 decimals, which is the resolution the bridge works with
 *
 * @param value value to round
 */
function round4(value: number): number {
    return Math.round(value * 10_000) / 10_000;
}

/**
 * Convert RGB (0..255) to a CIE xy color point
 *
 * @param rgb rgb color
 */
export function rgbToXy(rgb: RGB): XY | undefined {
    const gamma = (v: number): number => {
        const c = Math.min(255, Math.max(0, v)) / 255;
        return c > 0.04045 ? ((c + 0.055) / 1.055) ** 2.4 : c / 12.92;
    };

    const r = gamma(rgb.r);
    const g = gamma(rgb.g);
    const b = gamma(rgb.b);

    const X = r * 0.664511 + g * 0.154324 + b * 0.162028;
    const Y = r * 0.283881 + g * 0.668433 + b * 0.047685;
    const Z = r * 0.000088 + g * 0.07231 + b * 0.986039;
    const sum = X + Y + Z;

    if (sum === 0) {
        // black has no chromaticity
        return undefined;
    }

    return { x: round4(X / sum), y: round4(Y / sum) };
}

/**
 * Convert a CIE xy color point to RGB (0..255) at full brightness
 *
 * @param xy color point
 */
export function xyToRgb(xy: XY): RGB {
    if (xy.y <= 0) {
        return { r: 0, g: 0, b: 0 };
    }

    const Y = 1;
    const X = (Y / xy.y) * xy.x;
    const Z = (Y / xy.y) * (1 - xy.x - xy.y);

    let r = X * 1.656492 - Y * 0.354851 - Z * 0.255038;
    let g = -X * 0.707196 + Y * 1.655397 + Z * 0.036152;
    let b = X * 0.051713 - Y * 0.121364 + Z * 1.01153;

    // clip negatives (out of sRGB) and normalize to the brightest channel
    r = Math.max(0, r);
    g = Math.max(0, g);
    b = Math.max(0, b);
    const max = Math.max(r, g, b);
    if (max > 0) {
        r /= max;
        g /= max;
        b /= max;
    }

    const reverseGamma = (v: number): number => (v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055);

    return {
        r: Math.round(Math.min(1, reverseGamma(r)) * 255),
        g: Math.round(Math.min(1, reverseGamma(g)) * 255),
        b: Math.round(Math.min(1, reverseGamma(b)) * 255),
    };
}

/**
 * Get the closest point to `p` on the line segment from `a` to `b`
 *
 * @param p point
 * @param a segment start
 * @param b segment end
 */
function closestPointOnSegment(p: XY, a: XY, b: XY): XY {
    const ab = { x: b.x - a.x, y: b.y - a.y };
    const t = Math.min(1, Math.max(0, ((p.x - a.x) * ab.x + (p.y - a.y) * ab.y) / (ab.x * ab.x + ab.y * ab.y)));
    return { x: a.x + t * ab.x, y: a.y + t * ab.y };
}

/**
 * Cross product sign of (b - a) x (p - a)
 *
 * @param p point
 * @param a first point of the edge
 * @param b second point of the edge
 */
function cross(p: XY, a: XY, b: XY): number {
    return (b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x);
}

/**
 * Move a color point into the gamut of a light if it is outside
 *
 * @param xy requested color point
 * @param gamut gamut of the light
 */
export function clampToGamut(xy: XY, gamut: Gamut = FULL_GAMUT): XY {
    const { red, green, blue } = gamut;
    const d1 = cross(xy, red, green);
    const d2 = cross(xy, green, blue);
    const d3 = cross(xy, blue, red);
    const hasNeg = d1 < 0 || d2 < 0 || d3 < 0;
    const hasPos = d1 > 0 || d2 > 0 || d3 > 0;

    if (!(hasNeg && hasPos)) {
        return xy;
    }

    const candidates = [
        closestPointOnSegment(xy, red, green),
        closestPointOnSegment(xy, green, blue),
        closestPointOnSegment(xy, blue, red),
    ];

    let best = candidates[0];
    let bestDistance = Infinity;
    for (const candidate of candidates) {
        const distance = (candidate.x - xy.x) ** 2 + (candidate.y - xy.y) ** 2;
        if (distance < bestDistance) {
            bestDistance = distance;
            best = candidate;
        }
    }

    return { x: round4(best.x), y: round4(best.y) };
}

/**
 * Parse a hex color like `#FF8800` or `ff8800`
 *
 * @param value the hex string
 */
export function parseHexColor(value: unknown): RGB | undefined {
    if (typeof value !== 'string') {
        return undefined;
    }

    const match = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(value.trim());
    if (!match) {
        return undefined;
    }

    return { r: parseInt(match[1], 16), g: parseInt(match[2], 16), b: parseInt(match[3], 16) };
}

/**
 * Format an RGB color as `#RRGGBB`
 *
 * @param rgb the color
 */
export function formatHexColor(rgb: RGB): string {
    return `#${[rgb.r, rgb.g, rgb.b].map(v => v.toString(16).padStart(2, '0')).join('')}`.toUpperCase();
}

/**
 * Parse a color point given as `"x,y"`, `[x, y]` or `{ x, y }`
 *
 * @param value the value to parse
 */
export function parseXy(value: unknown): XY | undefined {
    let x: unknown;
    let y: unknown;

    if (typeof value === 'string') {
        [x, y] = value.split(',').map(v => parseFloat(v));
    } else if (Array.isArray(value)) {
        [x, y] = value;
    } else if (value && typeof value === 'object') {
        ({ x, y } = value as Record<string, unknown>);
    }

    if (typeof x !== 'number' || typeof y !== 'number' || !isFinite(x) || !isFinite(y)) {
        return undefined;
    }

    if (x < 0 || x > 1 || y < 0 || y > 1) {
        return undefined;
    }

    return { x, y };
}

/**
 * Format a color point as `"x,y"`
 *
 * @param xy the color point
 */
export function formatXy(xy: XY): string {
    return `${round4(xy.x)},${round4(xy.y)}`;
}

/**
 * Convert mirek (micro reciprocal degree) to Kelvin
 *
 * @param mirek value in mirek
 */
export function mirekToKelvin(mirek: number): number {
    return Math.round(1_000_000 / mirek);
}

/**
 * Convert Kelvin to mirek
 *
 * @param kelvin value in Kelvin
 */
export function kelvinToMirek(kelvin: number): number {
    return Math.round(1_000_000 / kelvin);
}

/**
 * Convert the light level reported by the bridge (10000 * log10(lux) + 1) to lux
 *
 * @param lightLevel value reported by the bridge
 */
export function lightLevelToLux(lightLevel: number): number {
    return Math.round(10 ** ((lightLevel - 1) / 10_000));
}
