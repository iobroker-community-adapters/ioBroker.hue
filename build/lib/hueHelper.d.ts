/**
 * Author of helper functions:
 * https://github.com/ArndBrugman/
 *
 */
/**
 * Convert RGB value to XYB format
 *
 * @param Red R-value
 * @param Green G-value
 * @param Blue B-value
 * @param model - Modelname of the Light to Gamutcorrect Px, Py for
 */
export declare function RgbToXYB(Red: number, Green: number, Blue: number, model: string): {
    x: number;
    y: number;
    b: number;
};
/**
 * @param Red - Range [0..1]
 * @param Green - Range [0..1]
 * @param Blue - Range [0..1]
 * @returns Ranges [0..1] [0..1]
 */
export declare function HelperRGBtoXY(Red: number, Green: number, Blue: number): {
    x: number;
    y: number;
};
/**
 * Tests if the Px,Py resides within the Gamut for the model.
 * Otherwise, it will calculate the closest point on the Gamut.
 * @param Px - Range [0..1]
 * @param Py - Range [0..1]
 * @param Model - Modelname of the Light to Gamutcorrect Px, Py for
 * @returns Ranges [0..1] [0..1]
 */
export declare function GamutXYforModel(Px: number, Py: number, Model: string): {
    x: number;
    y: number;
} | void;
/**
 * @param Red - Range [0..1]
 * @param Green - Range [0..1]
 * @param Blue - Range [0..1]
 * @returns [Ang, Sat, Bri] - Ranges [0..360] [0..1] [0..1]
 */
export declare function HelperRGBtoHueAngSatBri(Red: number, Green: number, Blue: number): {
    Ang: number;
    Sat: number;
    Bri: number;
};
/**
 * Converts XYB values to RGB
 *
 * @param x
 * @param y
 * @param Brightness Optional
 * @returns [Red, Green, Blue] - Ranges [0..1] [0..1] [0..1]
 */
export declare function XYBtoRGB(x: number, y: number, Brightness?: number): {
    Red: number;
    Green: number;
    Blue: number;
};
